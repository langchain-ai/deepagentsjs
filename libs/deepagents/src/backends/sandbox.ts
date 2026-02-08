/**
 * BaseSandbox: Abstract base class for sandbox backends with command execution.
 *
 * This class provides default implementations for all SandboxBackendProtocol
 * methods. Concrete implementations only need to implement execute(),
 * uploadFiles(), and downloadFiles().
 *
 * Runtime requirements on the sandbox host:
 * - read, grep: Pure POSIX shell (awk, grep) — works on any Linux including Alpine
 * - write, edit, readRaw: No runtime needed — uses uploadFiles/downloadFiles directly
 * - ls, glob: Pure POSIX shell (find, stat) — works on any Linux including Alpine
 *
 * No Python, Node.js, or other runtime required.
 */

import type {
  EditResult,
  ExecuteResponse,
  FileData,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
  GrepMatch,
  MaybePromise,
  SandboxBackendProtocol,
  WriteResult,
} from "./protocol.js";

/**
 * Shell-quote a string using single quotes (POSIX).
 * Escapes embedded single quotes with the '\'' technique.
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Convert a glob pattern to a path-aware RegExp.
 *
 * Inspired by the just-bash project's glob utilities:
 * - `*`  matches any characters except `/`
 * - `**` matches any characters including `/` (recursive)
 * - `?`  matches a single character except `/`
 * - `[...]` character classes
 */
function globToPathRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === "*") {
      if (i + 1 < pattern.length && pattern[i + 1] === "*") {
        // ** (globstar) matches everything including /
        i += 2;
        if (i < pattern.length && pattern[i] === "/") {
          // **/ matches zero or more directory segments
          regex += "(.*/)?";
          i++;
        } else {
          // ** at end matches anything
          regex += ".*";
        }
      } else {
        // * matches anything except /
        regex += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (c === "[") {
      // Character class — find closing bracket
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== "]") j++;
      regex += pattern.slice(i, j + 1);
      i = j + 1;
    } else if (
      c === "." ||
      c === "+" ||
      c === "^" ||
      c === "$" ||
      c === "{" ||
      c === "}" ||
      c === "(" ||
      c === ")" ||
      c === "|" ||
      c === "\\"
    ) {
      regex += `\\${c}`;
      i++;
    } else {
      regex += c;
      i++;
    }
  }

  regex += "$";
  return new RegExp(regex);
}

/**
 * Parse a single line of stat/find output in the format: size\tmtime\ttype\tpath
 *
 * The first three tab-delimited fields are always fixed (number, number, string),
 * so we safely take everything after the third tab as the file path — even if the
 * path itself contains tabs.
 *
 * The type field varies by platform / tool:
 * - GNU find -printf %y: single letter "d", "f", "l"
 * - BSD stat -f %Sp: permission strings like "drwxr-xr-x", "-rw-r--r--"
 *
 * The mtime field may be a float (GNU find %T@ → "1234567890.0000000000")
 * or an integer (BSD stat %m → "1234567890"); parseInt handles both.
 */
function parseStatLine(
  line: string,
): { size: number; mtime: number; isDir: boolean; fullPath: string } | null {
  const firstTab = line.indexOf("\t");
  if (firstTab === -1) return null;

  const secondTab = line.indexOf("\t", firstTab + 1);
  if (secondTab === -1) return null;

  const thirdTab = line.indexOf("\t", secondTab + 1);
  if (thirdTab === -1) return null;

  const size = parseInt(line.slice(0, firstTab), 10);
  const mtime = parseInt(line.slice(firstTab + 1, secondTab), 10);
  const fileType = line.slice(secondTab + 1, thirdTab);
  const fullPath = line.slice(thirdTab + 1);

  if (isNaN(size) || isNaN(mtime)) return null;

  return {
    size,
    mtime,
    // GNU find %y outputs "d"; BSD stat %Sp outputs "drwxr-xr-x"
    isDir:
      fileType === "d" || fileType === "directory" || fileType.startsWith("d"),
    fullPath,
  };
}

/**
 * BusyBox/Alpine fallback script for stat -c.
 *
 * Determines file type with POSIX test builtins, then uses stat -c
 * (supported by both GNU coreutils and BusyBox) for size and mtime.
 * printf handles tab-delimited output formatting.
 */
