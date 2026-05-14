import fs from "node:fs";
import path from "node:path";
import type {
  BackendProtocolV2,
  EditResult,
  FileDownloadResponse,
  FileInfo,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "deepagents";

const READ_ONLY_ERROR = "InMemoryBackend is read-only";

/**
 * Convert a glob pattern to a compiled RegExp.
 *
 * Supports `*` (any non-slash characters) and `**` (any path segments).
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");

  return new RegExp("^" + escaped + "$");
}

/**
 * Normalize a directory path into a prefix for startsWith matching.
 *
 * Empty string and `"."` are treated as root. The result always ends
 * with exactly one `/`.
 */
function normalizeDirPrefix(dirPath: string): string {
  if (dirPath === "" || dirPath === "." || dirPath === "/") {
    return "/";
  }

  return dirPath.replace(/\/$/, "") + "/";
}

/**
 * Strip the leading slash from a virtual path, if present.
 */
function stripLeadingSlash(filePath: string): string {
  if (filePath.startsWith("/")) {
    return filePath.slice(1);
  }

  return filePath;
}

/**
 * Check whether a resolved path is safely contained within a base directory.
 */
function isSafePath(targetPath: string, baseDir: string): boolean {
  try {
    const resolvedPath = fs.realpathSync(targetPath);
    return (
      resolvedPath.startsWith(baseDir + path.sep) || resolvedPath === baseDir
    );
  } catch {
    return false;
  }
}

/**
 * Recursively read all files from a directory into a map of virtual paths
 * to file contents. The root directory is stripped from paths so a file at
 * `<root>/foo/bar.ts` becomes `/foo/bar.ts`.
 *
 * Symlinks are skipped and a containment check ensures no entry resolves
 * outside the root directory.
 */
function readDirectory(
  rootDir: string,
  currentDir: string,
  files: Map<string, string>,
): void {
  for (const entry of fs.readdirSync(currentDir)) {
    const fullPath = path.join(currentDir, entry);
    const lstat = fs.lstatSync(fullPath);

    if (lstat.isSymbolicLink()) {
      continue;
    }

    if (!isSafePath(fullPath, rootDir)) {
      continue;
    }

    if (lstat.isDirectory()) {
      readDirectory(rootDir, fullPath, files);
    } else if (lstat.isFile()) {
      const relativePath = path.relative(rootDir, fullPath);
      const virtualPath = "/" + relativePath.split(path.sep).join("/");
      files.set(virtualPath, fs.readFileSync(fullPath, "utf-8"));
    }
  }
}

/**
 * Read-only, in-memory backend that loads all files from a directory at init
 * time.
 *
 * All files are read eagerly into memory so there is no filesystem dependency
 * at runtime. This is the recommended way to serve skill modules to the code
 * interpreter, but the backend itself is generic and not tied to any specific
 * use case.
 *
 * This backend does not support writes. It cannot be used as a top-level
 * backend because features like ContextOffloading require write support.
 * Mount it on a CompositeBackend under a read-only route (e.g. `/skills/`).
 *
 * @example
 * ```typescript
 * const skillsBackend = InMemoryBackend.fromDirectory("./skills");
 * const backend = new CompositeBackend(primaryBackend, {
 *   "/skills/": skillsBackend,
 * });
 * ```
 */
export class InMemoryBackend implements BackendProtocolV2 {
  private files: Map<string, string>;

  /**
   * Create an InMemoryBackend from a pre-built map of virtual paths to file
   * contents.
   */
  constructor(files: Map<string, string>) {
    this.files = files;
  }

  /**
   * Create an InMemoryBackend by reading all files from a directory on disk.
   */
  static fromDirectory(dir: string): InMemoryBackend {
    const resolved = fs.realpathSync(path.resolve(dir));
    const files = new Map<string, string>();
    readDirectory(resolved, resolved, files);
    return new InMemoryBackend(files);
  }

  /**
   * List files and subdirectories under `dirPath`.
   */
  ls(dirPath: string): LsResult {
    const prefix = normalizeDirPrefix(dirPath);
    const entries: FileInfo[] = [];
    const seenDirs = new Set<string>();

    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }

      const rest = filePath.slice(prefix.length);
      const slashIdx = rest.indexOf("/");

      if (slashIdx === -1) {
        entries.push({ path: filePath, is_dir: false });
        continue;
      }

      const dir = prefix + rest.slice(0, slashIdx + 1);

      if (seenDirs.has(dir)) {
        continue;
      }

      seenDirs.add(dir);
      entries.push({ path: dir, is_dir: true });
    }

    return { files: entries };
  }

  /**
   * Read a file's text content by virtual path.
   */
  read(filePath: string): ReadResult {
    const content = this.resolve(filePath);

    if (content == null) {
      return { error: `File not found: ${filePath}` };
    }

    return { content, mimeType: "text/plain" };
  }

  /**
   * Read a file with metadata (timestamps, mime type).
   */
  readRaw(filePath: string): ReadRawResult {
    const content = this.resolve(filePath);

    if (content == null) {
      return { error: `File not found: ${filePath}` };
    }

    const now = new Date().toISOString();

    return {
      data: {
        content,
        mimeType: "text/plain",
        created_at: now,
        modified_at: now,
      },
    };
  }

  /**
   * Search file contents for a literal string pattern.
   */
  grep(
    pattern: string,
    searchPath?: string | null,
    globPattern?: string | null,
  ): GrepResult {
    const matches: GrepMatch[] = [];
    const globRe = globPattern ? globToRegExp(globPattern) : null;

    for (const [filePath, content] of this.files) {
      if (searchPath && !filePath.startsWith(searchPath)) {
        continue;
      }

      if (globRe && !globRe.test(filePath)) {
        continue;
      }

      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(pattern)) {
          matches.push({
            path: filePath,
            line: i + 1,
            text: lines[i],
          });
        }
      }
    }

    return { matches };
  }

  /**
   * Find files matching a glob pattern (supports `*` and `**`).
   */
  glob(pattern: string, basePath?: string): GlobResult {
    const re = globToRegExp(pattern);
    const matched: FileInfo[] = [];

    for (const filePath of this.files.keys()) {
      if (basePath && !filePath.startsWith(basePath)) {
        continue;
      }

      if (re.test(stripLeadingSlash(filePath))) {
        matched.push({ path: filePath, is_dir: false });
      }
    }

    return { files: matched };
  }

  /**
   * Download files as binary content.
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const encoder = new TextEncoder();

    return paths.map((p) => {
      const content = this.resolve(p);

      if (content == null) {
        return { path: p, content: null, error: "file_not_found" as const };
      }

      return {
        path: p,
        content: encoder.encode(content),
        error: null,
      };
    });
  }

  /**
   * Reject writes — this backend is read-only.
   */
  write(): WriteResult {
    return { error: READ_ONLY_ERROR };
  }

  /**
   * Reject edits — this backend is read-only.
   */
  edit(): EditResult {
    return { error: READ_ONLY_ERROR };
  }

  /**
   * Resolve a virtual path to file content, with or without a leading slash.
   */
  private resolve(filePath: string): string | undefined {
    return this.files.get(filePath) ?? this.files.get("/" + filePath);
  }
}
