/**
 * BaseSandbox: Abstract base class for sandbox backends with command execution.
 *
 * This class provides default implementations for all SandboxBackendProtocol
 * methods using shell commands executed via execute(). Concrete implementations
 * only need to implement the execute() method.
 *
 * Requires Node.js 20+ on the sandbox host.
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
 * Node.js command template for glob operations.
 * Uses web-standard atob() for base64 decoding.
 */
function buildGlobCommand(searchPath: string, pattern: string): string {
  const pathB64 = btoa(searchPath);
  const patternB64 = btoa(pattern);

  return `node -e "
const fs = require('fs');
const path = require('path');

const searchPath = atob('${pathB64}');
const pattern = atob('${patternB64}');

function globMatch(relativePath, pattern) {
  const regexPattern = pattern
    .replace(/\\*\\*/g, '<<<GLOBSTAR>>>')
    .replace(/\\*/g, '[^/]*')
    .replace(/\\?/g, '.')
    .replace(/<<<GLOBSTAR>>>/g, '.*');
  return new RegExp('^' + regexPattern + '$').test(relativePath);
}

function walkDir(dir, baseDir, results) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);
      if (entry.isDirectory()) {
        walkDir(fullPath, baseDir, results);
      } else if (globMatch(relativePath, pattern)) {
        const stat = fs.statSync(fullPath);
        console.log(JSON.stringify({
          path: relativePath,
          size: stat.size,
          mtime: stat.mtimeMs,
          isDir: false
        }));
      }
    }
  } catch (e) {
    // Silent failure for non-existent paths
  }
}

try {
  process.chdir(searchPath);
  walkDir('.', '.', []);
} catch (e) {
  // Silent failure for non-existent paths
}
"`;
}

/**
 * Node.js command template for listing directory contents.
 */
function buildLsCommand(dirPath: string): string {
  const pathB64 = btoa(dirPath);

  return `node -e "
const fs = require('fs');
const path = require('path');

const dirPath = atob('${pathB64}');

try {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const stat = fs.statSync(fullPath);
    console.log(JSON.stringify({
      path: entry.isDirectory() ? fullPath + '/' : fullPath,
      size: stat.size,
      mtime: stat.mtimeMs,
      isDir: entry.isDirectory()
    }));
  }
} catch (e) {
  console.error('Error: ' + e.message);
  process.exit(1);
}
"`;
}

/**
 * Node.js command template for reading files.
 */
function buildReadCommand(
  filePath: string,
  offset: number,
  limit: number,
): string {
  const pathB64 = btoa(filePath);
  // Coerce offset and limit to safe non-negative integers before embedding in the shell command.
  const safeOffset =
    Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const safeLimit =
    Number.isFinite(limit) && limit > 0 && limit < Number.MAX_SAFE_INTEGER
      ? Math.floor(limit)
      : 0;

  return `node -e "
const fs = require('fs');

const filePath = atob('${pathB64}');
const offset = ${safeOffset};
const limit = ${safeLimit};

if (!fs.existsSync(filePath)) {
  console.log('Error: File not found');
  process.exit(1);
}

const stat = fs.statSync(filePath);
if (stat.size === 0) {
  console.log('System reminder: File exists but has empty contents');
  process.exit(0);
}

const content = fs.readFileSync(filePath, 'utf-8');
const lines = content.split('\\n');
const selected = lines.slice(offset, offset + limit);

for (let i = 0; i < selected.length; i++) {
  const lineNum = offset + i + 1;
  console.log(String(lineNum).padStart(6) + '\\t' + selected[i]);
}
"`;
}

/**
 * Node.js command template for writing files.
 */
function buildWriteCommand(filePath: string, content: string): string {
  const pathB64 = btoa(filePath);
  const contentB64 = btoa(content);

  return `node -e "
const fs = require('fs');
const path = require('path');

const filePath = atob('${pathB64}');
const content = atob('${contentB64}');

if (fs.existsSync(filePath)) {
  console.error('Error: File already exists');
  process.exit(1);
}

const parentDir = path.dirname(filePath) || '.';
fs.mkdirSync(parentDir, { recursive: true });

fs.writeFileSync(filePath, content, 'utf-8');
console.log('OK');
"`;
}

/**
 * Node.js command template for editing files.
 */
function buildEditCommand(
  filePath: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): string {
  const pathB64 = btoa(filePath);
  const oldB64 = btoa(oldStr);
  const newB64 = btoa(newStr);

  return `node -e "
const fs = require('fs');

const filePath = atob('${pathB64}');
const oldStr = atob('${oldB64}');
const newStr = atob('${newB64}');
const replaceAll = ${Boolean(replaceAll)};

let text;
try {
  text = fs.readFileSync(filePath, 'utf-8');
} catch (e) {
  process.exit(3);
}

const count = text.split(oldStr).length - 1;

if (count === 0) {
  process.exit(1);
}
if (count > 1 && !replaceAll) {
  process.exit(2);
}

const result = text.split(oldStr).join(newStr);
fs.writeFileSync(filePath, result, 'utf-8');
console.log(count);
"`;
}

