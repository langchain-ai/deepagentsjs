# @langchain/vercel-sandbox

Vercel Sandbox backend for [deepagents](https://www.npmjs.com/package/deepagents). This package provides a `VercelSandbox` implementation of the `SandboxBackendProtocol`, enabling agents to execute commands, read/write files, and manage isolated Linux microVM environments using Vercel's Sandbox infrastructure.

[![npm version](https://img.shields.io/npm/v/@langchain/vercel-sandbox.svg)](https://www.npmjs.com/package/@langchain/vercel-sandbox)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Isolated Execution**: Run commands in secure, isolated Linux microVMs
- **File Operations**: Upload and download files with full filesystem access
- **Snapshots**: Save and restore sandbox state for fast startup
- **Port Exposure**: Expose ports for web app development and preview
- **BaseSandbox Integration**: All inherited methods (`read`, `write`, `edit`, `ls`, `grep`, `glob`) work out of the box
- **Factory Pattern**: Compatible with deepagents' middleware architecture

## Installation

```bash
# npm
npm install @langchain/vercel-sandbox

# yarn
yarn add @langchain/vercel-sandbox

# pnpm
pnpm add @langchain/vercel-sandbox
```

## Authentication Setup

The package requires Vercel authentication. Choose one of the following methods:

### Option 1: Vercel OIDC Token (Recommended for Vercel deployments)

```bash
# Link your project to Vercel
vercel link

# Pull environment variables (creates .env.local with VERCEL_OIDC_TOKEN)
vercel env pull
```

### Option 2: Personal Access Token

Generate a token at https://vercel.com/account/tokens and set it as an environment variable:

```bash
export VERCEL_ACCESS_TOKEN=your_token_here
```

### Option 3: Explicit Token in Code

```typescript
const sandbox = await VercelSandbox.create({
  auth: { type: "oidc", token: "your-token-here" },
});
```

## Basic Usage

```typescript
import { VercelSandbox } from "@langchain/vercel-sandbox";

// Create and initialize a sandbox
const sandbox = await VercelSandbox.create({
  runtime: "node24",
  timeout: 600000, // 10 minutes
});

try {
  // Execute commands
  const result = await sandbox.execute("node --version");
  console.log(result.output); // v24.x.x
  console.log(result.exitCode); // 0

  // Write files
  await sandbox.write("/vercel/sandbox/hello.js", 'console.log("Hello!");');

  // Read files
  const content = await sandbox.read("/vercel/sandbox/hello.js");

  // Run your script
  const output = await sandbox.execute("node /vercel/sandbox/hello.js");
  console.log(output.output); // Hello!
} finally {
  // Always cleanup
  await sandbox.stop();
}
```

## Usage with DeepAgents

```typescript
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { VercelSandbox } from "@langchain/vercel-sandbox";

// Create and initialize the sandbox
const sandbox = await VercelSandbox.create({
  runtime: "node24",
  timeout: 600000,
});

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
    systemPrompt: "You are a coding assistant with access to a sandbox.",
    backend: sandbox,
  });

  const result = await agent.invoke({
    messages: [{ role: "user", content: "Create a hello world Node.js app and run it" }],
  });
} finally {
  await sandbox.stop();
}
```

## Configuration Options

```typescript
interface VercelSandboxOptions {
  /**
   * Runtime image to use.
   * @default "node24"
   */
  runtime?: "node24" | "node22" | "python3.13";

  /**
   * Source for sandbox initialization.
   * Supports git repos, tarballs, or snapshots.
   */
  source?: GitSource | TarballSource | SnapshotSource;

  /**
   * Ports to expose for public access.
   * Access via sandbox.domain(port).
   */
  ports?: number[];

  /**
   * Initial timeout in milliseconds.
   * @default 300000 (5 minutes)
   */
  timeout?: number;

  /**
   * Number of virtual CPUs.
   * Defaults to plan baseline.
   */
  vcpus?: number;

  /**
   * Authentication configuration.
   */
  auth?: {
    type: "oidc" | "access_token";
    token?: string;
  };
}
```

## Source Types

### Git Repository

Clone a repository into the sandbox on creation:

```typescript
const sandbox = await VercelSandbox.create({
  source: {
    type: "git",
    url: "https://github.com/user/repo.git",
    depth: 1, // Shallow clone for faster setup
    revision: "main", // Branch, tag, or commit SHA
  },
  runtime: "node24",
});
```

### Tarball

Extract a tarball into the sandbox:

```typescript
const sandbox = await VercelSandbox.create({
  source: {
    type: "tarball",
    url: "https://example.com/project.tar.gz",
  },
});
```

### Snapshot

Start from a previously saved snapshot for fast startup:

```typescript
const sandbox = await VercelSandbox.create({
  source: {
    type: "snapshot",
    snapshotId: "snap_abc123",
  },
});
```

## Snapshots

Snapshots capture the complete filesystem state and enable fast sandbox startup:

```typescript
// Create a sandbox and install dependencies
const sandbox = await VercelSandbox.create({ runtime: "node24" });
await sandbox.execute("npm install -g typescript tsx");

// Create a snapshot (sandbox stops after snapshotting)
const snapshot = await sandbox.snapshot();
console.log(`Snapshot ID: ${snapshot.snapshotId}`);
console.log(`Size: ${snapshot.sizeBytes} bytes`);
console.log(`Expires: ${snapshot.expiresAt.toISOString()}`);

// Later: Start from snapshot (dependencies already installed!)
const fastSandbox = await VercelSandbox.create({
  source: { type: "snapshot", snapshotId: snapshot.snapshotId },
});
```

**Note**: Snapshots expire after 7 days.

## Port Exposure

Expose ports for web application development:

```typescript
const sandbox = await VercelSandbox.create({
  runtime: "node24",
  ports: [3000],
});

// Start a dev server
await sandbox.execute("cd /vercel/sandbox && npx create-next-app my-app --yes");
await sandbox.execute("cd /vercel/sandbox/my-app && npm run dev &");

// Get the public URL
const url = sandbox.domain(3000);
console.log(`Preview available at: ${url}`);
```

## Factory Functions

### Creating New Sandboxes Per Invocation

```typescript
import { createVercelSandboxFactory } from "@langchain/vercel-sandbox";

// Each call creates a new sandbox
const factory = createVercelSandboxFactory({ runtime: "node24" });

const sandbox1 = await factory();
const sandbox2 = await factory();

try {
  // Use sandboxes...
} finally {
  await sandbox1.stop();
  await sandbox2.stop();
}
```

### Reusing an Existing Sandbox

```typescript
import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import {
  VercelSandbox,
  createVercelSandboxFactoryFromSandbox,
} from "@langchain/vercel-sandbox";

// Create and initialize a sandbox
const sandbox = await VercelSandbox.create({ runtime: "node24" });

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
    systemPrompt: "You are a coding assistant.",
    middlewares: [
      createFilesystemMiddleware({
        backend: createVercelSandboxFactoryFromSandbox(sandbox),
      }),
    ],
  });

  await agent.invoke({ messages: [...] });
} finally {
  await sandbox.stop();
}
```

## Reconnecting to Existing Sandboxes

Resume working with a sandbox from a different process:

```typescript
// Get the sandbox ID from somewhere (e.g., stored in database)
const sandboxId = "sandbox-abc123";

// Reconnect
const sandbox = await VercelSandbox.get(sandboxId);
const result = await sandbox.execute("ls -la");
```

## Extending Timeout

```typescript
const sandbox = await VercelSandbox.create({
  runtime: "node24",
  timeout: 300000, // 5 minutes
});

// Add 10 more minutes when needed
await sandbox.extendTimeout(600000);
```

## Error Handling

```typescript
import { VercelSandboxError } from "@langchain/vercel-sandbox";

try {
  await sandbox.execute("some command");
} catch (error) {
  if (error instanceof VercelSandboxError) {
    switch (error.code) {
      case "NOT_INITIALIZED":
        await sandbox.initialize();
        break;
      case "COMMAND_TIMEOUT":
        console.error("Command took too long");
        break;
      case "AUTHENTICATION_FAILED":
        console.error("Check your Vercel token");
        break;
      default:
        throw error;
    }
  }
}
```

### Error Codes

| Code                     | Description                                  |
| ------------------------ | -------------------------------------------- |
| `NOT_INITIALIZED`        | Sandbox not initialized - call initialize()  |
| `ALREADY_INITIALIZED`    | Cannot initialize twice                      |
| `AUTHENTICATION_FAILED`  | Invalid or missing Vercel token              |
| `SANDBOX_CREATION_FAILED`| Failed to create sandbox                     |
| `SANDBOX_NOT_FOUND`      | Sandbox ID not found or expired              |
| `COMMAND_TIMEOUT`        | Command execution timed out                  |
| `COMMAND_FAILED`         | Command execution failed                     |
| `FILE_OPERATION_FAILED`  | File read/write failed                       |
| `SNAPSHOT_FAILED`        | Snapshot creation failed                     |
| `RESOURCE_LIMIT_EXCEEDED`| CPU, memory, or storage limits exceeded      |

## Inherited BaseSandbox Methods

`VercelSandbox` extends `BaseSandbox` and inherits these convenience methods:

| Method     | Description                           |
| ---------- | ------------------------------------- |
| `read()`   | Read a file's contents                |
| `write()`  | Write content to a file               |
| `edit()`   | Replace text in a file                |
| `lsInfo()` | List directory contents               |
| `grepRaw()`| Search for patterns in files          |
| `globInfo()`| Find files matching a pattern        |

## Limits and Constraints

| Constraint              | Value                                      |
| ----------------------- | ------------------------------------------ |
| Max timeout (Hobby)     | 45 minutes                                 |
| Max timeout (Pro/Ent)   | 5 hours                                    |
| Snapshot expiration     | 7 days                                     |
| Available runtimes      | `node24`, `node22`, `python3.13`           |
| Working directory       | `/vercel/sandbox`                          |
| Network access          | Full (by default)                          |
| Interactive commands    | Not supported (no TTY)                     |

## Environment Variables

| Variable              | Description                                     |
| --------------------- | ----------------------------------------------- |
| `VERCEL_OIDC_TOKEN`   | Vercel OIDC token (set via `vercel env pull`)   |
| `VERCEL_ACCESS_TOKEN` | Alternative: Vercel personal access token       |

## API Reference

### VercelSandbox

```typescript
class VercelSandbox extends BaseSandbox {
  // Properties
  readonly id: string;
  readonly isRunning: boolean;
  readonly sandbox: Sandbox; // Raw Vercel SDK instance

  // Lifecycle
  constructor(options?: VercelSandboxOptions);
  initialize(): Promise<void>;
  stop(): Promise<void>;

  // Static factories
  static create(options?: VercelSandboxOptions): Promise<VercelSandbox>;
  static get(sandboxId: string, options?: Pick<VercelSandboxOptions, "auth">): Promise<VercelSandbox>;

  // Operations
  execute(command: string): Promise<ExecuteResponse>;
  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]>;
  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]>;

  // Sandbox features
  domain(port: number): string;
  extendTimeout(duration: number): Promise<void>;
  snapshot(): Promise<SnapshotInfo>;
}
```

## License

MIT
