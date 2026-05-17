/**
 * @langchain/wasmsh
 *
 * Wasmsh sandbox backend for deepagents.
 *
 * This package provides a Pyodide-backed `wasmsh` sandbox implementation of the
 * SandboxBackendProtocol, enabling agents to execute bash-compatible shell
 * commands and `python` / `python3` in the same `/workspace`.
 *
 * @packageDocumentation
 */

export {
  WasmshSandbox,
  type WasmshBrowserWorkerOptions,
  type WasmshNodeSandboxOptions,
} from "./sandbox.js";

export {
  createWasmshInterpreterMiddleware,
  DEFAULT_PTC_EXCLUDED_TOOLS,
} from "./middleware.js";

export type {
  WasmshMiddlewareOptions,
  WasmshLogger,
  ReplEnvelope,
} from "./types.js";

export {
  WasmshFilesystemBackend,
  type WasmshFilesystemBackendOptions,
} from "./filesystem-backend.js";

export {
  scanSkillReferences,
  loadSkill,
  installPendingSkills,
  type SkillMetadata,
} from "./skills.js";

export {
  formatEnvelope,
  toSnakeCase,
  isValidPythonIdentifier,
} from "./utils.js";
