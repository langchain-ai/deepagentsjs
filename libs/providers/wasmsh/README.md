# @langchain/wasmsh

Wasmsh sandbox provider for [Deep Agents](https://github.com/langchain-ai/deepagentsjs).
Runs bash and Python 3 inside an in-process Pyodide/WASM sandbox — no container
or cloud service required.

## Getting started

### Install

```bash
pnpm add @langchain/wasmsh deepagents
```

Requires Node.js 20+.

### Create an agent with a wasmsh sandbox

```typescript
import { createDeepAgent } from "deepagents";
import { WasmshSandbox } from "@langchain/wasmsh";

const sandbox = await WasmshSandbox.createNode();

try {
  const agent = createDeepAgent({
    model: "claude-sonnet-4-5-20250929",
    systemPrompt: "You are a coding assistant with bash and Python access.",
    backend: sandbox,
  });

  const result = await agent.invoke({
    messages: [{ role: "user", content: "Write a Python script that computes fibonacci(10) and save it to fib.py, then run it." }],
  });

  console.log(result.messages.at(-1)?.content);
} finally {
  await sandbox.stop();
}
```

The agent automatically gets `execute`, `read_file`, `write_file`, `edit_file`,
`ls`, `glob`, and `grep` tools — all routed through the sandbox.

## How-to guides

### Seed files before the agent runs

Pass `initialFiles` to pre-populate `/workspace`:

```typescript
const sandbox = await WasmshSandbox.createNode({
  initialFiles: {
    "/workspace/data.csv": "name,score\nalice,95\nbob,87\n",
    "/workspace/config.json": JSON.stringify({ threshold: 90 }),
  },
});
```

Both string and `Uint8Array` values are accepted.

### Retrieve files after execution

Use `downloadFiles` to pull artifacts out of the sandbox:

```typescript
const results = await sandbox.downloadFiles(["/workspace/report.txt"]);
if (results[0].error === null) {
  const text = new TextDecoder().decode(results[0].content!);
  console.log(text);
}
```

### Upload files at runtime

```typescript
const encoder = new TextEncoder();
await sandbox.uploadFiles([
  ["/workspace/input.txt", encoder.encode("new data")],
]);
```

### Use a custom working directory

By default, all commands run relative to `/workspace`. Override this:

```typescript
const sandbox = await WasmshSandbox.createNode({
  workingDirectory: "/home/user",
});
```

### Run in a browser Web Worker

Browser support uses a Web Worker to isolate the WASM runtime from the main
thread:

```typescript
const sandbox = await WasmshSandbox.createBrowserWorker({
  assetBaseUrl: "/node_modules/wasmsh-pyodide/assets",
});

try {
  const result = await sandbox.execute("python3 -c \"print('hello')\"");
  console.log(result.output);
} finally {
  await sandbox.stop();
}
```

Main-thread execution is not supported in v1.

## Reference

### `WasmshSandbox.createNode(options?): Promise<WasmshSandbox>`

Create a sandbox backed by a local Node.js host process.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `distPath` | `string` | auto-resolved | Path to Pyodide distribution assets |
| `stepBudget` | `number` | `0` (unlimited) | VM step budget per command |
| `initialFiles` | `Record<string, string \| Uint8Array>` | `undefined` | Files to seed at creation |
| `workingDirectory` | `string` | `"/workspace"` | Working directory for `execute()` |
| `allowedHosts` | `string[]` | `[]` (deny all) | Hostnames allowed for network access |

### `WasmshSandbox.createBrowserWorker(options): Promise<WasmshSandbox>`

Create a sandbox backed by a browser Web Worker.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `assetBaseUrl` | `string` | **(required)** | URL prefix for Pyodide assets |
| `worker` | `Worker` | auto-created | Pre-existing Worker instance |
| `stepBudget` | `number` | `0` (unlimited) | VM step budget per command |
| `initialFiles` | `Record<string, string \| Uint8Array>` | `undefined` | Files to seed at creation |
| `workingDirectory` | `string` | `"/workspace"` | Working directory for `execute()` |

### Instance properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique sandbox identifier (e.g., `wasmsh-node-1711641600000`) |
| `isRunning` | `boolean` | `true` while the session is active |

### Instance methods

| Method | Returns | Description |
|--------|---------|-------------|
| `execute(command)` | `Promise<ExecuteResponse>` | Run a shell command (prepends `cd /workspace &&`) |
| `uploadFiles(files)` | `Promise<FileUploadResponse[]>` | Write files into the sandbox |
| `downloadFiles(paths)` | `Promise<FileDownloadResponse[]>` | Read files from the sandbox |
| `stop()` | `Promise<void>` | Shut down the session |
| `close()` | `Promise<void>` | Alias for `stop()` |
| `initialize()` | `Promise<void>` | Explicit init (called automatically by `createNode`/`createBrowserWorker`) |

### Inherited from `BaseSandbox`

These methods are implemented via `execute()` — no additional setup required:

`read`, `write`, `edit`, `lsInfo`, `grepRaw`, `globInfo`

### Error mapping

Diagnostic events from the wasmsh runtime are mapped to `FileOperationError`:

| Diagnostic contains | Mapped to |
|---------------------|-----------|
| `"not found"` | `"file_not_found"` |
| `"directory"` | `"is_directory"` |
| `"permission"` | `"permission_denied"` |
| *(other)* | `"invalid_path"` |

## Explanation

### What runs inside the sandbox

The wasmsh runtime provides 86 shell utilities (including `jq`, `awk`, `rg`,
`fd`, `diff`, `tar`, `gzip`) plus `python`/`python3` via an embedded CPython
interpreter. Both share the same Emscripten POSIX filesystem.

This is **not** a Linux container. There is no kernel, no process isolation, no
`apt`, `pip`, or `docker`. If you need a full OS environment, use a container-based
provider like `@langchain/modal` or `@langchain/daytona`.

### How the agent uses the sandbox

When you pass a `WasmshSandbox` as the `backend` to `createDeepAgent`, the agent
gains access to filesystem tools (`read`, `write`, `edit`, `ls`, `glob`, `grep`)
and a shell `execute` tool. All of these route through the sandbox:

- **Filesystem tools** (`read_file`, `write_file`, `edit_file`, `ls`, `glob`,
  `grep`) are implemented by `BaseSandbox` using POSIX shell commands via
  `execute()`. No direct file I/O — everything flows through the sandbox.
- **`execute()`** prepends `cd /workspace &&` to every command, ensuring all
  operations happen relative to the sandbox root.
- **`initialFiles`** are written during sandbox creation via the wasmsh `WriteFile`
  protocol command before any agent code runs.

### Node vs browser architecture

- **Node**: `WasmshSandbox` spawns a child process that boots the Pyodide/Emscripten
  module. Communication is JSON-RPC over stdin/stdout.
- **Browser**: `WasmshSandbox` creates a Web Worker that loads the Pyodide WASM
  module. Communication is JSON-RPC over `postMessage`.

Both modes use the same wasmsh protocol and produce identical results.
