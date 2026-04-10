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
