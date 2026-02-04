# @langchain/daytona

Daytona Sandbox backend for [deepagents](https://www.npmjs.com/package/deepagents). This package provides a `DaytonaSandbox` implementation of the `SandboxBackendProtocol`, enabling agents to execute commands, read/write files, and manage isolated sandbox environments using Daytona's infrastructure.

[![npm version](https://img.shields.io/npm/v/@langchain/daytona.svg)](https://www.npmjs.com/package/@langchain/daytona)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Isolated Execution**: Run commands in secure, isolated sandbox environments
- **Multi-Language Support**: TypeScript, JavaScript, and Python runtimes
- **File Operations**: Upload and download files with full filesystem access
- **BaseSandbox Integration**: All inherited methods (`read`, `write`, `edit`, `ls`, `grep`, `glob`) work out of the box
- **Factory Pattern**: Compatible with deepagents' middleware architecture
- **Full SDK Access**: Access the underlying Daytona SDK via the `sandbox` property for advanced features

## Installation

```bash
# npm
npm install @langchain/daytona

# yarn
yarn add @langchain/daytona

# pnpm
pnpm add @langchain/daytona
```

## Authentication Setup

The package requires Daytona API authentication:

### Environment Variable (Recommended)

1. Go to [https://app.daytona.io](https://app.daytona.io)
2. Create an account and get your API key
3. Set it as an environment variable:

```bash
export DAYTONA_API_KEY=your_api_key_here
```

### Explicit API Key in Code

```typescript
const sandbox = await DaytonaSandbox.create({
  auth: { apiKey: "your-api-key-here" },
});
```

## Basic Usage

```typescript
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { DaytonaSandbox } from "@langchain/daytona";

// Create and initialize the sandbox
const sandbox = await DaytonaSandbox.create({
  language: "typescript",
  timeout: 300, // 5 minutes
});

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
    systemPrompt: "You are a coding assistant with access to a sandbox.",
    backend: sandbox,
  });

  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content: "Create a hello world TypeScript app and run it",
      },
    ],
  });
} finally {
  await sandbox.close();
}
```

## Configuration Options

```typescript
interface DaytonaSandboxOptions {
  /**
   * Primary language for code execution.
   * @default "typescript"
   */
  language?: "typescript" | "python" | "javascript";

  /**
   * Environment variables to set in the sandbox.
   */
  envVars?: Record<string, string>;

  /**
   * Custom Docker image to use (e.g., "node:20", "python:3.12").
   * Required when you want to customize resources.
   */
  image?: string;

  /**
   * Snapshot name to use for the sandbox.
   * Cannot be used together with `image`.
   */
  snapshot?: string;

  /**
   * Resource allocation (only available when using `image`).
   */
  resources?: {
    cpu?: number; // Number of CPUs
    memory?: number; // Memory in GiB
    disk?: number; // Disk space in GiB
  };

  /**
   * Target region.
   * @default "us"
   */
  target?: "us" | "eu";

  /**
   * Auto-stop interval in minutes. Set to 0 to disable.
   * @default 15
   */
  autoStopInterval?: number;

  /**
   * Default timeout for command execution in seconds.
   * @default 300
   */
  timeout?: number;

  /**
   * Custom labels for the sandbox.
   */
  labels?: Record<string, string>;

  /**
   * Authentication configuration.
   */
  auth?: {
    apiKey?: string;
    apiUrl?: string;
  };
}
```

### Using Custom Resources

To customize CPU, memory, or disk, you must specify a Docker image:

```typescript
const sandbox = await DaytonaSandbox.create({
  image: "node:20",
  language: "typescript",
  resources: {
    cpu: 4,
    memory: 8,
    disk: 50,
  },
});
```

## Available Regions

| Region | Location      |
| ------ | ------------- |
| `us`   | United States |
| `eu`   | Europe        |

## Accessing the Daytona SDK

For advanced features not exposed by `BaseSandbox`, you can access the underlying Daytona SDK directly via the `sandbox` property:

```typescript
const daytonaSandbox = await DaytonaSandbox.create();

// Access the raw Daytona SDK
const sdk = daytonaSandbox.sandbox;

// Use any Daytona SDK feature directly
const workDir = await sdk.getWorkDir();
const homeDir = await sdk.getUserHomeDir();

// Execute code with the process interface
const result = await sdk.process.executeCommand("npm install");

// Use the filesystem interface
await sdk.fs.createFolder("src", "755");
await sdk.fs.uploadFile(Buffer.from("content"), "src/index.ts");
```

See the [@daytonaio/sdk documentation](https://www.npmjs.com/package/@daytonaio/sdk) for all available SDK methods.

## Factory Functions

### Creating New Sandboxes Per Invocation

```typescript
import { createDaytonaSandboxFactory } from "@langchain/daytona";

// Each call creates a new sandbox
const factory = createDaytonaSandboxFactory({ language: "typescript" });

const sandbox1 = await factory();
const sandbox2 = await factory();

try {
  // Use sandboxes...
} finally {
  await sandbox1.close();
  await sandbox2.close();
}
```

### Reusing an Existing Sandbox

```typescript
import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import {
  DaytonaSandbox,
  createDaytonaSandboxFactoryFromSandbox,
} from "@langchain/daytona";

// Create and initialize a sandbox
const sandbox = await DaytonaSandbox.create({ language: "typescript" });

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
    systemPrompt: "You are a coding assistant.",
    middlewares: [
      createFilesystemMiddleware({
        backend: createDaytonaSandboxFactoryFromSandbox(sandbox),
      }),
    ],
  });

  await agent.invoke({ messages: [...] });
} finally {
  await sandbox.close();
}
```

## Reconnecting to Existing Sandboxes

Resume working with a sandbox that is still running:

```typescript
// First session: create sandbox
const sandbox = await DaytonaSandbox.create({
  language: "typescript",
  autoStopInterval: 60, // Keep alive for 60 minutes of inactivity
});
const sandboxId = sandbox.id;

// Stop the sandbox (keeps it available)
await sandbox.stop();

// Later: reconnect to the same sandbox
const reconnected = await DaytonaSandbox.connect(sandboxId);
await reconnected.start(); // Restart the sandbox
const result = await reconnected.execute("ls -la");
```

## Sandbox Lifecycle

```typescript
const sandbox = await DaytonaSandbox.create();

// Stop sandbox (can be restarted)
await sandbox.stop();

// Start a stopped sandbox
await sandbox.start();

// Delete sandbox permanently
await sandbox.close();

// Or use kill() as an alias
await sandbox.kill();
```

## Error Handling

```typescript
import { DaytonaSandboxError } from "@langchain/daytona";

try {
  await sandbox.execute("some command");
} catch (error) {
  if (error instanceof DaytonaSandboxError) {
    switch (error.code) {
      case "NOT_INITIALIZED":
        await sandbox.initialize();
        break;
      case "COMMAND_TIMEOUT":
        console.error("Command took too long");
        break;
      case "AUTHENTICATION_FAILED":
        console.error("Check your Daytona API key");
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
| `AUTHENTICATION_FAILED`   | Invalid or missing Daytona API key          |
| `SANDBOX_CREATION_FAILED` | Failed to create sandbox                    |
| `SANDBOX_NOT_FOUND`       | Sandbox ID not found or deleted             |
| `SANDBOX_NOT_STARTED`     | Sandbox is not in started state             |
| `COMMAND_TIMEOUT`         | Command execution timed out                 |
| `COMMAND_FAILED`          | Command execution failed                    |
| `FILE_OPERATION_FAILED`   | File read/write failed                      |
| `RESOURCE_LIMIT_EXCEEDED` | CPU, memory, or storage limits exceeded     |

## Inherited BaseSandbox Methods

`DaytonaSandbox` extends `BaseSandbox` and inherits these convenience methods:

| Method       | Description                   |
| ------------ | ----------------------------- |
| `read()`     | Read a file's contents        |
| `write()`    | Write content to a file       |
| `edit()`     | Replace text in a file        |
| `lsInfo()`   | List directory contents       |
| `grepRaw()`  | Search for patterns in files  |
| `globInfo()` | Find files matching a pattern |

## Environment Variables

| Variable          | Description                   |
| ----------------- | ----------------------------- |
| `DAYTONA_API_KEY` | Daytona API key (required)    |
| `DAYTONA_API_URL` | Custom Daytona API URL        |
| `DAYTONA_TARGET`  | Default target region (us/eu) |

## License

MIT
