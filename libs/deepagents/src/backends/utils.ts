/**
 * Shared utility functions for memory backend implementations.
 *
 * This module contains both user-facing string formatters and structured
 * helpers used by backends and the composite router. Structured helpers
 * enable composition without fragile string parsing.
 */

import micromatch from "micromatch";
import path, { basename } from "path";
import type {
  AnyBackendProtocol,
  AnySandboxProtocol,
  BackendProtocolV1,
  BackendProtocolV2,
  FileData,
  FileDataV1,
  FileDataV2,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  SandboxBackendProtocolV2,
} from "./protocol.js";

// Constants
export const EMPTY_CONTENT_WARNING =
  "System reminder: File exists but has empty contents";
export const MAX_LINE_LENGTH = 5000;
export const LINE_NUMBER_WIDTH = 6;
export const TOOL_RESULT_TOKEN_LIMIT = 20000; // Same threshold as eviction
export const TRUNCATION_GUIDANCE =
  "... [results truncated, try being more specific with your parameters]";

const MIME_TYPES: Record<string, string> = {
  // images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",

  // audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aiff": "audio/aiff",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",

  // video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mpeg": "video/mpeg",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".mpg": "video/mpeg",
  ".wmv": "video/x-ms-wmv",
  ".3gpp": "video/3gpp",

  // documents
  ".pdf": "application/pdf",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Sanitize tool_call_id to prevent path traversal and separator issues.
 *
 * Replaces dangerous characters (., /, \) with underscores.
 */
export function sanitizeToolCallId(toolCallId: string): string {
  return toolCallId.replace(/\./g, "_").replace(/\//g, "_").replace(/\\/g, "_");
}

/**
 * Format file content with line numbers (cat -n style).
 *
 * Chunks lines longer than MAX_LINE_LENGTH with continuation markers (e.g., 5.1, 5.2).
 *
 * @param content - File content as string or list of lines
 * @param startLine - Starting line number (default: 1)
 * @returns Formatted content with line numbers and continuation markers
 */
export function formatContentWithLineNumbers(
  content: string | string[],
  startLine: number = 1,
): string {
  let lines: string[];
  if (typeof content === "string") {
    lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
  } else {
    lines = content;
  }

  const resultLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + startLine;

    if (line.length <= MAX_LINE_LENGTH) {
      resultLines.push(
        `${lineNum.toString().padStart(LINE_NUMBER_WIDTH)}\t${line}`,
      );
    } else {
      // Split long line into chunks with continuation markers
      const numChunks = Math.ceil(line.length / MAX_LINE_LENGTH);
      for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
        const start = chunkIdx * MAX_LINE_LENGTH;
        const end = Math.min(start + MAX_LINE_LENGTH, line.length);
        const chunk = line.substring(start, end);
        if (chunkIdx === 0) {
          // First chunk: use normal line number
          resultLines.push(
            `${lineNum.toString().padStart(LINE_NUMBER_WIDTH)}\t${chunk}`,
          );
        } else {
          // Continuation chunks: use decimal notation (e.g., 5.1, 5.2)
          const continuationMarker = `${lineNum}.${chunkIdx}`;
          resultLines.push(
            `${continuationMarker.padStart(LINE_NUMBER_WIDTH)}\t${chunk}`,
          );
        }
      }
    }
  }

  return resultLines.join("\n");
}

/**
 * Check if content is empty and return warning message.
 *
 * @param content - Content to check
 * @returns Warning message if empty, null otherwise
 */
export function checkEmptyContent(content: string): string | null {
  if (!content || content.trim() === "") {
    return EMPTY_CONTENT_WARNING;
  }
  return null;
}

/**
 * Convert FileData to plain string content.
 *
 * @param fileData - FileData object with 'content' key
 * @returns Content as string with lines joined by newlines
 */
export function fileDataToString(fileData: FileData): string {
  if (Array.isArray(fileData.content)) {
    return fileData.content.join("\n");
  }
  if (typeof fileData.content === "string") {
    return fileData.content;
  }
  throw new Error("Cannot convert binary FileData to string");
}

/**
 * Type guard to check if FileData contains binary content (Uint8Array).
 *
 * @param data - FileData to check
 * @returns True if the content is a Uint8Array (binary)
 */
export function isFileDataBinary(
  data: FileData,
): data is FileDataV2 & { content: Uint8Array } {
  return ArrayBuffer.isView(data.content);
}

