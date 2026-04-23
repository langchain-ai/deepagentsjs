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

// Export type guard and error class
export {
  isSandboxBackend,
  isSandboxProtocol,
  SandboxError,
  resolveBackend,
} from "./protocol.js";

export { StateBackend } from "./state.js";
export {
  StoreBackend,
  type StoreBackendContext,
  type StoreBackendNamespaceFactory,
  type StoreBackendOptions,
} from "./store.js";
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

// Re-export upstream sandbox types used by LangSmithSandbox public API
export type {
  Snapshot as LangSmithSnapshot,
  CaptureSnapshotOptions as LangSmithCaptureSnapshotOptions,
  StartSandboxOptions as LangSmithStartSandboxOptions,
} from "langsmith/experimental/sandbox";

// Re-export utils for convenience
export * from "./utils.js";
