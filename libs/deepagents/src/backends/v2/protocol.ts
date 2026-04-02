/**
 * Current v2 backend protocol interfaces.
 *
 * These are the primary interfaces for backend implementations.
 * V1 backends can be adapted using {@link adaptBackendProtocol} from utils.
 */

import type { BackendProtocolV1 } from "../v1/protocol.js";
import type {
  ExecuteResponse,
  GlobResult,
  GrepResult,
  LsResult,
  MaybePromise,
  ReadRawResult,
  ReadResult,
} from "../protocol.js";

/**
 * Updated protocol for pluggable memory backends.
 *
 * Key differences from {@link BackendProtocol}:
 * - `read()` returns {@link ReadResult} instead of a plain string
 * - `readRaw()` returns {@link ReadRawResult} instead of FileData
 * - `grep()` returns {@link GrepResult} instead of `GrepMatch[] | string`
 * - `ls()` returns {@link LsResult} instead of FileInfo[]
 * - `glob()` returns {@link GlobResult} instead of FileInfo[]
 *
 * Existing v1 backends can be adapted to this interface using
 * {@link adaptBackendProtocol} from utils.
 */
export interface BackendProtocolV2 extends Omit<
  BackendProtocolV1,
  "read" | "readRaw" | "grepRaw" | "lsInfo" | "globInfo"
> {
  /**
   * Structured listing with file metadata.
   *
   * Lists files and directories in the specified directory (non-recursive).
   * Directories have a trailing / in their path and is_dir=true.
   *
   * @param path - Absolute path to directory
   * @returns LsResult with list of FileInfo objects on success or error on failure
   */
  ls(path: string): MaybePromise<LsResult>;

  /**
   * Read file content.
   *
   * For text files, content is paginated by line offset/limit.
   * For binary files, the full raw Uint8Array content is returned.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed), default 0
   * @param limit - Maximum number of lines to read, default 500
   * @returns ReadResult with content on success or error on failure
   */
  read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): MaybePromise<ReadResult>;

  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns ReadRawResult with raw file data on success or error on failure
   */
  readRaw(filePath: string): MaybePromise<ReadRawResult>;

  /**
   * Search file contents for a literal text pattern.
   *
   * Binary files (determined by MIME type) are skipped.
   *
   * @param pattern - Literal text pattern to search for
   * @param path - Base path to search from (default: null)
   * @param glob - Optional glob pattern to filter files (e.g., "*.py")
   * @returns GrepResult with matches on success or error on failure
   */
  grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
  ): MaybePromise<GrepResult>;

  /**
   * Structured glob matching returning FileInfo objects.
   *
   * @param pattern - Glob pattern (e.g., `*.py`, `**\/*.ts`)
   * @param path - Base path to search from (default: "/")
   * @returns GlobResult with list of FileInfo objects matching the pattern on success or error on failure
   */
  glob(pattern: string, path?: string): MaybePromise<GlobResult>;
}

/**
 * Protocol for sandboxed backends with isolated runtime.
 *
 * Key differences from {@link SandboxBackendProtocol}:
 * - Extends {@link BackendProtocolV2} instead of {@link BackendProtocol}
 * - All methods return structured Result types for consistent error handling
 */
export interface SandboxBackendProtocolV2 extends BackendProtocolV2 {
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