const STAT_C_SCRIPT =
  "for f; do " +
  'if [ -d "$f" ]; then t=d; elif [ -L "$f" ]; then t=l; else t=f; fi; ' +
  'sz=$(stat -c %s "$f" 2>/dev/null) || continue; ' +
  'mt=$(stat -c %Y "$f" 2>/dev/null) || continue; ' +
  'printf "%s\\t%s\\t%s\\t%s\\n" "$sz" "$mt" "$t" "$f"; ' +
  "done";

/**
 * Shell command for listing directory contents with metadata.
 *
 * Detects the environment at runtime with three-way probing:
 * 1. GNU find (full Linux): uses built-in `-printf` (most efficient)
 * 2. BusyBox / Alpine: uses `find -exec sh -c` with `stat -c` fallback
 * 3. BSD / macOS: uses `find -exec stat -f`
 *
 * Output format per line: size\tmtime\ttype\tpath
 */
function buildLsCommand(dirPath: string): string {
  const quotedPath = shellQuote(dirPath);
  const findBase = `find ${quotedPath} -maxdepth 1 -not -path ${quotedPath}`;
  return (
    `if find /dev/null -maxdepth 0 -printf '' 2>/dev/null; then ` +
    `${findBase} -printf '%s\\t%T@\\t%y\\t%p\\n' 2>/dev/null; ` +
    `elif stat -c %s /dev/null >/dev/null 2>&1; then ` +
    `${findBase} -exec sh -c '${STAT_C_SCRIPT}' _ {} +; ` +
    `else ` +
    `${findBase} -exec stat -f '%z\t%m\t%Sp\t%N' {} + 2>/dev/null; ` +
    `fi || true`
  );
}

/**
 * Shell command for listing files recursively with metadata.
 * Same three-way detection as buildLsCommand (GNU -printf / stat -c / BSD stat -f).
 *
 * Output format per line: size\tmtime\ttype\tpath
 */
function buildFindCommand(searchPath: string): string {
  const quotedPath = shellQuote(searchPath);
  const findBase = `find ${quotedPath} -not -path ${quotedPath}`;
  return (
    `if find /dev/null -maxdepth 0 -printf '' 2>/dev/null; then ` +
    `${findBase} -printf '%s\\t%T@\\t%y\\t%p\\n' 2>/dev/null; ` +
    `elif stat -c %s /dev/null >/dev/null 2>&1; then ` +
    `${findBase} -exec sh -c '${STAT_C_SCRIPT}' _ {} +; ` +
    `else ` +
    `${findBase} -exec stat -f '%z\t%m\t%Sp\t%N' {} + 2>/dev/null; ` +
    `fi || true`
  );
}

/**
 * Pure POSIX shell command for reading files with line numbers.
 * Uses awk for line numbering with offset/limit — works on any Linux including Alpine.
 */
function buildReadCommand(
  filePath: string,
  offset: number,
  limit: number,
): string {
  const quotedPath = shellQuote(filePath);
  // Coerce offset and limit to safe non-negative integers.
  const safeOffset =
    Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const safeLimit =
    Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), 999_999_999)
      : 999_999_999;
  // awk NR is 1-based, our offset is 0-based
  const start = safeOffset + 1;
  const end = safeOffset + safeLimit;

  return [
    `if [ ! -f ${quotedPath} ]; then echo "Error: File not found"; exit 1; fi`,
    `if [ ! -s ${quotedPath} ]; then echo "System reminder: File exists but has empty contents"; exit 0; fi`,
    `awk 'NR >= ${start} && NR <= ${end} { printf "%6d\\t%s\\n", NR, $0 }' ${quotedPath}`,
  ].join("; ");
}

/**
 * Build a grep command for literal (fixed-string) search.
 * Uses grep -rHnF for recursive, with-filename, with-line-number, fixed-string search.
 *
 * When a glob pattern is provided, uses `find -name GLOB -exec grep` instead of
 * `grep --include=GLOB` for universal compatibility (BusyBox grep lacks --include).
 *
 * @param pattern - Literal string to search for (NOT regex).
 * @param searchPath - Base path to search in.
 * @param globPattern - Optional glob pattern to filter files.
 */
