/**
 * Backends for pluggable file storage.
 *
 * Backends provide a uniform interface for file operations while allowing
 * different storage mechanisms (state, store, filesystem, database, etc.).
 */

export type {
  AnyBackendProtocol,
  BackendProtocol,
  BackendProtocolV1,
  BackendProtocolV2,
  BackendFactory,
  BackendRuntime,
  NamespaceFactory,
  FileData,
  FileInfo,
  GrepMatch,
  ReadResult,
  ReadRawResult,
  GrepResult,
  LsResult,
  GlobResult,
  WriteResult,
  EditResult,
  StateAndStore,
  // Sandbox execution types
  ExecuteResponse,
  FileOperationError,
  FileDownloadResponse,
  FileUploadResponse,
  SandboxBackendProtocol,
  SandboxBackendProtocolV1,
  SandboxBackendProtocolV2,
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

export {
  isSandboxBackend,
  isSandboxProtocol,
  SandboxError,
  BackendContext,
  resolveBackend,
} from "./protocol.js";

export { StateBackend } from "./state.js";
export { StoreBackend, type StoreBackendOptions } from "./store.js";
export { FilesystemBackend } from "./filesystem.js";
export { CompositeBackend } from "./composite.js";
export {
  LocalShellBackend,
  type LocalShellBackendOptions,
} from "./local-shell.js";

// Export BaseSandbox abstract class
export { BaseSandbox } from "./sandbox.js";

// Export LangSmith sandbox backend
export {
  LangSmithSandbox,
  type LangSmithSandboxOptions,
  type LangSmithSandboxCreateOptions,
} from "./langsmith.js";

// Re-export utils for convenience
export * from "./utils.js";
