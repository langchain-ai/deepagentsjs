# @langchain/langsmith-sandbox

LangSmith Sandbox backend for [deepagents](https://www.npmjs.com/package/deepagents). This package provides a `LangSmithSandbox` implementation of the `SandboxBackendProtocol`, enabling agents to execute commands, read/write files, and manage isolated sandbox environments using LangSmith's Sandbox infrastructure.

[![npm version](https://img.shields.io/npm/v/@langchain/langsmith-sandbox.svg)](https://www.npmjs.com/package/@langchain/langsmith-sandbox)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Isolated Execution**: Run commands in secure, isolated sandbox environments
- **File Operations**: Upload and download files with full filesystem access
- **BaseSandbox Integration**: All inherited methods (`read`, `write`, `edit`, `ls`, `grep`, `glob`) work out of the box
- **Factory Pattern**: Compatible with deepagents' middleware architecture
- **Template Support**: Use predefined sandbox templates for consistent environments
- **Multi-Region**: Support for US and EU API regions

## Installation

```bash
# npm
npm install @langchain/langsmith-sandbox

# yarn
yarn add @langchain/langsmith-sandbox

# pnpm
pnpm add @langchain/langsmith-sandbox
```

## Authentication Setup

The package requires LangSmith authentication:

### Environment Variable (Recommended)

1. Go to [https://smith.langchain.com](https://smith.langchain.com)
2. Navigate to your settings to get your API key
3. Set it as an environment variable:

```bash
export LANGSMITH_API_KEY=your_api_key_here
# or (alternative)
export LANGCHAIN_API_KEY=your_api_key_here
```

### Explicit API Key in Code

```typescript
const sandbox = await LangSmithSandbox.create({
  templateName: "default",
  auth: { apiKey: "your-api-key-here" },
});
```

## Basic Usage

```typescript
import { createDeepAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { LangSmithSandbox } from "@langchain/langsmith-sandbox";

// Create and initialize the sandbox
const sandbox = await LangSmithSandbox.create({
  templateName: "default",
});

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
    systemPrompt: "You are a coding assistant with access to a sandbox.",
    backend: sandbox,
  });

  const result = await agent.invoke({
    messages: [
      { role: "user", content: "Create a hello world Python script and run it" },
    ],
  });
} finally {
  await sandbox.close();
}
```

## Configuration Options

```typescript
interface LangSmithSandboxOptions {
  /**
   * Name of the SandboxTemplate to use.
   * This is required when creating a new sandbox.
   */
  templateName: string;

  /**
   * Optional name for the sandbox.
   * Must follow DNS-1035 format: lowercase alphanumeric and hyphens,
   * max 63 chars, must start with a letter.
   * Auto-generated if not provided.
   */
  name?: string;

  /**
   * Wait for sandbox to be ready before returning.
   * @default true
   */
  waitForReady?: boolean;

  /**
   * Timeout in seconds when waiting for ready.
   * If not provided, uses server default (typically 180 seconds).
   */
  timeout?: number;

  /**
   * Region for the LangSmith API.
   * - "us": United States (default)
   * - "eu": European Union
   * @default "us"
   */
  region?: "us" | "eu";

  /**
   * Authentication configuration.
   */
  auth?: {
    apiKey?: string;
  };
}
```

## API Regions

The sandbox can be deployed in the following regions:

| Region Code | Location       | API Host                  |
| ----------- | -------------- | ------------------------- |
| `us`        | United States  | api.host.langchain.com    |
| `eu`        | European Union | eu.api.host.langchain.com |

## Factory Functions

### Creating New Sandboxes Per Invocation

```typescript
import { createLangSmithSandboxFactory } from "@langchain/langsmith-sandbox";

// Each call creates a new sandbox
const factory = createLangSmithSandboxFactory({ templateName: "default" });

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
  LangSmithSandbox,
  createLangSmithSandboxFactoryFromSandbox,
} from "@langchain/langsmith-sandbox";

// Create and initialize a sandbox
const sandbox = await LangSmithSandbox.create({ templateName: "default" });

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
    systemPrompt: "You are a coding assistant.",
    middlewares: [
      createFilesystemMiddleware({
        backend: createLangSmithSandboxFactoryFromSandbox(sandbox),
      }),
    ],
  });

  await agent.invoke({ messages: [...] });
} finally {
  await sandbox.close();
}
```

## Connecting to Existing Sandboxes

Resume working with a sandbox that was created earlier:

```typescript
// First session: create sandbox
const sandbox = await LangSmithSandbox.create({
  templateName: "default",
  name: "my-persistent-sandbox",
});
const sandboxName = sandbox.name;
// Close client connection but sandbox keeps running
await sandbox.close();

// Later: reconnect to the same sandbox
const reconnected = await LangSmithSandbox.connect(sandboxName);
const result = await reconnected.execute("ls -la");
```

## Listing Sandboxes

```typescript
// List all sandboxes in your namespace
const sandboxes = await LangSmithSandbox.list();

for (const sb of sandboxes) {
  console.log(`${sb.name}: ${sb.template_name}`);
}
```

## Error Handling

```typescript
import { LangSmithSandboxError } from "@langchain/langsmith-sandbox";

try {
  await sandbox.execute("some command");
} catch (error) {
  if (error instanceof LangSmithSandboxError) {
    switch (error.code) {
      case "NOT_INITIALIZED":
        await sandbox.initialize();
        break;
      case "COMMAND_TIMEOUT":
        console.error("Command took too long");
        break;
      case "AUTHENTICATION_FAILED":
        console.error("Check your LangSmith API key");
        break;
      case "IMAGE_PULL_FAILED":
        console.error("Sandbox template image could not be pulled");
        break;
      case "CRASH_LOOP":
        console.error("Sandbox crashed during startup");
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
| `AUTHENTICATION_FAILED`   | Invalid or missing LangSmith API key        |
| `SANDBOX_CREATION_FAILED` | Failed to create sandbox                    |
| `SANDBOX_NOT_FOUND`       | Sandbox name not found or expired           |
| `COMMAND_TIMEOUT`         | Command execution timed out                 |
| `COMMAND_FAILED`          | Command execution failed                    |
| `FILE_OPERATION_FAILED`   | File read/write failed                      |
| `RESOURCE_LIMIT_EXCEEDED` | CPU, memory, or storage limits exceeded     |
| `API_ERROR`               | Generic API error                           |
| `IMAGE_PULL_FAILED`       | Failed to pull sandbox template image       |
| `CRASH_LOOP`              | Sandbox crashed during startup              |
| `UNSCHEDULABLE`           | No nodes available for scheduling           |

## Inherited BaseSandbox Methods

`LangSmithSandbox` extends `BaseSandbox` and inherits these convenience methods:

| Method       | Description                   |
| ------------ | ----------------------------- |
| `read()`     | Read a file's contents        |
| `write()`    | Write content to a file       |
| `edit()`     | Replace text in a file        |
| `lsInfo()`   | List directory contents       |
| `grepRaw()`  | Search for patterns in files  |
| `globInfo()` | Find files matching a pattern |

## Environment Variables

| Variable            | Description                                        |
| ------------------- | -------------------------------------------------- |
| `LANGSMITH_API_KEY` | LangSmith API key (primary)                        |
| `LANGCHAIN_API_KEY` | LangChain API key (alternative, for compatibility) |

## API Reference

For detailed API documentation, see the [LangSmith Sandbox API reference](https://docs.langchain.com/api-reference/sandboxes-v2/create-a-sandbox).

## License

MIT