function buildGrepCommand(
  pattern: string,
  searchPath: string,
  globPattern: string | null,
): string {
  const patternEscaped = shellQuote(pattern);
  const searchPathQuoted = shellQuote(searchPath);

  if (globPattern) {
    // Use find + grep for BusyBox compatibility (BusyBox grep lacks --include)
    const globEscaped = shellQuote(globPattern);
    return `find ${searchPathQuoted} -type f -name ${globEscaped} -exec grep -HnF -e ${patternEscaped} {} + 2>/dev/null || true`;
  }

  return `grep -rHnF -e ${patternEscaped} ${searchPathQuoted} 2>/dev/null || true`;
}

/**
 * Base sandbox implementation with execute() as the only abstract method.
 *
 * This class provides default implementations for all SandboxBackendProtocol
 * methods using shell commands executed via execute(). Concrete implementations
 * only need to implement execute(), uploadFiles(), and downloadFiles().
 *
 * All shell commands use pure POSIX utilities (awk, grep, find, stat) that are
 * available on any Linux including Alpine/busybox. No Python, Node.js, or
 * other runtime is required on the sandbox host.
 */
export abstract class BaseSandbox implements SandboxBackendProtocol {
  /** Unique identifier for the sandbox backend */
  abstract readonly id: string;

  /**
   * Execute a command in the sandbox.
   * This is the only method concrete implementations must provide.
   */
  abstract execute(command: string): MaybePromise<ExecuteResponse>;

