# @langchain/modal

Modal Sandbox backend for [deepagents](https://www.npmjs.com/package/deepagents). This package provides a `ModalSandbox` implementation of the `SandboxBackendProtocol`, enabling agents to execute commands, read/write files, and manage isolated container environments using Modal's serverless infrastructure.

[![npm version](https://img.shields.io/npm/v/@langchain/modal.svg)](https://www.npmjs.com/package/@langchain/modal)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Isolated Execution**: Run commands in secure, isolated containers on Modal's serverless infrastructure
- **GPU Support**: Access NVIDIA GPUs (T4, L4, A10G, A100, H100) for ML/AI workloads
- **Custom Images**: Use any Docker image from public registries
- **File Operations**: Upload and download files with full filesystem access
- **Volume Mounts**: Mount Modal Volumes for persistent storage
- **Secrets Injection**: Securely inject Modal Secrets as environment variables
- **BaseSandbox Integration**: All inherited methods (`read`, `write`, `edit`, `ls`, `grep`, `glob`) work out of the box
- **Factory Pattern**: Compatible with deepagents' middleware architecture
- **Full SDK Access**: Access the underlying Modal SDK via the `sandbox` property for advanced features

## Installation

```bash
# npm
npm install @langchain/modal

# yarn
yarn add @langchain/modal

# pnpm
pnpm add @langchain/modal
```

## Authentication Setup

The package requires Modal authentication:

### Environment Variables (Recommended)

1. Go to [https://modal.com/settings/tokens](https://modal.com/settings/tokens)
2. Create a new token and set the environment variables:

```bash
export MODAL_TOKEN_ID=your_token_id
export MODAL_TOKEN_SECRET=your_token_secret
```

### Explicit Credentials in Code

```typescript
const sandbox = await ModalSandbox.create({
  auth: {
    tokenId: "your-token-id",
    tokenSecret: "your-token-secret",
  },
});
```

## Basic Usage

```typescript
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { ModalSandbox } from "@langchain/modal";

// Create and initialize the sandbox
const sandbox = await ModalSandbox.create({
  imageName: "python:3.12-slim",
  timeoutMs: 600_000, // 10 minutes
});

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
    systemPrompt: "You are a coding assistant with access to a sandbox.",
    backend: sandbox,
  });

  const result = await agent.invoke({
    messages: [
      { role: "user", content: "Create a hello world Python app and run it" },
    ],
  });
} finally {
  await sandbox.close();
}
```

## Configuration Options

`ModalSandboxOptions` extends the Modal SDK's `SandboxCreateParams` directly, so you can use any SDK option. We only wrap `volumes` and `secrets` to accept names instead of objects.

```typescript
interface ModalSandboxOptions extends SandboxCreateParams {
  /** Modal App name. @default "deepagents-sandbox" */
  appName?: string;

  /** Docker image to use. @default "alpine:3.21" */
  imageName?: string;

  /** Initial files to populate the sandbox with. */
  initialFiles?: Record<string, string | Uint8Array>;

  /** Authentication credentials (or use env vars). */
  auth?: { tokenId?: string; tokenSecret?: string };

  /** Modal Volume names to mount (keys are mount paths). */
  volumes?: Record<string, string>;

  /** Modal Secret names to inject. */
  secrets?: string[];

  // All SandboxCreateParams options are available:
  timeoutMs?: number; // Max lifetime in milliseconds
  idleTimeoutMs?: number; // Idle timeout in milliseconds
  workdir?: string; // Working directory
  gpu?: string; // GPU type (e.g., "T4", "A100")
  cpu?: number; // CPU cores (fractional allowed)
  memoryMiB?: number; // Memory in MiB
  regions?: string[]; // Regions to run in
  env?: Record<string, string>; // Environment variables
  blockNetwork?: boolean; // Block network access
  cidrAllowlist?: string[]; // Allowed CIDRs
  verbose?: boolean; // Enable verbose logging
  name?: string; // Sandbox name (unique within app)
}
```

## GPU Support

Modal supports various NVIDIA GPUs for ML/AI workloads:

```typescript
const sandbox = await ModalSandbox.create({
  imageName: "python:3.12-slim",
  gpu: "T4", // NVIDIA T4 (16GB VRAM)
  // gpu: "L4",    // NVIDIA L4 (24GB VRAM)
  // gpu: "A10G",  // NVIDIA A10G (24GB VRAM)
  // gpu: "A100",  // NVIDIA A100 (40/80GB VRAM)
  // gpu: "H100",  // NVIDIA H100 (80GB VRAM)
});
```

## Using Volumes

Mount Modal Volumes for persistent storage:

```typescript
// Volume must be created in Modal first
const sandbox = await ModalSandbox.create({
  imageName: "python:3.12-slim",
  volumes: {
    "/data": "my-data-volume",
    "/models": "my-models-volume",
  },
});

// Files in /data and /models persist across sandbox restarts
await sandbox.execute("echo 'Hello' > /data/test.txt");
```

## Using Secrets

Inject Modal Secrets as environment variables:

```typescript
// Secrets must be created in Modal first
const sandbox = await ModalSandbox.create({
  imageName: "python:3.12-slim",
  secrets: ["my-api-keys", "database-credentials"],
});

// Secrets are available as environment variables
await sandbox.execute("echo $API_KEY");
```

## Initial Files

Pre-populate the sandbox with files during creation:

```typescript
const sandbox = await ModalSandbox.create({
  imageName: "python:3.12-slim",
  initialFiles: {
    // String content
    "/app/main.py": `
import json

def main():
    print("Hello from Python!")

if __name__ == "__main__":
    main()
`,
    // JSON configuration
    "/app/config.json": JSON.stringify(
      { name: "my-app", version: "1.0.0" },
      null,
      2,
    ),

    // Uint8Array content also supported
    "/app/data.bin": new Uint8Array([0x00, 0x01, 0x02]),
  },
});

// Files are ready to use immediately
const result = await sandbox.execute("python /app/main.py");
console.log(result.output); // "Hello from Python!"
```

This is especially useful for:

- Setting up project scaffolding before agent execution
- Providing configuration files
- Pre-loading test data or fixtures
- Creating initial source code files

## Accessing the Modal SDK

For advanced features not exposed by `BaseSandbox`, you can access the underlying Modal SDK directly:

- `.client` - The `ModalClient` instance for accessing other Modal resources
- `.instance` - The `Sandbox` instance for direct sandbox operations

```typescript
const modalSandbox = await ModalSandbox.create();

// Access the Modal client for other Modal resources
const client = modalSandbox.client;

// Access the raw Modal Sandbox for direct operations
const instance = modalSandbox.instance;

// Execute commands with specific options
const process = await instance.exec(["python", "-c", "print('Hello')"], {
  stdout: "pipe",
  stderr: "pipe",
});

// Open files for reading/writing
const writeHandle = await instance.open("/tmp/file.txt", "w");
await writeHandle.write(new TextEncoder().encode("Hello"));
await writeHandle.close();
```

## Reconnecting to Existing Sandboxes

Resume working with a sandbox that is still running:

```typescript
// First session: create a sandbox
const sandbox = await ModalSandbox.create({
  imageName: "python:3.12-slim",
  timeout: 3600, // 1 hour
});
const sandboxId = sandbox.id;

// Later: reconnect to the same sandbox by ID
const reconnected = await ModalSandbox.fromId(sandboxId);
const result = await reconnected.execute("ls -la");

// Or reconnect by name (if sandbox has a name)
const sandbox2 = await ModalSandbox.create({
  appName: "my-app",
  sandboxName: "my-sandbox",
  imageName: "python:3.12-slim",
});

const reconnected2 = await ModalSandbox.fromName("my-app", "my-sandbox");
```

## Error Handling

```typescript
import { ModalSandboxError } from "@langchain/modal";

try {
  await sandbox.execute("some command");
} catch (error) {
  if (error instanceof ModalSandboxError) {
    switch (error.code) {
      case "NOT_INITIALIZED":
        await sandbox.initialize();
        break;
      case "COMMAND_TIMEOUT":
        console.error("Command took too long");
        break;
      case "AUTHENTICATION_FAILED":
        console.error("Check your Modal token credentials");
        break;
      default:
        throw error;
    }
  }
}
```

### Error Codes

| Code                      | Description                                 |
| ------------------------- | ------------------------------------------- |
| `NOT_INITIALIZED`         | Sandbox not initialized - call initialize() |
| `ALREADY_INITIALIZED`     | Cannot initialize twice                     |
| `AUTHENTICATION_FAILED`   | Invalid or missing Modal tokens             |
| `SANDBOX_CREATION_FAILED` | Failed to create sandbox                    |
| `SANDBOX_NOT_FOUND`       | Sandbox ID/name not found or expired        |
| `COMMAND_TIMEOUT`         | Command execution timed out                 |
| `COMMAND_FAILED`          | Command execution failed                    |
| `FILE_OPERATION_FAILED`   | File read/write failed                      |
| `RESOURCE_LIMIT_EXCEEDED` | CPU, memory, or storage limits exceeded     |
| `VOLUME_ERROR`            | Volume operation failed                     |

## Inherited BaseSandbox Methods

`ModalSandbox` extends `BaseSandbox` and inherits these convenience methods:

| Method       | Description                   |
| ------------ | ----------------------------- |
| `read()`     | Read a file's contents        |
| `write()`    | Write content to a file       |
| `edit()`     | Replace text in a file        |
| `lsInfo()`   | List directory contents       |
| `grepRaw()`  | Search for patterns in files  |
| `globInfo()` | Find files matching a pattern |

## Limits and Constraints

| Constraint      | Value                                   |
| --------------- | --------------------------------------- |
| Max timeout     | 86400 seconds (24 hours)                |
| Default timeout | 300 seconds (5 minutes)                 |
| Network access  | Full (by default, can be blocked)       |
| File API        | Alpha (up to 100 MiB read, 1 GiB write) |

## Environment Variables

| Variable             | Description            |
| -------------------- | ---------------------- |
| `MODAL_TOKEN_ID`     | Modal API token ID     |
| `MODAL_TOKEN_SECRET` | Modal API token secret |

## License

MIT
