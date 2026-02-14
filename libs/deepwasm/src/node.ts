export * from "./";
export { DeepwasmBackend } from "./backend.js";
export * from "./types.js";
// import { Worker } from "node:worker_threads";
import Worker from "web-worker";
import { fileURLToPath } from 'node:url';
import { init as load, InitOutput, WasmerInitInput } from "./";

type VolumeTreeFile = { data: Uint8Array; modified: Date };
interface VolumeTree { [key: string]: VolumeTreeFile | VolumeTree }
import fs from "node:fs/promises";
import path from "node:path";

//@ts-ignore
globalThis.Worker = Worker;

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
    const path = new URL("deepwasm_bg.wasm", import.meta.url).pathname;
    initValue.module = await fs.readFile(path);
  }
  if (!initValue.workerUrl) {
    initValue.workerUrl = fileURLToPath(new URL("worker.mjs", import.meta.url));
  }
  if (!initValue.sdkUrl) {
    initValue.sdkUrl = fileURLToPath(new URL("node.mjs", import.meta.url));
  }
  return load(initValue);
};

export async function walkDir(dir: string, result: VolumeTree = {}) {
  let list = await fs.readdir(dir);
  for (let item of list) {
    const itemPath = path.join(dir, item);
    let stats = await fs.stat(itemPath);
    if (await stats.isDirectory()) {
      result[item] = {};
      await walkDir(itemPath, result[item] as VolumeTree);
    } else {
      const fileName = path.basename(item);
      result[fileName] = {
        data: new Uint8Array(await fs.readFile(itemPath)), // , { encoding: 'utf-8'}
        modified: stats.mtime,
      };
    }
  }
  return result;
}
