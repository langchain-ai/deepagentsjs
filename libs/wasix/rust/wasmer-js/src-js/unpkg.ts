export * from "./";
import { init as load, InitOutput, WasmerInitInput, setWorkerUrl } from "./";
import fs from "node:fs";

/**
 * Initialize the underlying WebAssembly module, defaulting to an embedded
 * copy of the `*.wasm` file.
 */
export const init = async (
  initValue?: WasmerInitInput,
): Promise<InitOutput> => {
  if (!initValue) {
    initValue = {};
  }

  if (!initValue.module) {
    // This will be replaced by the rollup bundler at the SDK build time
    // to point to a valid http location of the SDK using unpkg.com.
    // Note: we only do this in browsers, not in Node/Bun/Deno
    let wasmUrl = (globalThis as any).wasmUrl;
    if (wasmUrl && typeof window !== "undefined") {
      initValue.module = new URL(wasmUrl);
    }
  }
  if (!initValue.workerUrl) {
    initValue.workerUrl = (globalThis as any).workerUrl;
  }
  return load(initValue);
};

/**
 * Set a deafult working Worker Url. Which in this case will be
 * an unpkg url that is set up at the SDK build time.
 */
export const setDefaultWorkerUrl = () => {
  let workerUrl = (globalThis as any).workerUrl;
  if (workerUrl) {
    setWorkerUrl(workerUrl);
  }
};