  /**
   * Upload multiple files to the sandbox.
   * Implementations must support partial success.
   */
  abstract uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): MaybePromise<FileUploadResponse[]>;

  /**
   * Download multiple files from the sandbox.
   * Implementations must support partial success.
   */
  abstract downloadFiles(paths: string[]): MaybePromise<FileDownloadResponse[]>;

  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * Uses pure POSIX shell (find + stat) via execute() — works on any Linux
   * including Alpine. No Python or Node.js needed.
   *
   * @param path - Absolute path to directory
   * @returns List of FileInfo objects for files and directories directly in the directory.
   */
  async lsInfo(path: string): Promise<FileInfo[]> {
    const command = buildLsCommand(path);
    const result = await this.execute(command);

    const infos: FileInfo[] = [];
    const lines = result.output.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      const parsed = parseStatLine(line);
      if (!parsed) continue;

      infos.push({
        path: parsed.isDir ? parsed.fullPath + "/" : parsed.fullPath,
        is_dir: parsed.isDir,
        size: parsed.size,
        modified_at: new Date(parsed.mtime * 1000).toISOString(),
      });
    }

    return infos;
  }

  /**
   * Read file content with line numbers.
   *
   * Uses pure POSIX shell (awk) via execute() — only the requested slice
   * is returned over the wire, making this efficient for large files.
   * Works on any Linux including Alpine (no Python or Node.js needed).
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed)
   * @param limit - Maximum number of lines to read
   * @returns Formatted file content with line numbers, or error message
   */
  async read(
    filePath: string,
    offset: number = 0,
    limit: number = 500,
  ): Promise<string> {
    // limit=0 means return nothing
    if (limit === 0) return "";

    const command = buildReadCommand(filePath, offset, limit);
    const result = await this.execute(command);

    if (result.exitCode !== 0) {
      return `Error: File '${filePath}' not found`;
    }

    return result.output;
  }

  /**
   * Read file content as raw FileData.
   *
   * Uses downloadFiles() directly — no runtime needed on the sandbox host.
   *
   * @param filePath - Absolute file path
   * @returns Raw file content as FileData
   */
  async readRaw(filePath: string): Promise<FileData> {
    const results = await this.downloadFiles([filePath]);
    if (results[0].error || !results[0].content) {
      throw new Error(`File '${filePath}' not found`);
    }

    const content = new TextDecoder().decode(results[0].content);
    const lines = content.split("\n");

    const now = new Date().toISOString();
    return {
      content: lines,
      created_at: now,
      modified_at: now,
    };
  }

  /**
   * Search for a literal text pattern in files using grep.
   *
   * @param pattern - Literal string to search for (NOT regex).
   * @param path - Directory or file path to search in.
   * @param glob - Optional glob pattern to filter which files to search.
   * @returns List of GrepMatch dicts containing path, line number, and matched text.
   */
  async grepRaw(
    pattern: string,
    path: string = "/",
    glob: string | null = null,
  ): Promise<GrepMatch[] | string> {
    const command = buildGrepCommand(pattern, path, glob);
    const result = await this.execute(command);

    const output = result.output.trim();
    if (!output) {
      return [];
    }

    // Parse grep output format: path:line_number:text
    const matches: GrepMatch[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split(":");
      if (parts.length >= 3) {
        const lineNum = parseInt(parts[1], 10);
        if (!isNaN(lineNum)) {
          matches.push({
            path: parts[0],
            line: lineNum,
            text: parts.slice(2).join(":"),
          });
        }
      }
    }

    return matches;
  }

  /**
   * Structured glob matching returning FileInfo objects.
   *
   * Uses pure POSIX shell (find + stat) via execute() to list all files,
   * then applies glob-to-regex matching in TypeScript. No Python or Node.js
   * needed on the sandbox host.
   *
   * Glob patterns are matched against paths relative to the search base:
   * - `*`  matches any characters except `/`
   * - `**` matches any characters including `/` (recursive)
   * - `?`  matches a single character except `/`
   * - `[...]` character classes
   */
  async globInfo(pattern: string, path: string = "/"): Promise<FileInfo[]> {
    const command = buildFindCommand(path);
    const result = await this.execute(command);

    const regex = globToPathRegex(pattern);
    const infos: FileInfo[] = [];
    const lines = result.output.trim().split("\n").filter(Boolean);

    // Normalise base path (strip trailing /)
    const basePath = path.endsWith("/") ? path.slice(0, -1) : path;

    for (const line of lines) {
      const parsed = parseStatLine(line);
      if (!parsed) continue;

      // Compute path relative to the search base
      const relPath = parsed.fullPath.startsWith(basePath + "/")
        ? parsed.fullPath.slice(basePath.length + 1)
        : parsed.fullPath;

      if (regex.test(relPath)) {
        infos.push({
          path: relPath,
          is_dir: parsed.isDir,
          size: parsed.size,
          modified_at: new Date(parsed.mtime * 1000).toISOString(),
        });
      }
    }

    return infos;
  }

  /**
   * Create a new file with content.
   *
   * Uses downloadFiles() to check existence and uploadFiles() to write.
   * No runtime needed on the sandbox host.
   */
  async write(filePath: string, content: string): Promise<WriteResult> {
    // Check if file already exists
    try {
      const existCheck = await this.downloadFiles([filePath]);
      if (existCheck[0].content !== null && existCheck[0].error === null) {
        return {
          error: `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.`,
        };
      }
    } catch {
      // File doesn't exist, which is what we want for write
    }

    const encoder = new TextEncoder();
    const results = await this.uploadFiles([
      [filePath, encoder.encode(content)],
    ]);

    if (results[0].error) {
      return {
        error: `Failed to write to ${filePath}: ${results[0].error}`,
      };
    }

    return { path: filePath, filesUpdate: null };
  }

  /**
   * Edit a file by replacing string occurrences.
   *
   * Uses downloadFiles() to read, performs string replacement in TypeScript,
   * then uploadFiles() to write back. No runtime needed on the sandbox host.
   */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): Promise<EditResult> {
    // Read the file
    const results = await this.downloadFiles([filePath]);
    if (results[0].error || !results[0].content) {
      return { error: `Error: File '${filePath}' not found` };
    }

    const text = new TextDecoder().decode(results[0].content);
    const count = text.split(oldString).length - 1;

    if (count === 0) {
      return { error: `String not found in file '${filePath}'` };
    }
    if (count > 1 && !replaceAll) {
      return {
        error: `Multiple occurrences found in '${filePath}'. Use replaceAll=true to replace all.`,
      };
    }

    // Perform replacement
    const newText = replaceAll
      ? text.split(oldString).join(newString)
      : text.replace(oldString, newString);

    // Write back
    const encoder = new TextEncoder();
    const uploadResults = await this.uploadFiles([
      [filePath, encoder.encode(newText)],
    ]);

    if (uploadResults[0].error) {
      return {
        error: `Failed to write edited file '${filePath}': ${uploadResults[0].error}`,
      };
    }

    return { path: filePath, filesUpdate: null, occurrences: count };
  }
}