/**
 * Create a FileData object.
 *
 * Defaults to v2 format (content as single string). Pass `fileFormat: "v1"` for
 * backward compatibility with older readers during a rolling deployment.
 * Binary content (Uint8Array) is only supported with v2.
 *
 * @param content - File content as a string or binary Uint8Array (v2 only)
 * @param createdAt - Optional creation timestamp (ISO format), defaults to now
 * @param fileFormat - Storage format: "v2" (default) or "v1" (legacy line array)
 * @returns FileData in the requested format
 */
export function createFileData(
  content: string | Uint8Array,
  createdAt?: string,
  fileFormat: "v1" | "v2" = "v2",
  mimeType?: string,
): FileData {
  const now = new Date().toISOString();

  if (fileFormat === "v1" && ArrayBuffer.isView(content)) {
    throw new Error(
      "Binary data is not supported with v1 file formats. Please use v2 file format",
    );
  }

  if (fileFormat === "v2") {
    if (ArrayBuffer.isView(content)) {
      return {
        content: new Uint8Array(
          content.buffer,
          content.byteOffset,
          content.byteLength,
        ),
        mimeType: mimeType ?? "application/octet-stream",
        created_at: createdAt || now,
        modified_at: now,
      } as FileDataV2;
    }
    return {
      content,
      mimeType: mimeType ?? "text/plain",
      created_at: createdAt || now,
      modified_at: now,
    } as FileDataV2;
  }

  const lines = typeof content === "string" ? content.split("\n") : content;
  return {
    content: lines,
    created_at: createdAt || now,
    modified_at: now,
  } as FileDataV1;
}

/**
 * Update FileData with new content, preserving creation timestamp.
 *
 * @param fileData - Existing FileData object
 * @param content - New content as string
 * @returns Updated FileData object
 */
export function updateFileData(fileData: FileData, content: string): FileData {
  const now = new Date().toISOString();

  if (isFileDataV1(fileData)) {
    const lines = typeof content === "string" ? content.split("\n") : content;
    return {
      content: lines,
      created_at: fileData.created_at,
      modified_at: now,
    };
  }

  return {
    content,
    mimeType: fileData.mimeType,
    created_at: fileData.created_at,
    modified_at: now,
  };
}

/**
 * Format file data for read response with line numbers.
 *
 * @param fileData - FileData object
 * @param offset - Line offset (0-indexed)
 * @param limit - Maximum number of lines
 * @returns Formatted content or error message
 */
export function formatReadResponse(
  fileData: FileData,
  offset: number,
  limit: number,
): string {
  if (isFileDataBinary(fileData)) {
    return "Error: Cannot format binary FileData as text";
  }
  const content = fileDataToString(fileData);
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
}

/**
 * Perform string replacement with occurrence validation.
 *
 * @param content - Original content
 * @param oldString - String to replace
 * @param newString - Replacement string
 * @param replaceAll - Whether to replace all occurrences
 * @returns Tuple of [new_content, occurrences] on success, or error message string
 *
 * Special case: When both content and oldString are empty, this sets the initial
 * content to newString. This allows editing empty files by treating empty oldString
 * as "set initial content" rather than "replace nothing".
 */
export function performStringReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): [string, number] | string {
  // Special case: empty file with empty oldString sets initial content
  if (content === "" && oldString === "") {
    return [newString, 0];
  }

  // Validate that oldString is not empty (for non-empty files)
  if (oldString === "") {
    return "Error: oldString cannot be empty when file has content";
  }

  // Use split to count occurrences (simpler than regex)
  const occurrences = content.split(oldString).length - 1;

  if (occurrences === 0) {
    return `Error: String not found in file: '${oldString}'`;
  }

  if (occurrences > 1 && !replaceAll) {
    return `Error: String '${oldString}' has multiple occurrences (appears ${occurrences} times) in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.`;
  }

  // Python's str.replace() replaces ALL occurrences
  // Use split/join for consistent behavior
  const newContent = content.split(oldString).join(newString);

  return [newContent, occurrences];
}

/**
 * Truncate list or string result if it exceeds token limit (rough estimate: 4 chars/token).
 */
