/**
 * Protocol definition for pluggable memory backends.
 *
 * This module defines the BackendProtocol that all backend implementations
 * must follow. Backends can store files in different locations (state, filesystem,
 * database, etc.) and provide a uniform interface for file operations.
 */

import type { BaseStore } from "@langchain/langgraph-checkpoint";

export type MaybePromise<T> = T | Promise<T>;

/**
 * Structured file listing info.
 *
 * Minimal contract used across backends. Only "path" is required.
 * Other fields are best-effort and may be absent depending on backend.
 */
export interface FileInfo {
  /** File path */
  path: string;
  /** Whether this is a directory */
  is_dir?: boolean;
  /** File size in bytes (approximate) */
  size?: number;
  /** ISO 8601 timestamp of last modification */
  modified_at?: string;
}

/**
 * Structured grep match entry.
 */
export interface GrepMatch {
  /** File path where match was found */
  path: string;
  /** Line number (1-indexed) */
  line: number;
  /** The matching line text */
  text: string;
}

/**
 * File data structure used by backends.
 *
 * All file data is represented as objects with this structure:
 */
export interface FileData {
  /** Lines of text content */
  content: string[];
  /** ISO format timestamp of creation */
  created_at: string;
  /** ISO format timestamp of last modification */
  modified_at: string;
}

/**
 * Result from backend write operations.
 *
 * Checkpoint backends populate filesUpdate with {file_path: file_data} for LangGraph state.
 * External backends set filesUpdate to null (already persisted to disk/S3/database/etc).
 */
export interface WriteResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** File path of written file, undefined on failure */
  path?: string;
  /**
   * State update dict for checkpoint backends, null for external storage.
   * Checkpoint backends populate this with {file_path: file_data} for LangGraph state.
   * External backends set null (already persisted to disk/S3/database/etc).
   */
  filesUpdate?: Record<string, FileData> | null;
  /** Metadata for the write operation, attached to the ToolMessage */
  metadata?: Record<string, unknown>;
}

/**
 * Result from backend edit operations.
 *
 * Checkpoint backends populate filesUpdate with {file_path: file_data} for LangGraph state.
 * External backends set filesUpdate to null (already persisted to disk/S3/database/etc).
 */
export interface EditResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** File path of edited file, undefined on failure */
  path?: string;
  /**
   * State update dict for checkpoint backends, null for external storage.
   * Checkpoint backends populate this with {file_path: file_data} for LangGraph state.
   * External backends set null (already persisted to disk/S3/database/etc).
   */
  filesUpdate?: Record<string, FileData> | null;
  /** Number of replacements made, undefined on failure */
  occurrences?: number;
  /** Metadata for the edit operation, attached to the ToolMessage */
  metadata?: Record<string, unknown>;
}

/**
 * Result of code execution.
 * Simplified schema optimized for LLM consumption.
 */
export interface ExecuteResponse {
  /** Combined stdout and stderr output of the executed command */
  output: string;
  /** The process exit code. 0 indicates success, non-zero indicates failure */
  exitCode: number | null;
  /** Whether the output was truncated due to backend limitations */
  truncated: boolean;
}

/**
 * Standardized error codes for file upload/download operations.
 */
export type FileOperationError =
  | "file_not_found"
  | "permission_denied"
  | "is_directory"
  | "invalid_path";

/**
 * Result of a single file download operation.
 */
export interface FileDownloadResponse {
  /** The file path that was requested */
  path: string;
  /** File contents as Uint8Array on success, null on failure */
  content: Uint8Array | null;
  /** Standardized error code on failure, null on success */
  error: FileOperationError | null;
}

/**
 * Result of a single file upload operation.
 */
export interface FileUploadResponse {
  /** The file path that was requested */
  path: string;
  /** Standardized error code on failure, null on success */
  error: FileOperationError | null;
}

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
 */
export interface BackendProtocol {
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
   * Read file content with line numbers or an error string.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed), default 0
   * @param limit - Maximum number of lines to read, default 500
   * @returns Formatted file content with line numbers, or error message
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
   * Structured search results or error string for invalid input.
   *
   * Searches file contents for a regex pattern.
   *
   * @param pattern - Regex pattern to search for
   * @param path - Base path to search from (default: null)
   * @param glob - Optional glob pattern to filter files (e.g., "*.py")
   * @returns List of GrepMatch objects or error string for invalid regex
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
 */
