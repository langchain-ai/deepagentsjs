// @ts-ignore
import * as wasm_bytes from "../rust/runtime/pkg/deepwasm_bg.wasm";

export const getWasm = () => {
  return wasm_bytes;
};