export function truncateIfTooLong(
  result: string[] | string,
): string[] | string {
  if (Array.isArray(result)) {
    const totalChars = result.reduce((sum, item) => sum + item.length, 0);
    if (totalChars > TOOL_RESULT_TOKEN_LIMIT * 4) {
      const truncateAt = Math.floor(
        (result.length * TOOL_RESULT_TOKEN_LIMIT * 4) / totalChars,
      );
      return [...result.slice(0, truncateAt), TRUNCATION_GUIDANCE];
    }
    return result;
  }
  // string
  if (result.length > TOOL_RESULT_TOKEN_LIMIT * 4) {
    return (
      result.substring(0, TOOL_RESULT_TOKEN_LIMIT * 4) +
      "\n" +
      TRUNCATION_GUIDANCE
    );
  }
  return result;
}

/**
 * Validate and normalize a directory path.
 *
 * Ensures paths are safe to use by preventing directory traversal attacks
 * and enforcing consistent formatting. All paths are normalized to use
 * forward slashes and start with a leading slash.
 *
 * This function is designed for virtual filesystem paths and rejects
 * Windows absolute paths (e.g., C:/..., F:/...) to maintain consistency
 * and prevent path format ambiguity.
 *
 * @param path - Path to validate
 * @returns Normalized path starting with / and ending with /
 * @throws Error if path is invalid
 *
 * @example
 * ```typescript
 * validatePath("foo/bar")  // Returns: "/foo/bar/"
 * validatePath("/./foo//bar")  // Returns: "/foo/bar/"
 * validatePath("../etc/passwd")  // Throws: Path traversal not allowed
 * validatePath("C:\\Users\\file")  // Throws: Windows absolute paths not supported
 * ```
 */
export function validatePath(path: string | null | undefined): string {
  const pathStr = path || "/";
  if (!pathStr || pathStr.trim() === "") {
    throw new Error("Path cannot be empty");
  }

  let normalized = pathStr.startsWith("/") ? pathStr : "/" + pathStr;

  if (!normalized.endsWith("/")) {
    normalized += "/";
  }

  return normalized;
}

/**
 * Validate and normalize a file path for security.
 *
 * Ensures paths are safe to use by preventing directory traversal attacks
 * and enforcing consistent formatting. All paths are normalized to use
 * forward slashes and start with a leading slash.
 *
 * This function is designed for virtual filesystem paths and rejects
 * Windows absolute paths (e.g., C:/..., F:/...) to maintain consistency
 * and prevent path format ambiguity.
 *
 * @param path - The path to validate and normalize.
 * @param allowedPrefixes - Optional list of allowed path prefixes. If provided,
 *                          the normalized path must start with one of these prefixes.
 * @returns Normalized canonical path starting with `/` and using forward slashes.
 * @throws Error if path contains traversal sequences (`..` or `~`), is a Windows
 *         absolute path (e.g., C:/...), or does not start with an allowed prefix
 *         when `allowedPrefixes` is specified.
 *
 * @example
 * ```typescript
 * validateFilePath("foo/bar")  // Returns: "/foo/bar"
 * validateFilePath("/./foo//bar")  // Returns: "/foo/bar"
 * validateFilePath("../etc/passwd")  // Throws: Path traversal not allowed
 * validateFilePath("C:\\Users\\file.txt")  // Throws: Windows absolute paths not supported
 * validateFilePath("/data/file.txt", ["/data/"])  // Returns: "/data/file.txt"
 * validateFilePath("/etc/file.txt", ["/data/"])  // Throws: Path must start with...
 * ```
 */
export function validateFilePath(
  path: string,
  allowedPrefixes?: string[],
): string {
  // Check for path traversal
  if (path.includes("..") || path.startsWith("~")) {
    throw new Error(`Path traversal not allowed: ${path}`);
  }

  // Reject Windows absolute paths (e.g., C:\..., D:/...)
  // This maintains consistency in virtual filesystem paths
  if (/^[a-zA-Z]:/.test(path)) {
    throw new Error(
      `Windows absolute paths are not supported: ${path}. Please use virtual paths starting with / (e.g., /workspace/file.txt)`,
    );
  }

  // Normalize path separators and remove redundant slashes
  let normalized = path.replace(/\\/g, "/");

  // Remove redundant path components (./foo becomes foo, foo//bar becomes foo/bar)
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (part === "." || part === "") {
      continue;
    }
    parts.push(part);
  }
  normalized = "/" + parts.join("/");

  // Check allowed prefixes if provided
  if (
    allowedPrefixes &&
    !allowedPrefixes.some((prefix) => normalized.startsWith(prefix))
  ) {
    throw new Error(
      `Path must start with one of ${JSON.stringify(allowedPrefixes)}: ${path}`,
    );
  }

  return normalized;
}

