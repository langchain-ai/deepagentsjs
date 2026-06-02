# @langchain/node-vfs

Node.js Virtual File System backend for [DeepAgents](https://github.com/langchain-ai/deepagentsjs).

This package provides an in-memory VFS implementation that enables agents to work with files in an isolated environment without touching the real filesystem. It uses [node-vfs-polyfill](https://github.com/vercel-labs/node-vfs-polyfill) which implements the upcoming Node.js VFS feature ([nodejs/node#61478](https://github.com/nodejs/node/pull/61478)).

## Installation

```bash
npm install @langchain/node-vfs deepagents
# or
pnpm add @langchain/node-vfs deepagents
```

## Quick Start

```typescript
import { VfsBackend } from "@langchain/node-vfs";
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";

// Create and initialize a VFS backend
const backend = await VfsBackend.create({
  initialFiles: {
    "/src/index.js": "console.log('Hello from VFS!')",
  },
});

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
    systemPrompt: "You are a coding assistant with VFS access.",
    backend,
  });

  const result = await agent.invoke({
    messages: [{ role: "user", content: "Run the index.js file" }],
  });
} finally {
  await backend.stop();
}
```

## Features

- **In-Memory File Storage** - Files are stored in a virtual file system using [node-vfs-polyfill](https://github.com/vercel-labs/node-vfs-polyfill)
- **Zero Setup** - No Docker, cloud services, or external dependencies required
- **Native File Tools** - `read`, `ls`, `grep`, and `glob` run directly against VFS data
- **Automatic Cleanup** - All resources are cleaned up when the backend stops
- **Initial Files** - Pre-populate the backend with files at creation time
- **Path Confinement** - File operations are constrained to the virtual workspace root

## API Reference

### VfsBackend (`BackendProtocolV2`)

The main class for creating and managing the in-memory VFS backend.

#### Static Methods

##### `VfsBackend.create(options?)`

Create and initialize a new VFS backend in one step.

```typescript
const backend = await VfsBackend.create({
  mountPath: "/vfs", // Mount path for the VFS (default: "/vfs")
  initialFiles: {
    // Initial files to populate
    "/README.md": "# Hello",
    "/src/index.js": "console.log('Hello')",
  },
});
```

#### Instance Methods

##### `backend.uploadFiles(files)`

Upload files to the backend.

```typescript
const encoder = new TextEncoder();
await backend.uploadFiles([
  ["src/app.js", encoder.encode("console.log('Hi')")],
  ["package.json", encoder.encode('{"name": "test"}')],
]);
```

##### `backend.downloadFiles(paths)`

Download files from the backend.

```typescript
const results = await backend.downloadFiles(["src/app.js"]);
for (const result of results) {
  if (result.content) {
    console.log(new TextDecoder().decode(result.content));
  }
}
```

##### `backend.stop()`

Stop the backend and clean up resources.

```typescript
await backend.stop();
```

### Factory Functions

#### `createVfsBackendFactory(options?)`

Create an async factory that creates new backend instances per invocation.

```typescript
const factory = createVfsBackendFactory({
  initialFiles: { "/README.md": "# Hello" },
});

const backend = await factory();
```

#### `createVfsBackendFactoryFromBackend(backend)`

Create a factory that reuses an existing backend.

```typescript
const backend = await VfsBackend.create();
const factory = createVfsBackendFactoryFromBackend(backend);
```

## Configuration Options

| Option         | Type                                   | Default     | Description                               |
| -------------- | -------------------------------------- | ----------- | ----------------------------------------- |
| `mountPath`    | `string`                               | `"/vfs"`    | Mount path for the virtual file system    |
| `initialFiles` | `Record<string, string \| Uint8Array>` | `undefined` | Initial files to populate the VFS         |

## Error Handling

The package exports a `VfsSandboxError` class for typed error handling:

```typescript
import { VfsSandboxError } from "@langchain/node-vfs";

try {
  const result = await backend.read("/src/index.js");
  if (result.error) {
    throw new Error(result.error);
  }
} catch (error) {
  if (error instanceof VfsSandboxError) {
    switch (error.code) {
      case "NOT_INITIALIZED":
        // Handle uninitialized backend
        break;
      case "FILE_OPERATION_FAILED":
        // Handle file operation failures
        break;
    }
  }
}
```

### Error Codes

- `NOT_INITIALIZED` - Backend not initialized
- `ALREADY_INITIALIZED` - Backend already initialized
- `INITIALIZATION_FAILED` - Failed to initialize VFS
- `FILE_OPERATION_FAILED` - File operation failed
- `NOT_SUPPORTED` - VFS not supported in environment

## How It Works

The VFS backend is fully in-memory:

1. **File Storage** - Files are stored in-memory using the `VirtualFileSystem` from [node-vfs-polyfill](https://github.com/vercel-labs/node-vfs-polyfill)
2. **File Operations** - `read`, `ls`, `grep`, and `glob` operate directly on VFS paths
3. **Isolation** - Paths are confined under the virtual workspace root

This approach keeps filesystem operations isolated and avoids host shell execution from this provider.


## Future: Native Node.js VFS

This package uses [node-vfs-polyfill](https://github.com/vercel-labs/node-vfs-polyfill) which implements the upcoming Node.js VFS feature being developed in [nodejs/node#61478](https://github.com/nodejs/node/pull/61478).

When the official `node:vfs` module lands in Node.js, this package will be updated to use the native implementation for better performance and compatibility.

## License

MIT
