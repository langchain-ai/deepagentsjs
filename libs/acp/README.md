# deepagents-acp

ACP (Agent Client Protocol) server for DeepAgents - enables integration with IDEs like Zed, JetBrains, and other ACP-compatible clients.

## Overview

This package wraps DeepAgents with the [Agent Client Protocol (ACP)](https://agentclientprotocol.com), allowing your AI agents to communicate with code editors and development tools through a standardized protocol.

### What is ACP?

The Agent Client Protocol is a standardized communication protocol between code editors and AI-powered coding agents. It enables:

- **IDE Integration**: Connect your agents to Zed, JetBrains IDEs, and other compatible tools
- **Standardized Communication**: JSON-RPC 2.0 based protocol over stdio
- **Rich Interactions**: Support for text, images, file operations, and tool calls
- **Session Management**: Persistent conversations with state management

## Installation

```bash
npm install deepagents-acp
# or
pnpm add deepagents-acp
```

## Quick Start

### Using the CLI (Recommended)

The easiest way to start is with the CLI:

```bash
# Run with defaults
npx deepagents-acp

# With custom options
npx deepagents-acp --name my-agent --debug

# Full options
npx deepagents-acp \
  --name coding-assistant \
  --model claude-sonnet-4-5-20250929 \
  --workspace /path/to/project \
  --skills ./skills,~/.deepagents/skills \
  --debug
```

### CLI Options

| Option                 | Short | Description                                       |
| ---------------------- | ----- | ------------------------------------------------- |
| `--name <name>`        | `-n`  | Agent name (default: "deepagents")                |
| `--description <desc>` | `-d`  | Agent description                                 |
| `--model <model>`      | `-m`  | LLM model (default: "claude-sonnet-4-5-20250929") |
| `--workspace <path>`   | `-w`  | Workspace root directory (default: cwd)           |
| `--skills <paths>`     | `-s`  | Comma-separated skill paths                       |
| `--memory <paths>`     |       | Comma-separated AGENTS.md paths                   |
| `--debug`              |       | Enable debug logging to stderr                    |
| `--help`               | `-h`  | Show help message                                 |
| `--version`            | `-v`  | Show version                                      |

### Environment Variables

| Variable            | Description                                    |
| ------------------- | ---------------------------------------------- |
| `ANTHROPIC_API_KEY` | API key for Anthropic/Claude models (required) |
| `OPENAI_API_KEY`    | API key for OpenAI models                      |
| `DEBUG`             | Set to "true" to enable debug logging          |
| `WORKSPACE_ROOT`    | Alternative to --workspace flag                |

### Programmatic Usage

```typescript
import { startServer } from "deepagents-acp";

await startServer({
  agents: {
    name: "coding-assistant",
    description: "AI coding assistant with filesystem access",
  },
  workspaceRoot: process.cwd(),
});
```

### Advanced Configuration

```typescript
import { DeepAgentsServer } from "deepagents-acp";
import { FilesystemBackend } from "deepagents";

const server = new DeepAgentsServer({
  // Define multiple agents
  agents: [
    {
      name: "code-agent",
      description: "Full-featured coding assistant",
      model: "claude-sonnet-4-5-20250929",
      skills: ["./skills/"],
      memory: ["./.deepagents/AGENTS.md"],
    },
    {
      name: "reviewer",
      description: "Code review specialist",
      model: "claude-sonnet-4-5-20250929",
      systemPrompt: "You are a code review expert...",
    },
  ],

  // Server options
  serverName: "my-deepagents-acp",
  serverVersion: "1.0.0",
  workspaceRoot: process.cwd(),
  debug: true,
});

await server.start();
```

## Usage with Zed

To use with [Zed](https://zed.dev), add the agent to your settings (`~/.config/zed/settings.json` on Linux, `~/Library/Application Support/Zed/settings.json` on macOS):

### Simple Setup

```json
{
  "agent": {
    "profiles": {
      "deepagents": {
        "name": "DeepAgents",
        "command": "npx",
        "args": ["deepagents-acp"]
      }
    }
  }
}
```

### With Options

```json
{
  "agent": {
    "profiles": {
      "deepagents": {
        "name": "DeepAgents",
        "command": "npx",
        "args": [
          "deepagents-acp",
          "--name", "my-assistant",
          "--skills", "./skills",
          "--debug"
        ],
        "env": {
          "ANTHROPIC_API_KEY": "sk-ant-..."
        }
      }
    }
  }
}
```

### Custom Script (Advanced)

For more control, create a custom script:

```typescript
// server.ts
import { startServer } from "deepagents-acp";

await startServer({
  agents: {
    name: "my-agent",
    description: "My custom coding agent",
    skills: ["./skills/"],
  },
});
```

Then configure Zed:

```json
{
  "agent": {
    "profiles": {
      "my-agent": {
        "name": "My Agent",
        "command": "npx",
        "args": ["tsx", "./server.ts"]
      }
    }
  }
}
```

## API Reference

### DeepAgentsServer

The main server class that handles ACP communication.

```typescript
import { DeepAgentsServer } from "deepagents-acp";

const server = new DeepAgentsServer(options);
```

#### Options

| Option          | Type                                   | Description                                     |
| --------------- | -------------------------------------- | ----------------------------------------------- |
| `agents`        | `DeepAgentConfig \| DeepAgentConfig[]` | Agent configuration(s)                          |
| `serverName`    | `string`                               | Server name for ACP (default: "deepagents-acp") |
| `serverVersion` | `string`                               | Server version (default: "0.0.1")               |
| `workspaceRoot` | `string`                               | Workspace root directory (default: cwd)         |
| `debug`         | `boolean`                              | Enable debug logging (default: false)           |

#### DeepAgentConfig

| Option         | Type                                | Description                                       |
| -------------- | ----------------------------------- | ------------------------------------------------- |
| `name`         | `string`                            | Unique agent name (required)                      |
| `description`  | `string`                            | Agent description                                 |
| `model`        | `string`                            | LLM model (default: "claude-sonnet-4-5-20250929") |
| `tools`        | `StructuredTool[]`                  | Custom tools                                      |
| `systemPrompt` | `string`                            | Custom system prompt                              |
| `middleware`   | `AgentMiddleware[]`                 | Custom middleware                                 |
| `backend`      | `BackendProtocol \| BackendFactory` | Filesystem backend                                |
| `skills`       | `string[]`                          | Skill source paths                                |
| `memory`       | `string[]`                          | Memory source paths (AGENTS.md)                   |

### Methods

#### start()

Start the ACP server. Listens on stdio by default.

```typescript
await server.start();
```

#### stop()

Stop the server and cleanup.

```typescript
server.stop();
```

### startServer()

Convenience function to create and start a server.

```typescript
import { startServer } from "deepagents-acp";

const server = await startServer(options);
```

## ACP Protocol Support

This package implements the following ACP methods:

### Agent Methods (what we implement)

| Method             | Description                         |
| ------------------ | ----------------------------------- |
| `initialize`       | Negotiate versions and capabilities |
| `authenticate`     | Handle authentication (passthrough) |
| `session/new`      | Create a new conversation session   |
| `session/load`     | Resume an existing session          |
| `session/prompt`   | Process user prompts                |
| `session/cancel`   | Cancel ongoing operations           |
| `session/set_mode` | Switch agent modes                  |

### Session Updates (what we send)

| Update                  | Description                   |
| ----------------------- | ----------------------------- |
| `agent_message_chunk`   | Stream agent text responses   |
| `thought_message_chunk` | Stream agent thinking         |
| `tool_call`             | Notify about tool invocations |
| `tool_call_update`      | Update tool call status       |
| `plan`                  | Send task plan entries        |

### Capabilities

The server advertises these capabilities:

- `fsReadTextFile`: File reading support
- `fsWriteTextFile`: File writing support
- `loadSession`: Session persistence
- `modes`: Agent mode switching
- `commands`: Slash command support

## Modes

The server supports three operating modes:

1. **Agent Mode** (`agent`): Full autonomous agent with file access
2. **Plan Mode** (`plan`): Planning and discussion without changes
3. **Ask Mode** (`ask`): Q&A without file modifications

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    IDE (Zed, JetBrains)                     │
│                      ACP Client                             │
└─────────────────────┬───────────────────────────────────────┘
                      │ stdio (JSON-RPC 2.0)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  deepagents-acp                          │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              AgentSideConnection                    │   │
│   │   (from @agentclientprotocol/sdk)                   │   │
│   └─────────────────────┬───────────────────────────────┘   │
│                         │                                   │
│   ┌─────────────────────▼───────────────────────────────┐   │
│   │              Message Adapter                        │   │
│   │   ACP ContentBlock ←→ LangChain Messages            │   │
│   └─────────────────────┬───────────────────────────────┘   │
│                         │                                   │
│   ┌─────────────────────▼───────────────────────────────┐   │
│   │               DeepAgent                             │   │
│   │  (from deepagents package)                          │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Examples

### Custom Backend

```typescript
import { DeepAgentsServer } from "deepagents-acp";
import { CompositeBackend, FilesystemBackend, StateBackend } from "deepagents";

const server = new DeepAgentsServer({
  agents: {
    name: "custom-agent",
    backend: new CompositeBackend({
      routes: [
        { prefix: "/workspace", backend: new FilesystemBackend({ rootDir: "./workspace" }) },
        { prefix: "/", backend: (config) => new StateBackend(config) },
      ],
    }),
  },
});
```

### With Custom Tools

```typescript
import { DeepAgentsServer } from "deepagents-acp";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const searchTool = tool(
  async ({ query }) => {
    // Search implementation
    return `Results for: ${query}`;
  },
  {
    name: "search",
    description: "Search the codebase",
    schema: z.object({ query: z.string() }),
  }
);

const server = new DeepAgentsServer({
  agents: {
    name: "search-agent",
    tools: [searchTool],
  },
});
```

## Contributing

See the main [deepagentsjs repository](https://github.com/langchain-ai/deepagentsjs) for contribution guidelines.

## License

MIT

## Resources

- [Agent Client Protocol Documentation](https://agentclientprotocol.com)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [DeepAgents Documentation](https://github.com/langchain-ai/deepagentsjs)
- [Zed Editor](https://zed.dev)
