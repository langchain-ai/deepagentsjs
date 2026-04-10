/**
 * Integration tests for WasmshSandbox.
 *
 * These tests require built Pyodide assets in the wasmsh-pyodide package.
 * They will be skipped automatically if the assets are not available.
 *
 * To run: build Pyodide assets first, then `pnpm test:int`
 */
import { existsSync } from "node:fs";
import { sandboxStandardTests } from "@langchain/sandbox-standard-tests/vitest";
import { resolveAssetPath } from "@mayflowergmbh/wasmsh-pyodide";

import { WasmshSandbox } from "./sandbox.js";

const assetsAvailable = existsSync(resolveAssetPath("pyodide.asm.wasm"));

sandboxStandardTests({
  name: "WasmshSandbox",
  skip: !assetsAvailable,
  timeout: 60_000,
  sequential: true,
  createSandbox: async (options) =>
    WasmshSandbox.createNode({
      initialFiles: options?.initialFiles,
      workingDirectory: "/workspace",
    }),
  closeSandbox: (sandbox) => sandbox.stop(),
  resolvePath: (name) => `/workspace/${name}`,
});
