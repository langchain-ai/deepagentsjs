/* eslint-disable no-instanceof/no-instanceof */
import { WasixSandboxError } from "./types.js";
import type { FsCallbacks } from "./fs-callbacks.js";

import type { RuntimeHandle as WasmRuntimeHandle } from "./wasm/engine.js";

export type { RuntimeHandle as WasmRuntimeHandle } from "./wasm/engine.js";

/**
 * Result shape returned by the WASM `execute()` function.
 * Matches the Rust `ExecuteResult` struct (serialized via serde).
 */
export interface WasmExecuteResult {
  output: string;
  exit_code: number;
  truncated: boolean;
}

// Lazily-loaded WASM module bindings
let wasmModule: typeof import("./wasm/engine.js") | null = null;

/**
 * Initialize the WASM engine by dynamically importing the wasm-pack output.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * @throws WasixSandboxError if the WASM module cannot be loaded
 */
export async function initEngine(): Promise<void> {
  if (wasmModule !== null) return;

  try {
    wasmModule = await import("./wasm/engine.js");
  } catch (err) {
    throw new WasixSandboxError(
      "Failed to load WASM engine. Ensure `pnpm run build:wasm` has been run.",
      "WASM_ENGINE_NOT_INITIALIZED",
      err instanceof Error ? err : undefined,
    );
  }
}

/**
 * Create a WASIX runtime with the given filesystem callbacks.
 *
 * @throws WasixSandboxError if the engine has not been initialized
 */
export function createRuntime(callbacks: FsCallbacks): WasmRuntimeHandle {
  if (wasmModule === null) {
    throw new WasixSandboxError(
      "WASM engine not initialized. Call initEngine() first.",
      "WASM_ENGINE_NOT_INITIALIZED",
    );
  }
  try {
    return wasmModule.create_runtime(callbacks);
  } catch (err) {
    throw new WasixSandboxError(
      "Failed to create WASIX runtime.",
      "WASM_ENGINE_FAILED",
      err instanceof Error ? err : undefined,
    );
  }
}

/**
 * Execute a command string in the WASIX runtime.
 *
 * @returns Parsed ExecuteResult from the WASM engine
 * @throws WasixSandboxError if the engine has not been initialized
 */
export function executeCommand(command: string): WasmExecuteResult {
  if (wasmModule === null) {
    throw new WasixSandboxError(
      "WASM engine not initialized. Call initEngine() first.",
      "WASM_ENGINE_NOT_INITIALIZED",
    );
  }
  try {
    const result = wasmModule.execute(command) as WasmExecuteResult;
    return result;
  } catch (err) {
    throw new WasixSandboxError(
      `WASM execute failed for command: ${command}`,
      "WASM_ENGINE_FAILED",
      err instanceof Error ? err : undefined,
    );
  }
}

/**
 * Check whether the WASM engine has been initialized.
 */
export function isEngineInitialized(): boolean {
  return wasmModule !== null;
}

/**
 * Reset the engine state (for testing).
 * @internal
 */
export function _resetEngine(): void {
  wasmModule = null;
}
