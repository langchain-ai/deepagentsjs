/**
 * FilesystemBackend: Read and write files directly from the filesystem.
 *
 * Security and search upgrades:
 * - Secure path resolution with root containment when in virtual_mode (sandboxed to cwd)
 * - Prevent symlink-following on file I/O using O_NOFOLLOW when available
 * - Ripgrep-powered grep with literal (fixed-string) search, plus substring fallback
 *   and optional glob include filtering, while preserving virtual path behavior
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import fg from "fast-glob";
import micromatch from "micromatch";
import type {
  BackendProtocol,
  EditResult,
  FileData,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
  GrepMatch,
  WriteResult,
} from "./protocol.js";
import {
  checkEmptyContent,
  formatContentWithLineNumbers,
  performStringReplacement,
} from "./utils.js";

const SUPPORTS_NOFOLLOW = fsSync.constants.O_NOFOLLOW !== undefined;

/**
 * Backend that reads and writes files directly from the filesystem.
 *
 * Files are accessed using their actual filesystem paths. Relative paths are
 * resolved relative to the current working directory. Content is read/written
 * as plain text, and metadata (timestamps) are derived from filesystem stats.
 */
export class FilesystemBackend implements BackendProtocol {
  private cwd: string;
  private virtualMode: boolean;
  private maxFileSizeBytes: number;

  constructor(
    options: {
      rootDir?: string;
      virtualMode?: boolean;
      maxFileSizeMb?: number;
    } = {},
  ) {
    const { rootDir, virtualMode = false, maxFileSizeMb = 10 } = options;
    this.cwd = rootDir ? path.resolve(rootDir) : process.cwd();
    this.virtualMode = virtualMode;
    this.maxFileSizeBytes = maxFileSizeMb * 1024 * 1024;
  }