/**
 * Search files dict for paths matching glob pattern.
 *
 * @param files - Dictionary of file paths to FileData
 * @param pattern - Glob pattern (e.g., `*.py`, `**\/*.ts`)
 * @param path - Base path to search from
 * @returns Newline-separated file paths, sorted by modification time (most recent first).
 *          Returns "No files found" if no matches.
 *
 * @example
 * ```typescript
 * const files = {"/src/main.py": FileData(...), "/test.py": FileData(...)};
 * globSearchFiles(files, "*.py", "/");
 * // Returns: "/test.py\n/src/main.py" (sorted by modified_at)
 * ```
 */
export function globSearchFiles(
  files: Record<string, FileData>,
  pattern: string,
  path: string = "/",
): string {
  let normalizedPath: string;
  try {
    normalizedPath = validatePath(path);
  } catch {
    return "No files found";
  }

  const filtered = Object.fromEntries(
    Object.entries(files).filter(([fp]) => fp.startsWith(normalizedPath)),
  );

  // Respect standard glob semantics:
  // - Patterns without path separators (e.g., "*.py") match only in the current
  //   directory (non-recursive) relative to `path`.
  // - Use "**" explicitly for recursive matching.
  const effectivePattern = pattern;

  const matches: Array<[string, string]> = [];
  for (const [filePath, fileData] of Object.entries(filtered)) {
    let relative = filePath.substring(normalizedPath.length);
    if (relative.startsWith("/")) {
      relative = relative.substring(1);
    }
    if (!relative) {
      const parts = filePath.split("/");
      relative = parts[parts.length - 1] || "";
    }

    if (
      micromatch.isMatch(relative, effectivePattern, {
        dot: true,
        nobrace: false,
      })
    ) {
      matches.push([filePath, fileData.modified_at]);
    }
  }

  matches.sort((a, b) => b[1].localeCompare(a[1])); // Sort by modified_at descending

  if (matches.length === 0) {
    return "No files found";
  }

  return matches.map(([fp]) => fp).join("\n");
}

/**
 * Format grep search results based on output mode.
 *
 * @param results - Dictionary mapping file paths to list of [line_num, line_content] tuples
 * @param outputMode - Output format - "files_with_matches", "content", or "count"
 * @returns Formatted string output
 */
export function formatGrepResults(
  results: Record<string, Array<[number, string]>>,
  outputMode: "files_with_matches" | "content" | "count",
): string {
  if (outputMode === "files_with_matches") {
    return Object.keys(results).sort().join("\n");
  }
  if (outputMode === "count") {
    const lines: string[] = [];
    for (const filePath of Object.keys(results).sort()) {
      const count = results[filePath].length;
      lines.push(`${filePath}: ${count}`);
    }
    return lines.join("\n");
  }
  // content mode
  const lines: string[] = [];
  for (const filePath of Object.keys(results).sort()) {
    lines.push(`${filePath}:`);
    for (const [lineNum, line] of results[filePath]) {
      lines.push(`  ${lineNum}: ${line}`);
    }
  }
  return lines.join("\n");
}

/**
 * Search file contents for literal text pattern.
 *
 * Performs literal text search.
 *
 * @param files - Dictionary of file paths to FileData
 * @param pattern - Literal text to search for
 * @param path - Base path to search from
 * @param glob - Optional glob pattern to filter files (e.g., "*.py")
 * @param outputMode - Output format - "files_with_matches", "content", or "count"
 * @returns Formatted search results. Returns "No matches found" if no results.
 *
 * @example
 * ```typescript
 * const files = {"/file.py": FileData({content: ["import os", "print('hi')"], ...})};
 * grepSearchFiles(files, "import", "/");
 * // Returns: "/file.py" (with output_mode="files_with_matches")
 * ```
 */
