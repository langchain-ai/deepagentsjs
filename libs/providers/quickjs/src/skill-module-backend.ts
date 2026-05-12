import fs from "node:fs";
import path from "node:path";
import type {
  BackendProtocolV2,
  EditResult,
  FileInfo,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "deepagents";

/**
 * File extensions included when loading a skill module directory.
 */
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

/**
 * Test file suffixes excluded when loading a skill module directory.
 */
const TEST_SUFFIXES = [".test.", ".spec."];

/**
 * Read-only backend that serves skill module files from a directory on disk.
 *
 * Reads all matching files at construction time and holds them in memory.
 * Implements the subset of BackendProtocolV2 needed for CompositeBackend
 * routing — ls, read, readRaw, grep, glob. Write operations return errors.
 */
export class SkillModuleBackend implements BackendProtocolV2 {
  private files: Map<string, string>;

  /**
   * @param dir - Path to the skill module directory on disk.
   */
  constructor(dir: string) {
    this.files = loadDirectory(dir);
  }

  ls(dirPath: string): LsResult {
    const norm = dirPath === "" || dirPath === "." ? "/" : dirPath;
    const prefix = norm === "/" ? "/" : norm.replace(/\/$/, "") + "/";

    const entries: FileInfo[] = [];
    const dirs = new Set<string>();

    for (const filePath of this.files.keys()) {
      if (norm === "/") {
        const rest = filePath.slice(1);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          entries.push({ path: filePath, is_dir: false });
        } else {
          const dir = "/" + rest.slice(0, slash + 1);
          if (!dirs.has(dir)) {
            dirs.add(dir);
            entries.push({ path: dir, is_dir: true });
          }
        }
      } else if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          entries.push({ path: filePath, is_dir: false });
        } else {
          const dir = prefix + rest.slice(0, slash + 1);
          if (!dirs.has(dir)) {
            dirs.add(dir);
            entries.push({ path: dir, is_dir: true });
          }
        }
      }
    }
    return { files: entries };
  }

  read(filePath: string): ReadResult {
    const content = this.resolve(filePath);
    if (content == null) {
      return { error: `File not found: ${filePath}` };
    }
    return { content, mimeType: "text/plain" };
  }

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

  grep(
    pattern: string,
    searchPath?: string | null,
    globPattern?: string | null,
  ): GrepResult {
    const matches: GrepMatch[] = [];
    for (const [filePath, content] of this.files) {
      if (searchPath && !filePath.startsWith(searchPath)) continue;
      if (globPattern && !matchGlob(filePath, globPattern)) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(pattern)) {
          matches.push({ path: filePath, line: i + 1, text: lines[i] });
        }
      }
    }
    return { matches };
  }

  glob(pattern: string, basePath?: string): GlobResult {
    const files: FileInfo[] = [];
    for (const filePath of this.files.keys()) {
      if (basePath && !filePath.startsWith(basePath)) continue;
      const matchPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
      if (matchGlob(matchPath, pattern)) {
        files.push({ path: filePath, is_dir: false });
      }
    }
    return { files };
  }

  write(): WriteResult {
    return { error: "Skill module backend is read-only" };
  }

  edit(): EditResult {
    return { error: "Skill module backend is read-only" };
  }

  private resolve(filePath: string): string | undefined {
    return this.files.get(filePath) ?? this.files.get("/" + filePath);
  }
}

/**
 * Read all skill files from a directory into a map keyed by virtual path.
 */
function loadDirectory(dir: string): Map<string, string> {
  const resolved = path.resolve(dir);
  const files = new Map<string, string>();

  for (const entry of fs.readdirSync(resolved)) {
    const ext = path.extname(entry);
    if (!SKILL_FILE_EXTENSIONS.has(ext)) continue;
    if (TEST_SUFFIXES.some((s) => entry.includes(s))) continue;

    const fullPath = path.join(resolved, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    files.set("/" + entry, fs.readFileSync(fullPath, "utf-8"));
  }

  return files;
}

/**
 * Minimal glob matching for the in-memory file set.
 * Supports `*` (any non-slash) and `**` (any path segment).
 */
function matchGlob(filePath: string, pattern: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp("^" + re + "$").test(filePath);
}