/**
 * Node.js command template for grep operations with literal (fixed-string) search.
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
  const patternB64 = btoa(pattern);
  const pathB64 = btoa(searchPath);
  const globB64 = globPattern ? btoa(globPattern) : "";

  return `node -e "
const fs = require('fs');
const path = require('path');

const pattern = atob('${patternB64}');
const searchPath = atob('${pathB64}');
const globPattern = ${globPattern ? `atob('${globB64}')` : "null"};

function globMatch(filePath, pattern) {
  if (!pattern) return true;
  const regexPattern = pattern
    .replace(/\\*\\*/g, '<<<GLOBSTAR>>>')
    .replace(/\\*/g, '[^/]*')
    .replace(/\\?/g, '.')
    .replace(/<<<GLOBSTAR>>>/g, '.*');
  return new RegExp('^' + regexPattern + '$').test(filePath);
}

function walkDir(dir, results) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, results);
      } else {
        const relativePath = path.relative(searchPath, fullPath);
        if (globMatch(relativePath, globPattern)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const lines = content.split('\\n');
            for (let i = 0; i < lines.length; i++) {
              // Simple substring search for literal matching
              if (lines[i].includes(pattern)) {
                console.log(JSON.stringify({
                  path: fullPath,
                  line: i + 1,
                  text: lines[i]
                }));
              }
            }
          } catch (e) {
            // Skip unreadable files
          }
        }
      }
    }
  } catch (e) {
    // Skip unreadable directories
  }
}

try {
  walkDir(searchPath, []);
} catch (e) {
  // Silent failure
}
"`;
}

/**
 * Base sandbox implementation with execute() as the only abstract method.
 *
 * This class provides default implementations for all SandboxBackendProtocol
 * methods using shell commands executed via execute(). Concrete implementations
 * only need to implement the execute() method.
 *
 * Requires Node.js 20+ on the sandbox host.
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
   * @param path - Absolute path to directory
   * @returns List of FileInfo objects for files and directories directly in the directory.
   */
  async lsInfo(path: string): Promise<FileInfo[]> {
    const command = buildLsCommand(path);
    const result = await this.execute(command);

    if (result.exitCode !== 0) {
      return [];
    }

    const infos: FileInfo[] = [];
    const lines = result.output.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        infos.push({
          path: parsed.path,
          is_dir: parsed.isDir,
          size: parsed.size,
          modified_at: parsed.mtime
            ? new Date(parsed.mtime).toISOString()
            : undefined,
        });
      } catch {
        // Skip invalid JSON lines
      }
    }

    return infos;
  }

  /**
   * Read file content with line numbers.
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
   * @param filePath - Absolute file path
   * @returns Raw file content as FileData
   */
  async readRaw(filePath: string): Promise<FileData> {
    const command = buildReadCommand(filePath, 0, Number.MAX_SAFE_INTEGER);
    const result = await this.execute(command);

    if (result.exitCode !== 0) {
      throw new Error(`File '${filePath}' not found`);
    }

    // Parse the line-numbered output back to content
    const lines: string[] = [];
    for (const line of result.output.split("\n")) {
      // Format is "    123\tContent"
      const tabIndex = line.indexOf("\t");
      if (tabIndex !== -1) {
        lines.push(line.substring(tabIndex + 1));
      }
    }

    const now = new Date().toISOString();
    return {
      content: lines,
      created_at: now,
      modified_at: now,
    };
  }

  /**
   * Search for a literal text pattern in files.
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

    const matches: GrepMatch[] = [];
    const lines = result.output.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        matches.push({
          path: parsed.path,
          line: parsed.line,
          text: parsed.text,
        });
      } catch {
        // Skip invalid JSON lines
      }
    }

    return matches;
  }

  /**
   * Structured glob matching returning FileInfo objects.
   */
  async globInfo(pattern: string, path: string = "/"): Promise<FileInfo[]> {
    const command = buildGlobCommand(path, pattern);
    const result = await this.execute(command);

    const infos: FileInfo[] = [];
    const lines = result.output.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        infos.push({
          path: parsed.path,
          is_dir: parsed.isDir,
          size: parsed.size,
          modified_at: parsed.mtime
            ? new Date(parsed.mtime).toISOString()
            : undefined,
        });
      } catch {
        // Skip invalid JSON lines
      }
    }

    return infos;
  }

  /**
   * Create a new file with content.
   */
  async write(filePath: string, content: string): Promise<WriteResult> {
    const command = buildWriteCommand(filePath, content);
    const result = await this.execute(command);

    if (result.exitCode !== 0) {
      return {
        error: `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.`,
      };
    }

    return { path: filePath, filesUpdate: null };
  }

  /**
   * Edit a file by replacing string occurrences.
   */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): Promise<EditResult> {
    const command = buildEditCommand(
      filePath,
      oldString,
      newString,
      replaceAll,
    );
    const result = await this.execute(command);

    switch (result.exitCode) {
      case 0: {
        const occurrences = parseInt(result.output.trim(), 10) || 1;
        return { path: filePath, filesUpdate: null, occurrences };
      }
      case 1:
        return { error: `String not found in file '${filePath}'` };
      case 2:
        return {
          error: `Multiple occurrences found in '${filePath}'. Use replaceAll=true to replace all.`,
        };
      case 3:
        return { error: `Error: File '${filePath}' not found` };
      default:
        return { error: `Unknown error editing file '${filePath}'` };
    }
  }
}
