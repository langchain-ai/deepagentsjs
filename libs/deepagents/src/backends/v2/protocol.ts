/**
 * Current v2 backend protocol interfaces.
 *
 * These are the primary interfaces for backend implementations.
 * V1 backends can be adapted using {@link adaptBackendProtocol} from utils.
 */

import type { BackendProtocol } from "../v1/protocol.js";
import type {
  ExecuteResponse,
  GrepResult,
  MaybePromise,
  ReadResult,
} from "../protocol.js";

/**
 * Updated protocol for pluggable memory backends.
 *
 * Key differences from {@link BackendProtocol}:
 * - `read()` returns {@link ReadResult} instead of a plain string
 * - `grepRaw()` returns {@link GrepResult} instead of `GrepMatch[] | string`
 *
 * Existing v1 backends can be adapted to this interface using
 * {@link adaptBackendProtocol} from utils.
 */
export interface BackendProtocolV2 extends Omit<
  BackendProtocol,
  "read" | "grepRaw"
> {
  /**
   * Read file content.
   *
   * For text files, content is paginated by line offset/limit.
   * For binary files, the full base64-encoded content is returned.
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
   * Search file contents for a literal text pattern.
   *
   * Binary files (determined by MIME type) are skipped.
   *
   * @param pattern - Literal text pattern to search for
   * @param path - Base path to search from (default: null)
   * @param glob - Optional glob pattern to filter files (e.g., "*.py")
   * @returns GrepResult with matches on success or error on failure
   */
  grepRaw(
    pattern: string,
    path?: string | null,
    glob?: string | null,
  ): MaybePromise<GrepResult>;
}

/**
 * Protocol for sandboxed backends with isolated runtime.
 *
 * Key differences from {@link SandboxBackendProtocol}:
 * - Extends {@link BackendProtocolV2} instead of {@link BackendProtocol}
 * - `read()` returns {@link ReadResult} instead of a plain string
 * - `grepRaw()` returns {@link GrepResult} instead of `GrepMatch[] | string`
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
