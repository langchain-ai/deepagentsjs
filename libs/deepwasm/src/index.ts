export * from "../rust/runtime/pkg/deepwasm";
export * from "./types.js";
// @ts-ignore
import load, {
  InitInput,
  InitOutput,
  // @ts-ignore
  ThreadPoolWorker,
  initializeLogger,
  setWorkerUrl,
  setSDKUrl,
} from "../rust/runtime/pkg/deepwasm";

export type WasmerRegistryConfig = {
  registryUrl?: string;
  token?: string;
};

export type WasmerInitInput = {
  module?: InitInput | Promise<InitInput>;
  memory?: WebAssembly.Memory;
  workerUrl?: string | URL;
  sdkUrl?: string | URL;
  log?: string;
} & WasmerRegistryConfig;

/**
 * Initialize the underlying WebAssembly module.
 */
export const init = async (
  initValue?: WasmerInitInput,
  memory?: WebAssembly.Memory,
): Promise<InitOutput> => {
  if (!initValue) {
    initValue = {};
  } else if (
    initValue instanceof WebAssembly.Module ||
    initValue instanceof URL ||
    initValue instanceof WebAssembly.Module
  ) {
    if (memory) {
      console.info(
        "Passing the module and memory as first arguments to the init function is deprecated, please use: `init({module: WASM_MODULE, memory: WASM_MEMORY})`",
      );
      initValue = {
        module: initValue,
        memory: memory,
      };
    } else {
      console.info(
        "Passing the module as first argument to the init function is deprecated, please use: `init({module: WASM_MODULE})`",
      );
      initValue = {
        module: initValue,
      };
    }
  }

  setRegistry(initValue);

  let output = await load(initValue.module, initValue.memory);
  if (initValue.log) {
    initializeLogger(initValue.log);
  }
  if (initValue.workerUrl) {
    setWorkerUrl(initValue.workerUrl.toString());
  }
  if (initValue.sdkUrl) {
    setSDKUrl(initValue.sdkUrl.toString());
  }
  else {
    setSDKUrl(new URL("index.mjs", import.meta.url).toString());
  }
  return output;
};

export const setRegistry = (initValue: WasmerRegistryConfig) => {
  (globalThis as any)["__WASMER_REGISTRY__"] = {
    registryUrl: initValue.registryUrl,
    token: initValue.token,
  };
};