export interface SandboxBackendProtocol extends BackendProtocol {
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

/**
 * Type guard to check if a backend supports execution.
 *
 * @param backend - Backend instance to check
 * @returns True if the backend implements SandboxBackendProtocol
 */
export function isSandboxBackend(
  backend: BackendProtocol,
): backend is SandboxBackendProtocol {
  return (
    typeof (backend as SandboxBackendProtocol).execute === "function" &&
    typeof (backend as SandboxBackendProtocol).id === "string"
  );
}

/**
 * Metadata for a single sandbox instance.
 *
 * This lightweight structure is returned from list operations and provides
 * basic information about a sandbox without requiring a full connection.
 *
 * @typeParam MetadataT - Type of the metadata field. Providers can define
 *   their own interface for type-safe metadata access.
 *
 * @example
 * ```typescript
 * // Using default metadata type
 * const info: SandboxInfo = {
 *   sandboxId: "sb_abc123",
 *   metadata: { status: "running", createdAt: "2024-01-15T10:30:00Z" },
 * };
 *
 * // Using typed metadata
 * interface MyMetadata {
 *   status: "running" | "stopped";
 *   createdAt: string;
 * }
 * const typedInfo: SandboxInfo<MyMetadata> = {
 *   sandboxId: "sb_abc123",
 *   metadata: { status: "running", createdAt: "2024-01-15T10:30:00Z" },
 * };
 * ```
 */
export interface SandboxInfo<MetadataT = Record<string, unknown>> {
  /** Unique identifier for the sandbox instance */
  sandboxId: string;
  /** Optional provider-specific metadata (e.g., creation time, status, template) */
  metadata?: MetadataT;
}

/**
 * Paginated response from a sandbox list operation.
 *
 * This structure supports cursor-based pagination for efficiently browsing
 * large collections of sandboxes.
 *
 * @typeParam MetadataT - Type of the metadata field in SandboxInfo items.
 *
 * @example
 * ```typescript
 * const response: SandboxListResponse = {
 *   items: [
 *     { sandboxId: "sb_001", metadata: { status: "running" } },
 *     { sandboxId: "sb_002", metadata: { status: "stopped" } },
 *   ],
 *   cursor: "eyJvZmZzZXQiOjEwMH0=",
 * };
 *
 * // Fetch next page
 * const nextResponse = await provider.list({ cursor: response.cursor });
 * ```
 */
export interface SandboxListResponse<MetadataT = Record<string, unknown>> {
  /** List of sandbox metadata objects for the current page */
  items: SandboxInfo<MetadataT>[];
  /**
   * Opaque continuation token for retrieving the next page.
   * null indicates no more pages available.
   */
  cursor: string | null;
}

/**
 * Options for listing sandboxes.
 */
export interface SandboxListOptions {
  /**
   * Continuation token from a previous list() call.
   * Pass undefined to start from the beginning.
   */
  cursor?: string;
}

/**
 * Options for getting or creating a sandbox.
 */
export interface SandboxGetOrCreateOptions {
  /**
   * Unique identifier of an existing sandbox to retrieve.
   * If undefined, creates a new sandbox instance.
   * If provided but the sandbox doesn't exist, an error will be thrown.
   */
  sandboxId?: string;
}

/**
 * Options for deleting a sandbox.
 */
export interface SandboxDeleteOptions {
  /** Unique identifier of the sandbox to delete */
  sandboxId: string;
}

/**
 * Common error codes shared across all sandbox provider implementations.
 *
 * These represent the core error conditions that any sandbox provider may encounter.
 * Provider-specific error codes should extend this type with additional codes.
 *
 * @example
 * ```typescript
 * // Provider-specific error code type extending the common codes:
 * type MySandboxErrorCode = SandboxErrorCode | "CUSTOM_ERROR";
 * ```
 */
export type SandboxErrorCode =
  /** Sandbox has not been initialized - call initialize() first */
  | "NOT_INITIALIZED"
  /** Sandbox is already initialized - cannot initialize twice */
  | "ALREADY_INITIALIZED"
  /** Command execution timed out */
  | "COMMAND_TIMEOUT"
  /** Command execution failed */
  | "COMMAND_FAILED"
  /** File operation (read/write) failed */
  | "FILE_OPERATION_FAILED";

const SANDBOX_ERROR_SYMBOL = Symbol.for("sandbox.error");

/**
 * Custom error class for sandbox operations.
 *
 * @param message - Human-readable error description
 * @param code - Structured error code for programmatic handling
 * @returns SandboxError with message and code
 *
 * @example
 * ```typescript
 * try {
 *   await sandbox.execute("some command");
 * } catch (error) {
 *   if (error instanceof SandboxError) {
 *     switch (error.code) {
 *       case "NOT_INITIALIZED":
 *         await sandbox.initialize();
 *         break;
 *       case "COMMAND_TIMEOUT":
 *         console.error("Command took too long");
 *         break;
 *       default:
 *         throw error;
 *     }
 *   }
 * }
 * ```
 */
export class SandboxError extends Error {
  /** Symbol for identifying sandbox error instances */
  [SANDBOX_ERROR_SYMBOL] = true as const;

  /** Error name for instanceof checks and logging */
  override readonly name: string = "SandboxError";

  /**
   * Creates a new SandboxError.
   *
   * @param message - Human-readable error description
   * @param code - Structured error code for programmatic handling
   */
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    Object.setPrototypeOf(this, SandboxError.prototype);
  }

  static isInstance(error: unknown): error is SandboxError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[SANDBOX_ERROR_SYMBOL] === true
    );
  }
}

/**
 * State and store container for backend initialization.
 *
 * This provides a clean interface for what backends need to access:
 * - state: Current agent state (with files, messages, etc.)
 * - store: Optional persistent store for cross-conversation data
 *
 * Different contexts build this differently:
 * - Tools: Extract state via getCurrentTaskInput(config)
 * - Middleware: Use request.state directly
 */
export interface StateAndStore {
  /** Current agent state with files, messages, etc. */
  state: unknown;
  /** Optional BaseStore for persistent cross-conversation storage */
  store?: BaseStore;
  /** Optional assistant ID for per-assistant isolation in store */
  assistantId?: string;
}

/**
 * Factory function type for creating backend instances.
 *
 * Backends receive StateAndStore which contains the current state
 * and optional store, extracted from the execution context.
 *
 * @example
 * ```typescript
 * // Using in middleware
 * const middleware = createFilesystemMiddleware({
 *   backend: (stateAndStore) => new StateBackend(stateAndStore)
 * });
 * ```
 */
export type BackendFactory = (stateAndStore: StateAndStore) => BackendProtocol;
