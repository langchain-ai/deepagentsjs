/**
 * Backends for pluggable file storage.
 *
 * Backends provide a uniform interface for file operations while allowing
 * different storage mechanisms (state, store, filesystem, database, etc.).
 */

export type {
  BackendProtocol,
  BackendFactory,
  FileData,
  FileInfo,
  GrepMatch,
  WriteResult,
  EditResult,
  StateAndStore,
  // Sandbox execution types
  ExecuteResponse,
  FileOperationError,
  FileDownloadResponse,
  FileUploadResponse,
  SandboxBackendProtocol,
  MaybePromise,
  // Sandbox provider types
  SandboxInfo,
  SandboxListResponse,
  SandboxListOptions,
  SandboxGetOrCreateOptions,
  SandboxDeleteOptions,
  // Sandbox error types
  SandboxErrorCode,
} from "./protocol.js";

// Export type guard and error class
export { isSandboxBackend, SandboxError } from "./protocol.js";

export { StateBackend } from "./state.js";
export { StoreBackend } from "./store.js";
export { FilesystemBackend } from "./filesystem.js";
export { CompositeBackend } from "./composite.js";

// Export BaseSandbox abstract class
export { BaseSandbox } from "./sandbox.js";

// Re-export utils for convenience
export * from "./utils.js";
