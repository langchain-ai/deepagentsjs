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
} from "./protocol.js";

export { StateBackend } from "./state.js";
export { StoreBackend } from "./store.js";
export { FilesystemBackend } from "./filesystem.js";
export { CompositeBackend } from "./composite.js";

// Re-export utils for convenience
export * from "./utils.js";
