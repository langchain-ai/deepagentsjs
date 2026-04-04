/* eslint-disable no-console */
import { WasmshSandbox } from "@langchain/wasmsh";

async function main() {
  const sandbox = await WasmshSandbox.createBrowserWorker({
    assetBaseUrl: "/node_modules/wasmsh-pyodide/assets",
  });

  try {
    const result = await sandbox.execute(
      "python3 -c \"print('hello from browser worker')\"",
    );
    console.log(result.output.trim());
  } finally {
    await sandbox.stop();
  }
}

void main();
