/**
 * Protocol definition for pluggable memory backends.
 *
 * This module defines the shared types and re-exports the versioned protocol
 * interfaces. Backend protocol interfaces are split by version:
 * - v1 (deprecated): {@link ./v1/protocol.js}
 * - v2 (current): {@link ./v2/protocol.js}
 */

import type { Runtime, ToolRuntime } from "langchain";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import type {
  BackendProtocolV1,
  SandboxBackendProtocolV1,
} from "./v1/protocol.js";
import type {
  BackendProtocolV2,
  SandboxBackendProtocolV2,
} from "./v2/protocol.js";
import { adaptBackendProtocol, adaptSandboxProtocol } from "./utils.js";

export type {
  BackendProtocolV1,
  SandboxBackendProtocolV1,
} from "./v1/protocol.js";
export type {
  BackendProtocolV2,
  SandboxBackendProtocolV2,
} from "./v2/protocol.js";

/** @deprecated Use {@link BackendProtocolV2} instead. */
export interface BackendProtocol extends BackendProtocolV1 {}

/** @deprecated Use {@link SandboxBackendProtocolV2} instead. */
export interface SandboxBackendProtocol extends SandboxBackendProtocolV1 {}

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
 * Structured result from grep/search operations.
 */
export interface GrepResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** Structured grep match entries, undefined on failure */
  matches?: GrepMatch[];
}

/**
 * Legacy file data format (v1).
 *
 * Content is stored as an array of lines (split on "\n"). This format
 * only supports text files and is retained for backwards compatibility
 * with existing state/store data.
 */
export interface FileDataV1 {
  /** File content as an array of lines */
  content: string[];
  /** ISO format timestamp of creation */
  created_at: string;
  /** ISO format timestamp of last modification */
  modified_at: string;
}

/**
 * Current file data format (v2).
 *
 * Content is stored as a string for text files, or as a Uint8Array for
 * binary files (images, PDFs, audio, etc.). The MIME type is stored
 * alongside the content, allowing backend implementations to determine
 * it however they see fit (e.g. from file extension, HTTP headers,
 * database metadata, etc.).
 */
export interface FileDataV2 {
  /** File content: string for text, Uint8Array for binary */
  content: string | Uint8Array;
  /** MIME type of the file (e.g. "image/png", "text/plain") */
  mimeType: string;
  /** ISO format timestamp of creation */
  created_at: string;
  /** ISO format timestamp of last modification */
  modified_at: string;
}

/**
 * Union of v1 and v2 file data formats.
 *
 * Backends may encounter either format when reading from state or store
 * (v1 from legacy data, v2 from new writes). Use {@link isFileDataV1}
 * from utils for runtime discrimination.
 */
export type FileData = FileDataV1 | FileDataV2;

/**
 * Structured result from backend read operations.
 *
 * Replaces the previous plain string return, giving callers a
 * programmatic way to distinguish errors from content.
 */
export interface ReadResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** File content: string for text, Uint8Array for binary. Undefined on failure. */
  content?: string | Uint8Array;
  /** MIME type of the file, when available */
  mimeType?: string;
}

/**
 * Structured result from backend readRaw operations.
 */
export interface ReadRawResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** Raw file data, undefined on failure */
  data?: FileData;
}

/**
 * Structured result from backend ls operations.
 */
export interface LsResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** List of FileInfo objects, undefined on failure */
  files?: FileInfo[];
}

/**
 * Structured result from backend glob operations.
 */
export interface GlobResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** List of FileInfo objects matching the pattern, undefined on failure */
  files?: FileInfo[];
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
   *
   * @deprecated Zero-arg backends send state updates internally via
   * `__pregel_send`. Check `if (result.filesUpdate)` before using.
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
   *
   * @deprecated Zero-arg backends send state updates internally via
   * `__pregel_send`. Check `if (result.filesUpdate)` before using.
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
 * Common options shared across backend constructors.
 */
