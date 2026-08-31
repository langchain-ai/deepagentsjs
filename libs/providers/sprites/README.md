# @langchain/sprites

[Fly.io Sprites](https://fly.io/sprites) sandbox backend for [deepagents](https://www.npmjs.com/package/deepagents). This package provides a `SpritesSandbox` implementation of the `SandboxBackendProtocol`, enabling agents to execute commands, read/write files, and manage isolated sandbox environments using Fly.io's Sprites infrastructure.

[![npm version](https://img.shields.io/npm/v/@langchain/sprites.svg)](https://www.npmjs.com/package/@langchain/sprites)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Instant Creation**: Sprites are full Linux VMs that boot in 1-2 seconds
- **Persistent Sandboxes**: Named, stateful environments that suspend when idle (at no cost) and resume with all files and installed packages intact
- **Checkpoint & Restore**: Snapshot the full filesystem and process state, and roll back in seconds
- **File Operations**: Upload and download files with full filesystem access
- **BaseSandbox Integration**: All inherited methods (`read`, `write`, `edit`, `ls`, `grep`, `glob`) work out of the box
- **Factory Pattern**: Compatible with deepagents' middleware architecture
- **Full SDK Access**: Access the underlying [Sprites SDK](https://github.com/superfly/sprites-js) via the `instance` and `client` properties for advanced features (services, network policy, port proxying)

## Installation

```bash
# npm
npm install @langchain/sprites

# yarn
yarn add @langchain/sprites

# pnpm
pnpm add @langchain/sprites
```

## Authentication Setup

The package requires a Sprites API token:

### Environment Variable (Recommended)

1. Install the [Sprites CLI](https://docs.sprites.dev) and run `sprite login`
2. Create an API token
3. Set it as an environment variable:

```bash
export SPRITES_TOKEN=your_token_here
```

### Programmatic Configuration

```typescript
const sandbox = await SpritesSandbox.create({
  auth: { token: "your_token_here" },
});
```

## Usage

### Basic Sandbox Operations

```typescript
import { SpritesSandbox } from "@langchain/sprites";

const sandbox = await SpritesSandbox.create();

try {
  const result = await sandbox.execute("echo 'Hello from a Sprite'");
  console.log(result.output, result.exitCode);

  const encoder = new TextEncoder();
  await sandbox.uploadFiles([
    ["app/index.js", encoder.encode("console.log('hi')")],
  ]);
  const [file] = await sandbox.downloadFiles(["app/index.js"]);
} finally {
  await sandbox.close(); // deletes the Sprite
}
```

### With a Deep Agent

```typescript
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { SpritesSandbox } from "@langchain/sprites";

const sandbox = await SpritesSandbox.create();

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-5" }),
    systemPrompt: "You are a coding assistant with sandbox access.",
    backend: sandbox,
  });

  const result = await agent.invoke({
    messages: [
      { role: "user", content: "Create and run a hello world script" },
    ],
  });
} finally {
  await sandbox.close();
}
```

### Persistent Sandboxes

Sprites are named and persistent. If you don't call `close()`, the Sprite
suspends when idle and you can pick it up later — with all installed
packages, files, and state intact:

```typescript
// Day 1
const sandbox = await SpritesSandbox.create({ name: "my-agent-env" });
await sandbox.execute("npm install express");

// Day 2 — resumes in ~1 second
const sameSandbox = await SpritesSandbox.fromName("my-agent-env");
await sameSandbox.execute("node server.js");
```

### Checkpoint and Restore

Snapshot the full machine state before letting an agent loose, and roll back
if it goes sideways:

```typescript
const checkpoint = await sandbox.checkpoint("before agent run");

await agent.invoke({ messages: [...] });

// Didn't like the result? Roll everything back.
await sandbox.restore(checkpoint.id);
```

### Factories

```typescript
import {
  createSpritesSandboxFactory,
  createSpritesSandboxFactoryFromSandbox,
} from "@langchain/sprites";

// A fresh sandbox per invocation (async factory)
const factory = createSpritesSandboxFactory({ timeout: 300 });

// Reuse one sandbox across invocations (sync BackendFactory for middleware)
const backend = createSpritesSandboxFactoryFromSandbox(sandbox);
```

## Configuration

| Option            | Description                                        | Default                         |
| ----------------- | -------------------------------------------------- | ------------------------------- |
| `name`            | Sprite name (its persistent identity)              | generated `deepagents-<random>` |
| `config`          | Machine sizing: `{ ramMB, cpus, region, storageGB }` | API defaults                  |
| `environment`     | Environment variables set in the Sprite            | –                               |
| `labels`          | Labels for organizing/filtering                    | –                               |
| `runtime`         | Runtime image variant (`"default"` \| `"dev"`)     | `"default"`                     |
| `waitForCapacity` | Wait instead of failing at the concurrency limit   | –                               |
| `timeout`         | Command execution timeout in seconds               | `300`                           |
| `workdir`         | Working directory for commands and relative paths  | `/home/sprite`                  |
| `initialFiles`    | Files to create right after the Sprite boots       | –                               |
| `auth`            | `{ token, baseURL }` overrides                     | env vars                        |

## Error Handling

All errors are `SpritesSandboxError` instances with a structured `code`:

```typescript
import { SpritesSandboxError } from "@langchain/sprites";

try {
  await sandbox.execute("some command");
} catch (error) {
  if (SpritesSandboxError.isInstance(error)) {
    console.error(error.code); // e.g. "COMMAND_TIMEOUT"
  }
}
```

Codes: `NOT_INITIALIZED`, `ALREADY_INITIALIZED`, `COMMAND_TIMEOUT`,
`COMMAND_FAILED`, `AUTHENTICATION_FAILED`, `SANDBOX_CREATION_FAILED`,
`SANDBOX_NOT_FOUND`, `FILE_OPERATION_FAILED`, `CHECKPOINT_FAILED`.

## Testing

```bash
# Unit tests (no credentials needed)
pnpm test:unit

# Integration tests create real Sprites and require SPRITES_TOKEN
SPRITES_TOKEN=... pnpm test:int
```

The integration suite runs the `@langchain/sandbox-standard-tests`
conformance suite plus Sprites-specific tests (persistence, reconnect,
checkpoint/restore). Test Sprites are named `ci-deepagents-<run>-*` and are
deleted after the run.

## License

MIT
