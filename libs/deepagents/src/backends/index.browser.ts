/**
 * Browser-safe backend exports.
 *
 * Excludes FilesystemBackend, LocalShellBackend, and LangSmithSandbox
 * which require Node.js APIs (node:fs, node:child_process).
 *
 * In browser, use a SandboxBackendProtocol implementation (e.g. wasmsh
 * BrowserSandbox) that provides filesystem, shell, and Python via Web Worker.
 */

export type {
  BackendProtocol,
  BackendFactory,
  BackendRuntime,
  FileData,
  FileInfo,
  GrepMatch,
  WriteResult,
  EditResult,
  StateAndStore,
  ExecuteResponse,
  FileOperationError,
  FileDownloadResponse,
  FileUploadResponse,
  SandboxBackendProtocol,
  MaybePromise,
  SandboxInfo,
  SandboxListResponse,
  SandboxListOptions,
  SandboxGetOrCreateOptions,
  SandboxDeleteOptions,
  SandboxErrorCode,
} from "./protocol.js";

export { isSandboxBackend, SandboxError, resolveBackend } from "./protocol.js";

export { StateBackend } from "./state.js";
export { StoreBackend, type StoreBackendOptions } from "./store.js";
export { CompositeBackend } from "./composite.js";
export { BaseSandbox } from "./sandbox.js";

export * from "./utils.js";