export interface BackendOptions {
  /** File data format to use for new writes. Defaults to "v2". */
  fileFormat?: "v1" | "v2";
}

/**
 * Type guard to check if a backend supports execution.
 *
 * @param backend - Backend instance to check
 * @returns True if the backend implements SandboxBackendProtocolV2
 */
export function isSandboxBackend(
  backend: unknown,
): backend is SandboxBackendProtocolV2 {
  return (
    backend != null &&
    typeof backend === "object" &&
    typeof (backend as SandboxBackendProtocolV2).execute === "function" &&
    typeof (backend as SandboxBackendProtocolV2).id === "string" &&
    (backend as SandboxBackendProtocolV2).id !== ""
  );
}

/**
 * Union of v1 and v2 sandbox backend protocols.
 *
 * Use this when accepting either protocol version. Pass through
 * {@link adaptSandboxProtocol} to normalize to {@link SandboxBackendProtocolV2}.
 */
export type AnySandboxProtocol =
  | SandboxBackendProtocol
  | SandboxBackendProtocolV2;

/**
 * Type guard to check if a backend is a sandbox protocol (v1 or v2).
 *
 * Checks for the presence of `execute` function and `id` string,
 * which are the defining features of sandbox protocols.
 *
 * @param backend - Backend instance to check
 * @returns True if the backend implements sandbox protocol (v1 or v2)
 */
export function isSandboxProtocol(
  backend: unknown,
): backend is AnySandboxProtocol {
  return (
    backend != null &&
    typeof backend === "object" &&
    typeof (backend as any).execute === "function" &&
    typeof (backend as any).id === "string" &&
    (backend as any).id !== ""
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
 *
 * @deprecated Use {@link BackendRuntime} instead.
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
 * Union of v1 and v2 backend protocols.
 *
 * Use this when accepting either protocol version. Pass through
 * {@link adaptBackendProtocol} to normalize to {@link BackendProtocolV2}.
 */
export type AnyBackendProtocol = BackendProtocolV1 | BackendProtocolV2;

/**
 * Agent {@link Runtime} with `state`
 *
 * @deprecated Backends now read state from the LangGraph execution context
 * via `getCurrentTaskInput()`, `getConfig()`, and `getStore()`.
 */
export interface BackendRuntime<StateT = unknown> extends Runtime {
  /** Current agent state with files, messages, etc. */
  state: StateT;
}

/**
 * Factory function type for creating backend instances.
 *
 * Backends receive {@link BackendRuntime} which contains the current state
 * and runtime information, extracted from the execution context.
 *
 * @deprecated Pass a pre-constructed backend instance instead of a factory.
 * E.g., `backend: new StateBackend()` instead of `backend: (runtime) => new StateBackend(runtime)`.
 *
 * @example
 * ```typescript
 * // Using in middleware
 * const middleware = createFilesystemMiddleware({
 *   backend: (runtime) => new StateBackend(runtime)
 * });
 * ```
 */
export type BackendFactory = (
  runtime: BackendRuntime,
) => MaybePromise<AnyBackendProtocol>;

/**
 * Resolve a backend instance or await a {@link BackendFactory}.
 *
 * Accepts {@link BackendRuntime} or {@link ToolRuntime} — store typing differs
 * between LangGraph checkpoint stores and core `ToolRuntime`; factories receive
 * a value that is structurally compatible at runtime.
 *
 * @internal
 */
export async function resolveBackend(
  backend: AnyBackendProtocol | BackendFactory,
  runtime: BackendRuntime | ToolRuntime,
): Promise<BackendProtocolV2> {
  if (typeof backend === "function") {
    const resolved = await backend(runtime as BackendRuntime);
    return isSandboxProtocol(resolved)
      ? adaptSandboxProtocol(resolved)
      : adaptBackendProtocol(resolved);
  }
  return isSandboxProtocol(backend)
    ? adaptSandboxProtocol(backend)
    : adaptBackendProtocol(backend);
}