export function grepSearchFiles(
  files: Record<string, FileData>,
  pattern: string,
  path: string | null = null,
  glob: string | null = null,
  outputMode: "files_with_matches" | "content" | "count" = "files_with_matches",
): string {
  let normalizedPath: string;
  try {
    normalizedPath = validatePath(path);
  } catch {
    return "No matches found";
  }

  let filtered = Object.fromEntries(
    Object.entries(files).filter(([fp]) => fp.startsWith(normalizedPath)),
  );

  if (glob) {
    filtered = Object.fromEntries(
      Object.entries(filtered).filter(([fp]) =>
        micromatch.isMatch(basename(fp), glob, { dot: true, nobrace: false }),
      ),
    );
  }

  const results: Record<string, Array<[number, string]>> = {};
  for (const [filePath, fileData] of Object.entries(filtered)) {
    const fileDataV2 = migrateToFileDataV2(fileData, filePath);
    if (!isTextMimeType(fileDataV2.mimeType)) {
      continue;
    }

    const content = fileDataToString(fileData);
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      // Simple substring search for literal matching
      if (line.includes(pattern)) {
        if (!results[filePath]) {
          results[filePath] = [];
        }
        results[filePath].push([lineNum, line]);
      }
    }
  }

  if (Object.keys(results).length === 0) {
    return "No matches found";
  }
  return formatGrepResults(results, outputMode);
}

/**
 * Return structured grep matches from an in-memory files mapping.
 *
 * Performs literal text search (not regex). Binary files are skipped.
 * Returns an empty array when no matches are found or on invalid input.
 */
export function grepMatchesFromFiles(
  files: Record<string, FileData>,
  pattern: string,
  path: string | null = null,
  glob: string | null = null,
): GrepMatch[] {
  let normalizedPath: string;
  try {
    normalizedPath = validatePath(path);
  } catch {
    return [];
  }

  let filtered = Object.fromEntries(
    Object.entries(files).filter(([fp]) => fp.startsWith(normalizedPath)),
  );

  if (glob) {
    filtered = Object.fromEntries(
      Object.entries(filtered).filter(([fp]) =>
        micromatch.isMatch(basename(fp), glob, { dot: true, nobrace: false }),
      ),
    );
  }

  const matches: GrepMatch[] = [];
  for (const [filePath, fileData] of Object.entries(filtered)) {
    const fileDataV2 = migrateToFileDataV2(fileData, filePath);
    if (!isTextMimeType(fileDataV2.mimeType)) {
      continue;
    }

    const content = fileDataToString(fileData);
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      // Simple substring search for literal matching
      if (line.includes(pattern)) {
        matches.push({ path: filePath, line: lineNum, text: line });
      }
    }
  }

  return matches;
}

/**
 * Group structured matches into the legacy dict form used by formatters.
 */
export function buildGrepResultsDict(
  matches: GrepMatch[],
): Record<string, Array<[number, string]>> {
  const grouped: Record<string, Array<[number, string]>> = {};
  for (const m of matches) {
    if (!grouped[m.path]) {
      grouped[m.path] = [];
    }
    grouped[m.path].push([m.line, m.text]);
  }
  return grouped;
}

/**
 * Format structured grep matches using existing formatting logic.
 */
export function formatGrepMatches(
  matches: GrepMatch[],
  outputMode: "files_with_matches" | "content" | "count",
): string {
  if (matches.length === 0) {
    return "No matches found";
  }
  return formatGrepResults(buildGrepResultsDict(matches), outputMode);
}

/**
 * Determine MIME type from a file path's extension.
 *
 * Returns "text/plain" for unknown extensions.
 *
 * @param filePath - File path to inspect
 * @returns MIME type string (e.g., "image/png", "text/plain")
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLocaleLowerCase();
  return MIME_TYPES[ext] || "text/plain";
}

/**
 * Check whether a MIME type represents text content.
 *
 * @param mimeType - MIME type string to check
 * @returns True if the MIME type is text-based
 */
export function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript" ||
    mimeType === "image/svg+xml"
  );
}

/**
 * Type guard to check if FileData is v1 format (content as line array).
 *
 * @param data - FileData to check
 * @returns True if data is FileDataV1
 */
export function isFileDataV1(data: FileData): data is FileDataV1 {
  return Array.isArray(data.content);
}

/**
 * Convert FileData to v2 format, joining v1 line arrays into a single string.
 *
 * If the data is already v2, returns it unchanged.
 *
 * @param data - FileData in either format
 * @returns FileDataV2 with content as string (text) or Uint8Array (binary)
 */
