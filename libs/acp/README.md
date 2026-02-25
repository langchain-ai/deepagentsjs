# deepagents-acp

ACP (Agent Client Protocol) server for DeepAgents - enables integration with IDEs like Zed, JetBrains, and other ACP-compatible clients.

## Overview

This package wraps DeepAgents with the [Agent Client Protocol (ACP)](https://agentclientprotocol.com), allowing your AI agents to communicate with code editors and development tools through a standardized protocol.

### What is ACP?

The [Agent Client Protocol](https://agentclientprotocol.com) is an open standard for communication between code editors and AI-powered coding agents — similar to what LSP did for language servers. It enables:

- **IDE Integration**: Connect your agents to Zed, JetBrains IDEs, Neovim, Emacs, and other compatible tools
- **Standardized Communication**: JSON-RPC 2.0 based protocol over stdio
- **Rich Interactions**: Text, images, file operations, tool calls, terminals, diffs, and permission requests
- **Session Management**: Persistent conversations with full history replay
- **No Vendor Lock-in**: Use any model, switch between agents, all through one open protocol
- **ACP Registry**: One-click agent installation from within supported IDEs

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

### Multiple Agents

When you define multiple agents, the client selects which agent to use at session creation time by passing `configOptions.agent` in the `session/new` ACP request. If not specified, the first agent in the configuration is used by default.

```typescript
// Client sends session/new with configOptions to select an agent:
// { "configOptions": { "agent": "reviewer" } }  → uses the "reviewer" agent
// { "configOptions": { "agent": "code-agent" } } → uses the "code-agent" agent
// { }                                            → uses the first agent ("code-agent")
```

> **Note:** Some ACP clients (like Zed) don't currently expose a UI for passing `configOptions` at session creation. In that case, consider running separate server instances with a single agent each, or using separate Zed profiles pointing to different server scripts.

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
          "--name",
          "my-assistant",
          "--skills",
          "./skills",
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
| `interruptOn`  | `Record<string, boolean \| InterruptOnConfig>` | Tools requiring user approval (HITL) |
| `commands`     | `Array<{ name, description, input? }>` | Custom slash commands                          |

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

## Features

### Slash Commands

The server provides built-in slash commands accessible from the IDE's prompt input. Type `/` to see available commands:

| Command   | Description                                |
| --------- | ------------------------------------------ |
| `/plan`   | Switch to plan mode (read-only planning)   |
| `/agent`  | Switch to agent mode (full autonomous)     |
| `/ask`    | Switch to ask mode (Q&A, no file changes)  |
| `/clear`  | Clear conversation context and start fresh |
| `/status` | Show session status and loaded skills      |

You can also define custom slash commands per agent:

```typescript
const server = new DeepAgentsServer({
  agents: {
    name: "my-agent",
    commands: [
      { name: "test", description: "Run the project's test suite" },
      { name: "lint", description: "Run linter and fix issues" },
    ],
  },
});
```

### Modes

The server supports three operating modes, switchable via slash commands or programmatically:

1. **Agent Mode** (`agent`): Full autonomous agent with file access
2. **Plan Mode** (`plan`): Planning and discussion without changes
3. **Ask Mode** (`ask`): Q&A without file modifications

### Thinking / Reasoning Messages

When using models with extended thinking (e.g., Claude with `thinking: { type: "enabled" }`), the server streams reasoning tokens to the IDE as `thought_message_chunk` updates. This gives users visibility into the agent's chain-of-thought process in clients that support it.

### Tool Call Enhancements

The server provides rich tool call reporting to the IDE:

- **Tool call kinds** — each tool call is categorized using [ACP-standard kinds](https://agentclientprotocol.com/protocol/tool-calls) (`read`, `edit`, `search`, `execute`, `think`, etc.) so the IDE can display appropriate icons
- **File locations (follow-along)** — tool calls that operate on files (e.g., `read_file`, `edit_file`, `grep`) report `{ path, line }` locations, enabling IDEs to open and highlight the files the agent is working with in real time
- **Diff content** — when the agent edits a file, the tool call update includes `{ type: "diff", path, oldText, newText }` content so the IDE can render inline diffs
- **Raw input/output** — tool call notifications include the raw tool arguments and results for transparency

### Human-in-the-Loop (Permission Requests)

When agents are configured with `interruptOn`, the server bridges LangGraph's interrupt system to the ACP `session/request_permission` protocol. This surfaces approval prompts in the IDE before sensitive tools execute:

```typescript
const server = new DeepAgentsServer({
  agents: {
    name: "careful-agent",
    interruptOn: {
      execute: { allowedDecisions: ["approve", "edit", "reject"] },
      write_file: true,
    },
  },
});
```

When the agent calls a protected tool, the IDE shows a permission dialog with options:
- **Allow once** — approve this specific invocation
- **Reject** — deny this specific invocation
- **Always allow** — approve and remember for this session
- **Always reject** — deny and remember for this session

### Terminal Integration

When the ACP client supports the `terminal` capability (e.g., Zed, JetBrains), the server uses the client's terminal for `execute` tool calls instead of running commands locally. This provides:

- **Live streaming output** — terminal output scrolls in real time inside the IDE's agent panel
- **Process control** — the IDE can kill long-running commands
- **Embedded display** — terminal output is embedded directly in the tool call UI

If the client doesn't support terminals, commands fall back to local execution (current behavior).

### Session Persistence

Sessions are persisted using LangGraph's checkpointer. When loading a session with `session/load`, the server replays the full conversation history back to the client via ACP notifications, including:

- User messages
- Agent responses
- Tool calls and their results
- Plan entries

This ensures the IDE shows the complete conversation when resuming a session.

### ACP Filesystem Backend

When the ACP client advertises `fs.readTextFile` and `fs.writeTextFile` capabilities, the server can proxy file operations through the client instead of reading/writing directly from disk. This enables:

- **Unsaved buffer access** — the agent reads the editor's current buffer, including unsaved changes
- **IDE-tracked modifications** — file writes go through the IDE, enabling undo, change tracking, and diff highlighting

Falls back to local filesystem operations for `ls`, `glob`, and `grep` which have no ACP equivalents.

## ACP Protocol Support

This package implements the following ACP methods:

### Agent Methods (what we implement)

| Method             | Description                         |
| ------------------ | ----------------------------------- |
| `initialize`       | Negotiate versions and capabilities |
| `authenticate`     | Handle authentication (passthrough) |
| `session/new`      | Create a new conversation session   |
| `session/load`     | Resume an existing session with full history replay |
| `session/prompt`   | Process user prompts and slash commands |
| `session/cancel`   | Cancel ongoing operations           |
| `session/set_mode` | Switch agent modes                  |

### Client Methods (what we call on the client)

| Method                       | Description                                  |
| ---------------------------- | -------------------------------------------- |
| `session/request_permission` | Prompt user to approve/reject tool calls     |
| `fs/read_text_file`          | Read file contents (including unsaved buffers) |
| `fs/write_text_file`         | Write file contents through the IDE          |
| `terminal/create`            | Start a command in the client's terminal     |
| `terminal/output`            | Get terminal output                          |
| `terminal/wait_for_exit`     | Wait for command completion                  |
| `terminal/kill`              | Kill a running command                       |
| `terminal/release`           | Release terminal resources                   |

### Session Updates (what we send)

| Update                       | Description                              |
| ---------------------------- | ---------------------------------------- |
| `agent_message_chunk`        | Stream agent text responses              |
| `thought_message_chunk`      | Stream agent thinking/reasoning          |
| `tool_call`                  | Notify about tool invocations with kind, locations, and input |
| `tool_call_update`           | Update tool call status with content (text, diffs, terminals) |
| `plan`                       | Send task plan entries                   |
| `available_commands_update`  | Advertise slash commands to the client   |

### Capabilities

The server advertises these capabilities:

- `loadSession`: Session persistence with history replay
- `promptCapabilities.image`: Image content support
- `promptCapabilities.embeddedContext`: Embedded context support
- `sessionCapabilities.modes`: Agent mode switching
- `sessionCapabilities.commands`: Slash command support

### Tool Call Kinds

Tool calls are categorized with [ACP-standard kinds](https://agentclientprotocol.com/protocol/tool-calls) for proper icon display:

| Kind       | Tools                        |
| ---------- | ---------------------------- |
| `read`     | `read_file`, `ls`            |
| `search`   | `grep`, `glob`               |
| `edit`     | `write_file`, `edit_file`    |
| `execute`  | `execute`, `shell`           |
| `think`    | `write_todos`                |
| `other`    | `task`, custom tools         |

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
        {
          prefix: "/workspace",
          backend: new FilesystemBackend({ rootDir: "./workspace" }),
        },
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
  },
);

const server = new DeepAgentsServer({
  agents: {
    name: "search-agent",
    tools: [searchTool],
  },
});
```

### With Human-in-the-Loop Approval

```typescript
import { DeepAgentsServer } from "deepagents-acp";

const server = new DeepAgentsServer({
  agents: {
    name: "safe-agent",
    description: "Agent that asks before writing or executing",
    interruptOn: {
      write_file: true,
      edit_file: true,
      execute: {
        allowedDecisions: ["approve", "edit", "reject"],
      },
    },
  },
});
```

When the agent tries to write a file or run a command, the IDE will prompt the user to approve, reject, or always-allow the operation.

### With Custom Slash Commands

```typescript
import { DeepAgentsServer } from "deepagents-acp";

const server = new DeepAgentsServer({
  agents: {
    name: "project-agent",
    commands: [
      { name: "test", description: "Run the project test suite" },
      { name: "build", description: "Build the project" },
      {
        name: "deploy",
        description: "Deploy to staging",
        input: { hint: "environment (staging or production)" },
      },
    ],
  },
});
```

## ACP Registry

DeepAgents is available in the [ACP Agent Registry](https://agentclientprotocol.com/registry/index) for one-click installation in Zed and JetBrains IDEs. The registry manifest is at `agent.json`:

```json
{
  "id": "deepagents",
  "name": "DeepAgents",
  "description": "Batteries-included AI coding agent powered by LangChain.",
  "distribution": {
    "npx": {
      "package": "deepagents-acp"
    }
  }
}
```

## Contributing

See the main [deepagentsjs repository](https://github.com/langchain-ai/deepagentsjs) for contribution guidelines.

## License

MIT

## Resources

- [Agent Client Protocol Documentation](https://agentclientprotocol.com)
- [ACP Agent Registry](https://agentclientprotocol.com/registry/index)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [DeepAgents Documentation](https://github.com/langchain-ai/deepagentsjs)
- [Zed Editor](https://zed.dev)
- [JetBrains ACP Support](https://www.jetbrains.com/acp/)
