# @langchain/deno-sandbox

Deno Sandbox backend for [deepagents](https://www.npmjs.com/package/deepagents). This package provides a `DenoSandbox` implementation of the `SandboxBackendProtocol`, enabling agents to execute commands, read/write files, and manage isolated Linux microVM environments using Deno Deploy's Sandbox infrastructure.

[![npm version](https://img.shields.io/npm/v/@langchain/deno-sandbox.svg)](https://www.npmjs.com/package/@langchain/deno-sandbox)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Isolated Execution**: Run commands in secure, isolated Linux microVMs
- **File Operations**: Upload and download files with full filesystem access
- **BaseSandbox Integration**: All inherited methods (`read`, `write`, `edit`, `ls`, `grep`, `glob`) work out of the box
- **Factory Pattern**: Compatible with deepagents' middleware architecture
- **Full SDK Access**: Access the underlying Deno SDK via the `sandbox` property for advanced features

## Installation

```bash
# npm
npm install @langchain/deno-sandbox

# yarn
yarn add @langchain/deno-sandbox

# pnpm
pnpm add @langchain/deno-sandbox
```

## Authentication Setup

The package requires Deno Deploy authentication:

### Environment Variable (Recommended)

1. Go to [https://app.deno.com](https://app.deno.com)
2. Navigate to Settings → Organization Tokens
3. Create a new token and set it as an environment variable:

```bash
export DENO_DEPLOY_TOKEN=your_token_here
```

### Explicit Token in Code

```typescript
const sandbox = await DenoSandbox.create({
  auth: { token: "your-token-here" },
});
```

## Basic Usage

```typescript
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { DenoSandbox } from "@langchain/deno-sandbox";

// Create and initialize the sandbox
const sandbox = await DenoSandbox.create({
  memoryMb: 1024,
  lifetime: "10m",
});

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
    systemPrompt: "You are a coding assistant with access to a sandbox.",
    backend: sandbox,
  });

  const result = await agent.invoke({
    messages: [
      { role: "user", content: "Create a hello world Deno app and run it" },
    ],
  });
} finally {
  await sandbox.close();
}
```

## Configuration Options

```typescript
interface DenoSandboxOptions {
  /**
   * Memory allocation in megabytes.
   * Min: 768MB, Max: 4096MB
   * @default 768
   */
  memoryMb?: number;

  /**
   * Sandbox lifetime.
   * - "session": Shuts down when you close the client (default)
   * - Duration: e.g., "5m", "30s"
   */
  lifetime?: "session" | `${number}s` | `${number}m`;

  /**
   * Region where the sandbox will be created.
   * If not specified, uses the default region.
   */
  region?: DenoSandboxRegion;

  /**
   * Working directory for command execution.
   * @default "/home/sandbox"
   */
  cwd?: string;

  /**
   * Authentication configuration.
   */
  auth?: {
    token?: string;
  };
}
```

## Available Regions

The sandbox can be deployed in the following regions:

| Region Code | Location  |
| ----------- | --------- |
| `ams`       | Amsterdam |
| `ord`       | Chicago   |

## Accessing the Deno SDK

For advanced features not exposed by `BaseSandbox`, you can access the underlying Deno SDK directly via the `sandbox` property:

```typescript
const denoSandbox = await DenoSandbox.create();

// Access the raw Deno SDK
const sdk = denoSandbox.sandbox;

// Use any Deno SDK feature directly
const url = await sdk.exposeHttp({ port: 3000 });
const ssh = await sdk.exposeSsh();
const result = await sdk.eval("1 + 2");
await sdk.env.set("API_KEY", "secret");

// Use shell template literals
const output = await sdk.sh`echo "Hello from Deno!"`.text();

// Start a JavaScript runtime
const runtime = await sdk.createJsRuntime({ entrypoint: "server.ts" });
```

See the [@deno/sandbox documentation](https://www.npmjs.com/package/@deno/sandbox) for all available SDK methods.

## Factory Functions

### Creating New Sandboxes Per Invocation

```typescript
import { createDenoSandboxFactory } from "@langchain/deno-sandbox";

// Each call creates a new sandbox
const factory = createDenoSandboxFactory({ memoryMb: 1024 });

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
  DenoSandbox,
  createDenoSandboxFactoryFromSandbox,
} from "@langchain/deno-sandbox";

// Create and initialize a sandbox
const sandbox = await DenoSandbox.create({ memoryMb: 1024 });

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
    systemPrompt: "You are a coding assistant.",
    middlewares: [
      createFilesystemMiddleware({
        backend: createDenoSandboxFactoryFromSandbox(sandbox),
      }),
    ],
  });

  await agent.invoke({ messages: [...] });
} finally {
  await sandbox.close();
}
```

## Reconnecting to Existing Sandboxes

Resume working with a sandbox that has a duration-based lifetime:

```typescript
// First session: create with duration lifetime
const sandbox = await DenoSandbox.create({
  memoryMb: 1024,
  lifetime: "30m",
});
const sandboxId = sandbox.id;
await sandbox.close(); // Close connection, but sandbox keeps running

// Later: reconnect to the same sandbox
const reconnected = await DenoSandbox.connect(sandboxId);
const result = await reconnected.execute("ls -la");
```

## Error Handling

```typescript
import { DenoSandboxError } from "@langchain/deno-sandbox";

try {
  await sandbox.execute("some command");
} catch (error) {
  if (error instanceof DenoSandboxError) {
    switch (error.code) {
      case "NOT_INITIALIZED":
        await sandbox.initialize();
        break;
      case "COMMAND_TIMEOUT":
        console.error("Command took too long");
        break;
      case "AUTHENTICATION_FAILED":
        console.error("Check your Deno Deploy token");
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
| `AUTHENTICATION_FAILED`   | Invalid or missing Deno Deploy token        |
| `SANDBOX_CREATION_FAILED` | Failed to create sandbox                    |
| `SANDBOX_NOT_FOUND`       | Sandbox ID not found or expired             |
| `COMMAND_TIMEOUT`         | Command execution timed out                 |
| `COMMAND_FAILED`          | Command execution failed                    |
| `FILE_OPERATION_FAILED`   | File read/write failed                      |
| `RESOURCE_LIMIT_EXCEEDED` | CPU, memory, or storage limits exceeded     |

## Inherited BaseSandbox Methods

`DenoSandbox` extends `BaseSandbox` and inherits these convenience methods:

| Method       | Description                   |
| ------------ | ----------------------------- |
| `read()`     | Read a file's contents        |
| `write()`    | Write content to a file       |
| `edit()`     | Replace text in a file        |
| `lsInfo()`   | List directory contents       |
| `grepRaw()`  | Search for patterns in files  |
| `globInfo()` | Find files matching a pattern |

## Limits and Constraints

| Constraint           | Value             |
| -------------------- | ----------------- |
| Minimum memory       | 768 MB            |
| Maximum memory       | 4096 MB (4 GB)    |
| Disk space           | 10 GB             |
| vCPUs                | 2                 |
| Working directory    | `/home/sandbox`   |
| Network access       | Full (by default) |
| Interactive commands | Not supported     |

## Environment Variables

| Variable            | Description                           |
| ------------------- | ------------------------------------- |
| `DENO_DEPLOY_TOKEN` | Deno Deploy organization access token |

## License

MIT