  /**
   * Resolve a file path with security checks.
   *
   * When virtualMode=true, treat incoming paths as virtual absolute paths under
   * this.cwd, disallow traversal (.., ~) and ensure resolved path stays within root.
   * When virtualMode=false, preserve legacy behavior: absolute paths are allowed
   * as-is; relative paths resolve under cwd.
   *
   * @param key - File path (absolute, relative, or virtual when virtualMode=true)
   * @returns Resolved absolute path string
   * @throws Error if path traversal detected or path outside root
   */
  private resolvePath(key: string): string {
    if (this.virtualMode) {
      const vpath = key.startsWith("/") ? key : "/" + key;
      if (vpath.includes("..") || vpath.startsWith("~")) {
        throw new Error("Path traversal not allowed");
      }
      const full = path.resolve(this.cwd, vpath.substring(1));
      const relative = path.relative(this.cwd, full);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Path: ${full} outside root directory: ${this.cwd}`);
      }
      return full;
    }

    if (path.isAbsolute(key)) {
      return key;
    }
    return path.resolve(this.cwd, key);
  }

  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * @param dirPath - Absolute directory path to list files from
   * @returns List of FileInfo objects for files and directories directly in the directory.
   *          Directories have a trailing / in their path and is_dir=true.
   */
  async lsInfo(dirPath: string): Promise<FileInfo[]> {
    try {
      const resolvedPath = this.resolvePath(dirPath);
      const stat = await fs.stat(resolvedPath);

      if (!stat.isDirectory()) {
        return [];
      }

      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
      const results: FileInfo[] = [];

      const cwdStr = this.cwd.endsWith(path.sep)
        ? this.cwd
        : this.cwd + path.sep;

      for (const entry of entries) {
        const fullPath = path.join(resolvedPath, entry.name);

        try {
          const entryStat = await fs.stat(fullPath);
          const isFile = entryStat.isFile();
          const isDir = entryStat.isDirectory();

          if (!this.virtualMode) {
            // Non-virtual mode: use absolute paths
            if (isFile) {
              results.push({
                path: fullPath,
                is_dir: false,
                size: entryStat.size,
                modified_at: entryStat.mtime.toISOString(),
              });
            } else if (isDir) {
              results.push({
                path: fullPath + path.sep,
                is_dir: true,
                size: 0,
                modified_at: entryStat.mtime.toISOString(),
              });
            }
          } else {
            let relativePath: string;
            if (fullPath.startsWith(cwdStr)) {
              relativePath = fullPath.substring(cwdStr.length);
            } else if (fullPath.startsWith(this.cwd)) {
              relativePath = fullPath
                .substring(this.cwd.length)
                .replace(/^[/\\]/, "");
            } else {
              relativePath = fullPath;
            }

            relativePath = relativePath.split(path.sep).join("/");
            const virtPath = "/" + relativePath;

            if (isFile) {
              results.push({
                path: virtPath,
                is_dir: false,
                size: entryStat.size,
                modified_at: entryStat.mtime.toISOString(),
              });
            } else if (isDir) {
              results.push({
                path: virtPath + "/",
                is_dir: true,
                size: 0,
                modified_at: entryStat.mtime.toISOString(),
              });
            }
          }
        } catch {
          // Skip entries we can't stat
          continue;
        }
      }

      results.sort((a, b) => a.path.localeCompare(b.path));
      return results;
    } catch {
      return [];
    }
  }

  /**
   * Read file content with line numbers.
   *
   * @param filePath - Absolute or relative file path
   * @param offset - Line offset to start reading from (0-indexed)
   * @param limit - Maximum number of lines to read
   * @returns Formatted file content with line numbers, or error message
   */
  async read(
    filePath: string,
    offset: number = 0,
    limit: number = 500,
  ): Promise<string> {
    try {
      const resolvedPath = this.resolvePath(filePath);

      let content: string;

      if (SUPPORTS_NOFOLLOW) {
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          return `Error: File '${filePath}' not found`;
        }
        const fd = await fs.open(
          resolvedPath,
          fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW,
        );
        try {
          content = await fd.readFile({ encoding: "utf-8" });
        } finally {
          await fd.close();
        }
      } else {
        const stat = await fs.lstat(resolvedPath);
        if (stat.isSymbolicLink()) {
          return `Error: Symlinks are not allowed: ${filePath}`;
        }
        if (!stat.isFile()) {
          return `Error: File '${filePath}' not found`;
        }
        content = await fs.readFile(resolvedPath, "utf-8");
      }

      const emptyMsg = checkEmptyContent(content);
      if (emptyMsg) {
        return emptyMsg;
      }

      const lines = content.split("\n");
      const startIdx = offset;
      const endIdx = Math.min(startIdx + limit, lines.length);

      if (startIdx >= lines.length) {
        return `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`;
      }

      const selectedLines = lines.slice(startIdx, endIdx);
      return formatContentWithLineNumbers(selectedLines, startIdx + 1);
    } catch (e: any) {
      return `Error reading file '${filePath}': ${e.message}`;
    }
  }

  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns Raw file content as FileData
   */
  async readRaw(filePath: string): Promise<FileData> {
    const resolvedPath = this.resolvePath(filePath);

    let content: string;
    let stat: fsSync.Stats;

    if (SUPPORTS_NOFOLLOW) {
      stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) throw new Error(`File '${filePath}' not found`);
      const fd = await fs.open(
        resolvedPath,
        fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW,
      );
      try {
        content = await fd.readFile({ encoding: "utf-8" });
      } finally {
        await fd.close();
      }
    } else {
      stat = await fs.lstat(resolvedPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed: ${filePath}`);
      }
      if (!stat.isFile()) throw new Error(`File '${filePath}' not found`);
      content = await fs.readFile(resolvedPath, "utf-8");
    }

    return {
      content: content.split("\n"),
      created_at: stat.ctime.toISOString(),
      modified_at: stat.mtime.toISOString(),
    };
  }

  /**
   * Create a new file with content.
   * Returns WriteResult. External storage sets filesUpdate=null.
   */
  async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      const resolvedPath = this.resolvePath(filePath);

      try {
        const stat = await fs.lstat(resolvedPath);
        if (stat.isSymbolicLink()) {
          return {
            error: `Cannot write to ${filePath} because it is a symlink. Symlinks are not allowed.`,
          };
        }
        return {
          error: `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.`,
        };
      } catch {
        // File doesn't exist, good to proceed
      }

      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

      if (SUPPORTS_NOFOLLOW) {
        const flags =
          fsSync.constants.O_WRONLY |
          fsSync.constants.O_CREAT |
          fsSync.constants.O_TRUNC |
          fsSync.constants.O_NOFOLLOW;

        const fd = await fs.open(resolvedPath, flags, 0o644);
        try {
          await fd.writeFile(content, "utf-8");
        } finally {
          await fd.close();
        }
      } else {
        await fs.writeFile(resolvedPath, content, "utf-8");
      }

      return { path: filePath, filesUpdate: null };
    } catch (e: any) {
      return { error: `Error writing file '${filePath}': ${e.message}` };
    }
  }

  /**
   * Edit a file by replacing string occurrences.
   * Returns EditResult. External storage sets filesUpdate=null.
   */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): Promise<EditResult> {
    try {
      const resolvedPath = this.resolvePath(filePath);

      let content: string;

      if (SUPPORTS_NOFOLLOW) {
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          return { error: `Error: File '${filePath}' not found` };
        }

        const fd = await fs.open(
          resolvedPath,
          fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW,
        );
        try {
          content = await fd.readFile({ encoding: "utf-8" });
        } finally {
          await fd.close();
        }
      } else {
        const stat = await fs.lstat(resolvedPath);
        if (stat.isSymbolicLink()) {
          return { error: `Error: Symlinks are not allowed: ${filePath}` };
        }
        if (!stat.isFile()) {
          return { error: `Error: File '${filePath}' not found` };
        }
        content = await fs.readFile(resolvedPath, "utf-8");
      }

      const result = performStringReplacement(
        content,
        oldString,
        newString,
        replaceAll,
      );

      if (typeof result === "string") {
        return { error: result };
      }

      const [newContent, occurrences] = result;

      // Write securely
      if (SUPPORTS_NOFOLLOW) {
        const flags =
          fsSync.constants.O_WRONLY |
          fsSync.constants.O_TRUNC |
          fsSync.constants.O_NOFOLLOW;

        const fd = await fs.open(resolvedPath, flags);
        try {
          await fd.writeFile(newContent, "utf-8");
        } finally {
          await fd.close();
        }
      } else {
        await fs.writeFile(resolvedPath, newContent, "utf-8");
      }

      return { path: filePath, filesUpdate: null, occurrences: occurrences };
    } catch (e: any) {
      return { error: `Error editing file '${filePath}': ${e.message}` };
    }
  }

  /**
   * Search for a literal text pattern in files.
   *
   * Uses ripgrep if available, falling back to substring search.
   *
   * @param pattern - Literal string to search for (NOT regex).
   * @param dirPath - Directory or file path to search in. Defaults to current directory.
   * @param glob - Optional glob pattern to filter which files to search.
   * @returns List of GrepMatch dicts containing path, line number, and matched text.
   */
  async grepRaw(
    pattern: string,
    dirPath: string = "/",
    glob: string | null = null,
  ): Promise<GrepMatch[] | string> {
    // Resolve base path
    let baseFull: string;
    try {
      baseFull = this.resolvePath(dirPath || ".");
    } catch {
      return [];
    }

    try {
      await fs.stat(baseFull);
    } catch {
      return [];
    }

    // Try ripgrep first (with -F flag for literal search), fallback to substring search
    let results = await this.ripgrepSearch(pattern, baseFull, glob);
    if (results === null) {
      results = await this.literalSearch(pattern, baseFull, glob);
    }

    const matches: GrepMatch[] = [];
    for (const [fpath, items] of Object.entries(results)) {
      for (const [lineNum, lineText] of items) {
        matches.push({ path: fpath, line: lineNum, text: lineText });
      }
    }
    return matches;
  }

  /**
   * Search using ripgrep with fixed-string (literal) mode.
   *
   * @param pattern - Literal string to search for (unescaped).
   * @param baseFull - Resolved base path to search in.
   * @param includeGlob - Optional glob pattern to filter files.
   * @returns Dict mapping file paths to list of (line_number, line_text) tuples.
   *          Returns null if ripgrep is unavailable or times out.
   */
  private async ripgrepSearch(
    pattern: string,
    baseFull: string,
    includeGlob: string | null,
  ): Promise<Record<string, Array<[number, string]>> | null> {
    return new Promise((resolve) => {
      // -F enables fixed-string (literal) mode
      const args = ["--json", "-F"];
      if (includeGlob) {
        args.push("--glob", includeGlob);
      }
      args.push("--", pattern, baseFull);

      const proc = spawn("rg", args, { timeout: 30000 });
      const results: Record<string, Array<[number, string]>> = {};
      let output = "";

      proc.stdout.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0 && code !== 1) {
          // Error (code 1 means no matches, which is ok)
          resolve(null);
          return;
        }

        for (const line of output.split("\n")) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.type !== "match") continue;

            const pdata = data.data || {};
            const ftext = pdata.path?.text;
            if (!ftext) continue;

            let virtPath: string;
            if (this.virtualMode) {
              try {
                const resolved = path.resolve(ftext);
                const relative = path.relative(this.cwd, resolved);
                if (relative.startsWith("..")) continue;
                const normalizedRelative = relative.split(path.sep).join("/");
                virtPath = "/" + normalizedRelative;
              } catch {
                continue;
              }
            } else {
              virtPath = ftext;
            }

            const ln = pdata.line_number;
            const lt = pdata.lines?.text?.replace(/\n$/, "") || "";
            if (ln === undefined) continue;

            if (!results[virtPath]) {
              results[virtPath] = [];
            }
            results[virtPath].push([ln, lt]);
          } catch {
            // Skip invalid JSON
            continue;
          }
        }

        resolve(results);
      });

      proc.on("error", () => {
        resolve(null);
      });
    });
  }

  /**
   * Fallback search using literal substring matching when ripgrep is unavailable.
   *
   * Recursively searches files, respecting maxFileSizeBytes limit.
   *
   * @param pattern - Literal string to search for.
   * @param baseFull - Resolved base path to search in.
   * @param includeGlob - Optional glob pattern to filter files by name.
   * @returns Dict mapping file paths to list of (line_number, line_text) tuples.
   */
  private async literalSearch(
    pattern: string,
    baseFull: string,
    includeGlob: string | null,
  ): Promise<Record<string, Array<[number, string]>>> {
    const results: Record<string, Array<[number, string]>> = {};
    const stat = await fs.stat(baseFull);
    const root = stat.isDirectory() ? baseFull : path.dirname(baseFull);

    // Use fast-glob to recursively find all files
    const files = await fg("**/*", {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      dot: true,
    });

    for (const fp of files) {
      try {
        // Filter by glob if provided
        if (
          includeGlob &&
          !micromatch.isMatch(path.basename(fp), includeGlob)
        ) {
          continue;
        }

        // Check file size
        const stat = await fs.stat(fp);
        if (stat.size > this.maxFileSizeBytes) {
          continue;
        }

        // Read and search using literal substring matching
        const content = await fs.readFile(fp, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Simple substring search for literal matching
          if (line.includes(pattern)) {
            let virtPath: string;
            if (this.virtualMode) {
              try {
                const relative = path.relative(this.cwd, fp);
                if (relative.startsWith("..")) continue;
                const normalizedRelative = relative.split(path.sep).join("/");
                virtPath = "/" + normalizedRelative;
              } catch {
                continue;
              }
            } else {
              virtPath = fp;
            }

            if (!results[virtPath]) {
              results[virtPath] = [];
            }
            results[virtPath].push([i + 1, line]);
          }
        }
      } catch {
        // Skip files we can't read
        continue;
      }
    }

    return results;
  }

  /**
   * Structured glob matching returning FileInfo objects.
   */
  async globInfo(
    pattern: string,
    searchPath: string = "/",
  ): Promise<FileInfo[]> {
    if (pattern.startsWith("/")) {
      pattern = pattern.substring(1);
    }

    const resolvedSearchPath =
      searchPath === "/" ? this.cwd : this.resolvePath(searchPath);

    try {
      const stat = await fs.stat(resolvedSearchPath);
      if (!stat.isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }

    const results: FileInfo[] = [];

    try {
      // Use fast-glob for pattern matching
      const matches = await fg(pattern, {
        cwd: resolvedSearchPath,
        absolute: true,
        onlyFiles: true,
        dot: true,
      });

      for (const matchedPath of matches) {
        try {
          const stat = await fs.stat(matchedPath);
          if (!stat.isFile()) continue;

          // Normalize fast-glob paths to platform separators
          // fast-glob returns forward slashes on all platforms, but we need
          // platform-native separators for path comparisons on Windows
          const normalizedPath = matchedPath.split("/").join(path.sep);

          if (!this.virtualMode) {
            results.push({
              path: normalizedPath,
              is_dir: false,
              size: stat.size,
              modified_at: stat.mtime.toISOString(),
            });
          } else {
            const cwdStr = this.cwd.endsWith(path.sep)
              ? this.cwd
              : this.cwd + path.sep;
            let relativePath: string;

            if (normalizedPath.startsWith(cwdStr)) {
              relativePath = normalizedPath.substring(cwdStr.length);
            } else if (normalizedPath.startsWith(this.cwd)) {
              relativePath = normalizedPath
                .substring(this.cwd.length)
                .replace(/^[/\\]/, "");
            } else {
              relativePath = normalizedPath;
            }

            relativePath = relativePath.split(path.sep).join("/");
            const virt = "/" + relativePath;
            results.push({
              path: virt,
              is_dir: false,
              size: stat.size,
              modified_at: stat.mtime.toISOString(),
            });
          }
        } catch {
          // Skip files we can't stat
          continue;
        }
      }
    } catch {
      // Ignore glob errors
    }

    results.sort((a, b) => a.path.localeCompare(b.path));
    return results;
  }

  /**
   * Upload multiple files to the filesystem.
   *
   * @param files - List of [path, content] tuples to upload
   * @returns List of FileUploadResponse objects, one per input file
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const responses: FileUploadResponse[] = [];

    for (const [filePath, content] of files) {
      try {
        const resolvedPath = this.resolvePath(filePath);

        // Ensure parent directory exists
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

        // Write file
        await fs.writeFile(resolvedPath, content);
        responses.push({ path: filePath, error: null });
      } catch (e: any) {
        if (e.code === "ENOENT") {
          responses.push({ path: filePath, error: "file_not_found" });
        } else if (e.code === "EACCES") {
          responses.push({ path: filePath, error: "permission_denied" });
        } else if (e.code === "EISDIR") {
          responses.push({ path: filePath, error: "is_directory" });
        } else {
          responses.push({ path: filePath, error: "invalid_path" });
        }
      }
    }

    return responses;
  }

  /**
   * Download multiple files from the filesystem.
   *
   * @param paths - List of file paths to download
   * @returns List of FileDownloadResponse objects, one per input path
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const responses: FileDownloadResponse[] = [];

    for (const filePath of paths) {
      try {
        const resolvedPath = this.resolvePath(filePath);
        const content = await fs.readFile(resolvedPath);
        responses.push({ path: filePath, content, error: null });
      } catch (e: any) {
        if (e.code === "ENOENT") {
          responses.push({
            path: filePath,
            content: null,
            error: "file_not_found",
          });
        } else if (e.code === "EACCES") {
          responses.push({
            path: filePath,
            content: null,
            error: "permission_denied",
          });
        } else if (e.code === "EISDIR") {
          responses.push({
            path: filePath,
            content: null,
            error: "is_directory",
          });
        } else {
          responses.push({
            path: filePath,
            content: null,
            error: "invalid_path",
          });
        }
      }
    }

    return responses;
  }
}