export function migrateToFileDataV2(
  data: FileDataV1 | FileDataV2,
  filePath: string,
): FileDataV2 {
  if (isFileDataV1(data)) {
    return {
      content: data.content.join("\n"),
      mimeType: getMimeType(filePath),
      created_at: data.created_at,
      modified_at: data.modified_at,
    };
  }
  if (!("mimeType" in data) || !data.mimeType) {
    return { ...data, mimeType: getMimeType(filePath) };
  }
  return data;
}

/**
 * Adapt a v1 {@link BackendProtocol} to {@link BackendProtocolV2}.
 *
 * If the backend already implements v2, it is returned as-is.
 * For v1 backends, wraps returns in Result types:
 * - `read()` string returns wrapped in {@link ReadResult}
 * - `readRaw()` FileData returns wrapped in {@link ReadRawResult}
 * - `grep()` returns wrapped in {@link GrepResult}
 * - `ls()` FileInfo[] returns wrapped in {@link LsResult}
 * - `glob()` FileInfo[] returns wrapped in {@link GlobResult}
 *
 * Note: For sandbox instances, use {@link adaptSandboxProtocol} instead.
 *
 * @param backend - Backend instance (v1 or v2)
 * @returns BackendProtocolV2-compatible backend
 */
export function adaptBackendProtocol(
  backend: AnyBackendProtocol,
): BackendProtocolV2 {
  const adapted: BackendProtocolV2 = {
    async ls(path): Promise<LsResult> {
      const result = await ("ls" in backend
        ? (backend as BackendProtocolV2).ls(path)
        : (backend as BackendProtocolV1).lsInfo(path));
      if (Array.isArray(result)) return { files: result };
      return result as LsResult;
    },
    async readRaw(filePath): Promise<ReadRawResult> {
      const result = await backend.readRaw(filePath);
      if ("data" in result || "error" in result) {
        return result as ReadRawResult;
      }
      return { data: migrateToFileDataV2(result as FileData, filePath) };
    },
    async glob(pattern, path): Promise<GlobResult> {
      const result = await ("glob" in backend
        ? (backend as BackendProtocolV2).glob(pattern, path)
        : (backend as BackendProtocolV1).globInfo(pattern, path));
      if (Array.isArray(result)) return { files: result };
      return result as GlobResult;
    },
    write: (filePath, content) => backend.write(filePath, content),
    edit: (filePath, oldString, newString, replaceAll) =>
      backend.edit(filePath, oldString, newString, replaceAll),
    uploadFiles: backend.uploadFiles
      ? (files) => backend.uploadFiles!(files)
      : undefined,
    downloadFiles: backend.downloadFiles
      ? (paths) => backend.downloadFiles!(paths)
      : undefined,
    async read(filePath, offset, limit): Promise<ReadResult> {
      const result = await backend.read(filePath, offset, limit);
      if (typeof result === "string") return { content: result };
      return result as ReadResult;
    },
    async grep(pattern, path, glob): Promise<GrepResult> {
      const result = await ("grep" in backend
        ? (backend as BackendProtocolV2).grep(pattern, path, glob)
        : (backend as BackendProtocolV1).grepRaw(pattern, path, glob));
      if (Array.isArray(result)) return { matches: result };
      if (typeof result === "string") return { error: result };
      return result as GrepResult;
    },
  };

  return adapted;
}

/**
 * Adapt a sandbox backend from v1 to v2 interface.
 *
 * This extends {@link adaptBackendProtocol} to also preserve sandbox-specific
 * properties from {@link SandboxBackendProtocol}: `execute` and `id`.
 *
 * @param sandbox - Sandbox backend (v1 or v2)
 * @returns SandboxBackendProtocolV2-compatible sandbox
 */
export function adaptSandboxProtocol(
  sandbox: AnySandboxProtocol,
): SandboxBackendProtocolV2 {
  // First adapt the backend protocol methods to v2
  const adapted = adaptBackendProtocol(sandbox);

  // Preserve sandbox protocol properties (execute, id)
  // Both SandboxBackendProtocol and SandboxBackendProtocolV2 have these
  (adapted as SandboxBackendProtocolV2).execute = (cmd: string) =>
    sandbox.execute(cmd);
  Object.defineProperty(adapted, "id", {
    value: sandbox.id,
    enumerable: true,
    configurable: true,
  });

  return adapted as SandboxBackendProtocolV2;
}
