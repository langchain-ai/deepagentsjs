/**
 * Deprecated v1 backend protocol interfaces.
 *
 * These interfaces are retained for backwards compatibility. New implementations
 * should use {@link BackendProtocolV2} from "../v2/protocol.js" instead.
 * Existing v1 backends can be adapted using {@link adaptBackendProtocol} from utils.
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
  WriteResult,
} from "../protocol.js";

/**
 * Protocol for pluggable memory backends (single, unified).
 *
 * Backends can store files in different locations (state, filesystem, database, etc.)
 * and provide a uniform interface for file operations.
 *
 * All file data is represented as objects with the FileData structure.
 *
 * Methods can return either direct values or Promises, allowing both
 * synchronous and asynchronous implementations.
 *
 * @deprecated Use {@link BackendProtocolV2} instead.
 */
export interface BackendProtocolV1 {
  /**
   * Structured listing with file metadata.
   *
   * Lists files and directories in the specified directory (non-recursive).
   * Directories have a trailing / in their path and is_dir=true.
   *
   * @param path - Absolute path to directory
   * @returns List of FileInfo objects for files and directories directly in the directory
   */
  lsInfo(path: string): MaybePromise<FileInfo[]>;

  /**
   * Read file content.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed), default 0
   * @param limit - Maximum number of lines to read, default 500
   * @returns File content as plain string on success or error on failure
   */
  read(filePath: string, offset?: number, limit?: number): MaybePromise<string>;

  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns Raw file content as FileData
   */
  readRaw(filePath: string): MaybePromise<FileData>;

  /**
   * Search file contents for a literal text pattern.
   *
   * Binary files (determined by MIME type) are skipped.
   *
   * @param pattern - Literal text pattern to search for
   * @param path - Base path to search from (default: null)
   * @param glob - Optional glob pattern to filter files (e.g., "*.py")
   * @returns Array of GrepMatch on success or error string on failure
   */
  grepRaw(
    pattern: string,
    path?: string | null,
    glob?: string | null,
  ): MaybePromise<GrepMatch[] | string>;

  /**
   * Structured glob matching returning FileInfo objects.
   *
   * @param pattern - Glob pattern (e.g., `*.py`, `**\/*.ts`)
   * @param path - Base path to search from (default: "/")
   * @returns List of FileInfo objects matching the pattern
   */
  globInfo(pattern: string, path?: string): MaybePromise<FileInfo[]>;

  /**
   * Create a new file.
   *
   * @param filePath - Absolute file path
   * @param content - File content as string
   * @returns WriteResult with error populated on failure
   */
  write(filePath: string, content: string): MaybePromise<WriteResult>;

  /**
   * Edit a file by replacing string occurrences.
   *
   * @param filePath - Absolute file path
   * @param oldString - String to find and replace
   * @param newString - Replacement string
   * @param replaceAll - If true, replace all occurrences (default: false)
   * @returns EditResult with error, path, filesUpdate, and occurrences
   */
  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): MaybePromise<EditResult>;

  /**
   * Upload multiple files.
   * Optional - backends that don't support file upload can omit this.
   *
   * @param files - List of [path, content] tuples to upload
   * @returns List of FileUploadResponse objects, one per input file
   */
  uploadFiles?(
    files: Array<[string, Uint8Array]>,
  ): MaybePromise<FileUploadResponse[]>;

  /**
   * Download multiple files.
   * Optional - backends that don't support file download can omit this.
   *
   * @param paths - List of file paths to download
   * @returns List of FileDownloadResponse objects, one per input path
   */
  downloadFiles?(paths: string[]): MaybePromise<FileDownloadResponse[]>;
}

/**
 * Protocol for sandboxed backends with isolated runtime.
 * Sandboxed backends run in isolated environments (e.g., containers)
 * and communicate via defined interfaces.
 *
 * @deprecated Use {@link SandboxBackendProtocolV2} instead.
 */
export interface SandboxBackendProtocolV1 extends BackendProtocolV1 {
  /**
   * Execute a command in the sandbox.
   *
   * @param command - Full shell command string to execute
   * @returns ExecuteResponse with combined output, exit code, and truncation flag
   */
  execute(command: string): MaybePromise<ExecuteResponse>;

  /** Unique identifier for the sandbox backend instance */
  readonly id: string;
}
