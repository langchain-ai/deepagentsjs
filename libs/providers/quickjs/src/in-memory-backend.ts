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

const SKILL_FILE_EXTENSIONS = new Set([
  ".ts",
  ".js",
  ".mts",
  ".mjs",
  ".cts",
  ".cjs",
  ".tsx",
  ".jsx",
  ".md",
]);

const TEST_SUFFIXES = [".test.", ".spec."];

const READ_ONLY_ERROR = "InMemoryBackend is read-only";

/**
 * Check whether a filename should be included when loading a skill module.
 */
function isSkillFile(filename: string): boolean {
  const ext = path.extname(filename);

  if (!SKILL_FILE_EXTENSIONS.has(ext)) {
    return false;
  }

  if (TEST_SUFFIXES.some((s) => filename.includes(s))) {
    return false;
  }

  return true;
}

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
 * Load all eligible files from a single skill subdirectory into the map.
 */
function loadSkillSubdirectory(
  files: Map<string, string>,
  subdirPath: string,
  subdirName: string,
): void {
  for (const entry of fs.readdirSync(subdirPath)) {
    if (!isSkillFile(entry)) {
      continue;
    }

    const fullPath = path.join(subdirPath, entry);

    if (!fs.statSync(fullPath).isFile()) {
      continue;
    }

    const virtualPath = `/${subdirName}/${entry}`;
    files.set(virtualPath, fs.readFileSync(fullPath, "utf-8"));
  }
}

/**
 * Scan a skills directory, loading each subdirectory as a skill module.
 *
 * Each immediate subdirectory is treated as one skill. Files within are
 * filtered by extension and test-suffix rules via `isSkillFile`.
 */
function loadSkillsDirectory(skillsDir: string): Map<string, string> {
  const resolved = path.resolve(skillsDir);
  const files = new Map<string, string>();

  for (const subdir of fs.readdirSync(resolved)) {
    const subdirPath = path.join(resolved, subdir);

    if (!fs.statSync(subdirPath).isDirectory()) {
      continue;
    }

    loadSkillSubdirectory(files, subdirPath, subdir);
  }

  return files;
}

/**
 * Read-only, in-memory backend for loading skill modules into the code
 * interpreter.
 *
 * Files are read from a directory into memory at construction time. Each
 * subdirectory is treated as a skill module and served under `/<name>/`
 * prefixes so the skills middleware can discover them via `ls("/")`.
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

  constructor(skillsDir: string) {
    this.files = loadSkillsDirectory(skillsDir);
  }

  /**
   * Create an InMemoryBackend from a directory on disk.
   */
  static fromDirectory(skillsDir: string): InMemoryBackend {
    return new InMemoryBackend(skillsDir);
  }

  /**
   * List files and subdirectories under `dirPath`.
   *
   * At the root (`/`), each skill module appears as a directory entry.
   * Inside a skill directory, individual files are listed.
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
   * Download files as binary content. Used by CompositeBackend when the
   * skills middleware loads SKILL.md files.
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
