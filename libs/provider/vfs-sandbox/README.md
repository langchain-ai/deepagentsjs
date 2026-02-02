# @langchain/vfs-sandbox

Node.js Virtual File System backend for [DeepAgents](https://github.com/langchain-ai/deepagentsjs).

This package provides an in-memory VFS implementation that enables agents to work with files in an isolated environment without touching the real filesystem. It uses [node-vfs-polyfill](https://github.com/vercel-labs/node-vfs-polyfill) which implements the upcoming Node.js VFS feature ([nodejs/node#61478](https://github.com/nodejs/node/pull/61478)).

## Installation

```bash
npm install @langchain/vfs-sandbox deepagents
# or
pnpm add @langchain/vfs-sandbox deepagents
```

## Quick Start

```typescript
import { VfsSandbox } from "@langchain/vfs-sandbox";
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";

// Create and initialize a VFS sandbox
const sandbox = await VfsSandbox.create({
  initialFiles: {
    "/src/index.js": "console.log('Hello from VFS!')",
  },
});

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
    systemPrompt: "You are a coding assistant with VFS access.",
    backend: sandbox,
  });

  const result = await agent.invoke({
    messages: [{ role: "user", content: "Run the index.js file" }],
  });
} finally {
  await sandbox.stop();
}
```

## Features

- **In-Memory File Storage** - Files are stored in a virtual file system using [node-vfs-polyfill](https://github.com/vercel-labs/node-vfs-polyfill)
- **Zero Setup** - No Docker, cloud services, or external dependencies required
- **Full Command Execution** - Execute shell commands with automatic file syncing
- **Automatic Cleanup** - All resources are cleaned up when sandbox stops
- **Initial Files** - Pre-populate the sandbox with files at creation time
- **Fallback Mode** - Automatically falls back to temp directory if VFS is unavailable

## API Reference

### VfsSandbox

The main class for creating and managing VFS sandboxes.

#### Static Methods

##### `VfsSandbox.create(options?)`

Create and initialize a new VFS sandbox in one step.

```typescript
const sandbox = await VfsSandbox.create({
  mountPath: "/vfs",           // Mount path for the VFS (default: "/vfs")
  timeout: 30000,              // Command timeout in ms (default: 30000)
  initialFiles: {              // Initial files to populate
    "/README.md": "# Hello",
    "/src/index.js": "console.log('Hello')",
  },
});
```

#### Instance Methods

##### `sandbox.execute(command)`

Execute a shell command in the sandbox.

```typescript
const result = await sandbox.execute("node src/index.js");
console.log(result.output);    // Command output
console.log(result.exitCode);  // Exit code (0 = success)
```

##### `sandbox.uploadFiles(files)`

Upload files to the sandbox.

```typescript
const encoder = new TextEncoder();
await sandbox.uploadFiles([
  ["src/app.js", encoder.encode("console.log('Hi')")],
  ["package.json", encoder.encode('{"name": "test"}')],
]);
```

##### `sandbox.downloadFiles(paths)`

Download files from the sandbox.

```typescript
const results = await sandbox.downloadFiles(["src/app.js"]);
for (const result of results) {
  if (result.content) {
    console.log(new TextDecoder().decode(result.content));
  }
}
```

##### `sandbox.stop()`

Stop the sandbox and clean up resources.

```typescript
await sandbox.stop();
```

### Factory Functions

#### `createVfsSandboxFactory(options?)`

Create an async factory that creates new sandboxes per invocation.

```typescript
const factory = createVfsSandboxFactory({
  initialFiles: { "/README.md": "# Hello" },
});

const sandbox = await factory();
```

#### `createVfsSandboxFactoryFromSandbox(sandbox)`

Create a factory that reuses an existing sandbox.

```typescript
const sandbox = await VfsSandbox.create();
const factory = createVfsSandboxFactoryFromSandbox(sandbox);
```

## Configuration Options

| Option         | Type                                   | Default     | Description                               |
| -------------- | -------------------------------------- | ----------- | ----------------------------------------- |
| `mountPath`    | `string`                               | `"/vfs"`    | Mount path for the virtual file system    |
| `timeout`      | `number`                               | `30000`     | Command execution timeout in milliseconds |
| `initialFiles` | `Record<string, string \| Uint8Array>` | `undefined` | Initial files to populate the VFS         |

## Error Handling

The package exports a `VfsSandboxError` class for typed error handling:

```typescript
import { VfsSandboxError } from "@langchain/vfs-sandbox";

try {
  await sandbox.execute("some-command");
} catch (error) {
  if (error instanceof VfsSandboxError) {
    switch (error.code) {
      case "NOT_INITIALIZED":
        // Handle uninitialized sandbox
        break;
      case "COMMAND_TIMEOUT":
        // Handle timeout
        break;
    }
  }
}
```

### Error Codes

- `NOT_INITIALIZED` - Sandbox not initialized
- `ALREADY_INITIALIZED` - Sandbox already initialized
- `INITIALIZATION_FAILED` - Failed to initialize VFS
- `COMMAND_TIMEOUT` - Command execution timed out
- `COMMAND_FAILED` - Command execution failed
- `FILE_OPERATION_FAILED` - File operation failed
- `NOT_SUPPORTED` - VFS not supported in environment

## How It Works

The VFS sandbox uses a hybrid approach for maximum compatibility:

1. **File Storage** - Files are stored in-memory using the `VirtualFileSystem` from [node-vfs-polyfill](https://github.com/vercel-labs/node-vfs-polyfill)
2. **Command Execution** - When executing commands, files are synced to a temp directory, the command runs, and changes are synced back to VFS
3. **Fallback Mode** - If node-vfs-polyfill is unavailable, falls back to using a temp directory for both storage and execution

This approach provides the benefits of in-memory storage (isolation, speed) while maintaining full shell command execution support.

## Future: Native Node.js VFS

This package uses [node-vfs-polyfill](https://github.com/vercel-labs/node-vfs-polyfill) which implements the upcoming Node.js VFS feature being developed in [nodejs/node#61478](https://github.com/nodejs/node/pull/61478).

When the official `node:vfs` module lands in Node.js, this package will be updated to use the native implementation for better performance and compatibility.

## License

MIT
