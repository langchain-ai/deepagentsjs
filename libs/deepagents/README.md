<div align="center">
  <a href="https://docs.langchain.com/oss/python/deepagents/overview#deep-agents-overview">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/langchain-ai/deepagentsjs/refs/heads/main/.github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/langchain-ai/deepagentsjs/refs/heads/main/.github/images/logo-light.svg">
      <img alt="Deep Agents Logo" src="https://raw.githubusercontent.com/langchain-ai/deepagentsjs/refs/heads/main/.github/images/logo-dark.svg" width="80%">
    </picture>
  </a>
</div>

<div align="center">
  <h3>The batteries-included agent harness.</h3>
</div>

<div align="center">
  <a href="https://www.npmjs.com/package/deepagents"><img src="https://img.shields.io/npm/v/deepagents.svg" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.0+-blue.svg" alt="TypeScript"></a>
  <a href="https://x.com/LangChain_JS" target="_blank"><img src="https://img.shields.io/twitter/url/https/twitter.com/LangChain_JS.svg?style=social&label=Follow%20%40LangChain_JS" alt="Twitter / X"></a>
</div>

Using an LLM to call tools in a loop is the simplest form of an agent. This architecture, however, can yield agents that are "shallow" and fail to plan and act over longer, more complex tasks.

Applications like "Deep Research", "Manus", and "Claude Code" have gotten around this limitation by implementing a combination of four things:
a **planning tool**, **sub agents**, access to a **file system**, and a **detailed prompt**.

`deepagents` is a TypeScript package that implements these in a general purpose way so that you can easily create a Deep Agent for your application.

> 💡 **Tip:** Looking for the Python version of this package? See [langchain-ai/deepagents](https://github.com/langchain-ai/deepagents)

<div align="center">

[Documentation](https://docs.langchain.com/oss/javascript/deepagents/overview) | [Examples](./examples) | [Report Bug](https://github.com/langchain-ai/deepagentsjs/issues) | [Request Feature](https://github.com/langchain-ai/deepagentsjs/issues)

</div>

## 📖 Overview

Using an LLM to call tools in a loop is the simplest form of an agent. However, this architecture can yield agents that are "shallow" and fail to plan and act over longer, more complex tasks.

Applications like **Deep Research**, **Manus**, and **Claude Code** have overcome this limitation by implementing a combination of four key components:

1. **Planning Tool** - Strategic task decomposition
2. **Sub-Agents** - Specialized agents for subtasks
3. **File System Access** - Persistent state and memory
4. **Detailed Prompts** - Context-rich instructions

**Deep Agents** is a TypeScript package that implements these patterns in a general-purpose way, enabling you to easily create sophisticated agents for your applications.

## ✨ Features

- 🎯 **Task Planning & Decomposition** - Break complex tasks into manageable steps
- 🤖 **Sub-Agent Architecture** - Delegate specialized work to focused agents
- 💾 **File System Integration** - Persistent memory and state management
- 🌊 **Streaming Support** - Real-time updates, token streaming, and progress tracking
- 🔄 **LangGraph Powered** - Built on the robust LangGraph framework
- 📝 **TypeScript First** - Full type safety and IntelliSense support
- 🔌 **Extensible** - Easy to customize and extend for your use case

## Installation

```bash
# npm
npm install deepagents

# yarn
yarn add deepagents

# pnpm
pnpm add deepagents
```

## Usage

(To run the example below, you will need to `npm install @langchain/tavily`).

Make sure to set `TAVILY_API_KEY` in your environment. You can generate one [here](https://www.tavily.com/).

```typescript
import { tool } from "langchain";
import { TavilySearch } from "@langchain/tavily";
import { createDeepAgent } from "deepagents";
import { z } from "zod";

// Web search tool
const internetSearch = tool(
  async ({
    query,
    maxResults = 5,
    topic = "general",
    includeRawContent = false,
  }: {
    query: string;
    maxResults?: number;
    topic?: "general" | "news" | "finance";
    includeRawContent?: boolean;
  }) => {
    const tavilySearch = new TavilySearch({
      maxResults,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      includeRawContent,
      topic,
    });
    return await tavilySearch._call({ query });
  },
  {
    name: "internet_search",
    description: "Run a web search",
    schema: z.object({
      query: z.string().describe("The search query"),
      maxResults: z
        .number()
        .optional()
        .default(5)
        .describe("Maximum number of results to return"),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .default("general")
        .describe("Search topic category"),
      includeRawContent: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to include raw content"),
    }),
  },
);

// System prompt to steer the agent to be an expert researcher
const researchInstructions = `You are an expert researcher. Your job is to conduct thorough research, and then write a polished report.

You have access to an internet search tool as your primary means of gathering information.

## \`internet_search\`

Use this to run an internet search for a given query. You can specify the max number of results to return, the topic, and whether raw content should be included.
`;

// Create the deep agent
const agent = createDeepAgent({
  tools: [internetSearch],
  systemPrompt: researchInstructions,
});

// Invoke the agent
const result = await agent.invoke({
  messages: [{ role: "user", content: "What is langgraph?" }],
});
```

See [examples/research/research-agent.ts](examples/research/research-agent.ts) for a more complex example.

The agent created with `createDeepAgent` is just a LangGraph graph - so you can interact with it (streaming, human-in-the-loop, memory, studio)
in the same way you would any LangGraph agent.

## Core Capabilities

**Planning & Task Decomposition**

Deep Agents include a built-in `write_todos` tool that enables agents to break down complex tasks into discrete steps, track progress, and adapt plans as new information emerges.

**Context Management**

File system tools (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`) allow agents to offload large context to memory, preventing context window overflow and enabling work with variable-length tool results.

**Subagent Spawning**

A built-in `task` tool enables agents to spawn specialized subagents for context isolation. This keeps the main agent's context clean while still going deep on specific subtasks.

**Long-term Memory**

Extend agents with persistent memory across threads using LangGraph's Store. Agents can save and retrieve information from previous conversations.

## Customizing Deep Agents

There are several parameters you can pass to `createDeepAgent` to create your own custom deep agent.

### `model`

By default, `deepagents` uses `"claude-sonnet-4-5-20250929"`. You can customize this by passing any [LangChain model object](https://js.langchain.com/docs/integrations/chat/).

```typescript
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";

// Using Anthropic
const agent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    temperature: 0,
  }),
});

// Using OpenAI
const agent2 = createDeepAgent({
  model: new ChatOpenAI({
    model: "gpt-5",
    temperature: 0,
  }),
});
```

### `systemPrompt`

Deep Agents come with a built-in system prompt. This is relatively detailed prompt that is heavily based on and inspired by [attempts](https://github.com/kn1026/cc/blob/main/claudecode.md) to [replicate](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-code.md)
Claude Code's system prompt. It was made more general purpose than Claude Code's system prompt. The default prompt contains detailed instructions for how to use the built-in planning tool, file system tools, and sub agents.

Each deep agent tailored to a use case should include a custom system prompt specific to that use case as well. The importance of prompting for creating a successful deep agent cannot be overstated.

```typescript
import { createDeepAgent } from "deepagents";

const researchInstructions = `You are an expert researcher. Your job is to conduct thorough research, and then write a polished report.`;

const agent = createDeepAgent({
  systemPrompt: researchInstructions,
});
```

### `tools`

Just like with tool-calling agents, you can provide a deep agent with a set of tools that it has access to.

```typescript
import { tool } from "langchain";
import { TavilySearch } from "@langchain/tavily";
import { createDeepAgent } from "deepagents";
import { z } from "zod";

const internetSearch = tool(
  async ({
    query,
    maxResults = 5,
    topic = "general",
    includeRawContent = false,
  }: {
    query: string;
    maxResults?: number;
    topic?: "general" | "news" | "finance";
    includeRawContent?: boolean;
  }) => {
    const tavilySearch = new TavilySearch({
      maxResults,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      includeRawContent,
      topic,
    });
    return await tavilySearch._call({ query });
  },
  {
    name: "internet_search",
    description: "Run a web search",
    schema: z.object({
      query: z.string().describe("The search query"),
      maxResults: z.number().optional().default(5),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .default("general"),
      includeRawContent: z.boolean().optional().default(false),
    }),
  },
);

const agent = createDeepAgent({
  tools: [internetSearch],
});
```

### `middleware`

`createDeepAgent` is implemented with middleware that can be customized. You can provide additional middleware to extend functionality, add tools, or implement custom hooks.

```typescript
import { tool } from "langchain";
import { createDeepAgent } from "deepagents";
import type { AgentMiddleware } from "langchain";
import { z } from "zod";

const getWeather = tool(
  async ({ city }: { city: string }) => {
    return `The weather in ${city} is sunny.`;
  },
  {
    name: "get_weather",
    description: "Get the weather in a city.",
    schema: z.object({
      city: z.string().describe("The city to get weather for"),
    }),
  },
);

const getTemperature = tool(
  async ({ city }: { city: string }) => {
    return `The temperature in ${city} is 70 degrees Fahrenheit.`;
  },
  {
    name: "get_temperature",
    description: "Get the temperature in a city.",
    schema: z.object({
      city: z.string().describe("The city to get temperature for"),
    }),
  },
);

class WeatherMiddleware implements AgentMiddleware {
  tools = [getWeather, getTemperature];
}

const agent = createDeepAgent({
  model: "claude-sonnet-4-20250514",
  middleware: [new WeatherMiddleware()],
});
```

### `subagents`

A main feature of Deep Agents is their ability to spawn subagents. You can specify custom subagents that your agent can hand off work to in the subagents parameter. Sub agents are useful for context quarantine (to help not pollute the overall context of the main agent) as well as custom instructions.

`subagents` should be a list of objects that follow the `SubAgent` interface:

```typescript
interface SubAgent {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: StructuredTool[];
  model?: LanguageModelLike | string;
  middleware?: AgentMiddleware[];
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
  skills?: string[];
}
```

**SubAgent fields:**

- **name**: This is the name of the subagent, and how the main agent will call the subagent
- **description**: This is the description of the subagent that is shown to the main agent
- **systemPrompt**: This is the prompt used for the subagent
- **tools**: This is the list of tools that the subagent has access to.
- **model**: Optional model name or model instance.
- **middleware**: Additional middleware to attach to the subagent. See [here](https://docs.langchain.com/oss/typescript/langchain/middleware) for an introduction into middleware and how it works with createAgent.
- **interruptOn**: A custom interrupt config that specifies human-in-the-loop interactions for your tools.
- **skills**: Skill source paths for the subagent (e.g., `["/skills/research/"]`). See skills inheritance below.

#### Skills Inheritance

When you configure `skills` on the main agent via `createDeepAgent`, the behavior differs between subagent types:

- **General-purpose subagent**: Automatically inherits skills from the main agent. This subagent has access to all the same skills as the main agent.
- **Custom subagents**: Do NOT inherit skills from the main agent by default. If you want a custom subagent to have access to skills, you must explicitly define the `skills` property on that subagent.

```typescript
const agent = createDeepAgent({
  model: "claude-sonnet-4-20250514",
  skills: ["/skills/"], // Main agent and general-purpose subagent get these skills
  subagents: [
    {
      name: "researcher",
      description: "Research assistant",
      systemPrompt: "You are a researcher.",
      // This subagent will NOT have access to /skills/ from the main agent
    },
    {
      name: "coder",
      description: "Coding assistant",
      systemPrompt: "You are a coder.",
      skills: ["/skills/coding/"], // This subagent has its own skills
    },
  ],
});
```

This design ensures context isolation - custom subagents only have access to the skills they explicitly need, preventing unintended skill leakage between specialized agents.

#### Using SubAgent

```typescript
import { tool } from "langchain";
import { TavilySearch } from "@langchain/tavily";
import { createDeepAgent, type SubAgent } from "deepagents";
import { z } from "zod";

const internetSearch = tool(
  async ({
    query,
    maxResults = 5,
    topic = "general",
    includeRawContent = false,
  }: {
    query: string;
    maxResults?: number;
    topic?: "general" | "news" | "finance";
    includeRawContent?: boolean;
  }) => {
    const tavilySearch = new TavilySearch({
      maxResults,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      includeRawContent,
      topic,
    });
    return await tavilySearch._call({ query });
  },
  {
    name: "internet_search",
    description: "Run a web search",
    schema: z.object({
      query: z.string(),
      maxResults: z.number().optional().default(5),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .default("general"),
      includeRawContent: z.boolean().optional().default(false),
    }),
  },
);

const researchSubagent: SubAgent = {
  name: "research-agent",
  description: "Used to research more in depth questions",
  systemPrompt: "You are a great researcher",
  tools: [internetSearch],
  model: "gpt-4o", // Optional override, defaults to main agent model
};

const subagents = [researchSubagent];

const agent = createDeepAgent({
  model: "claude-sonnet-4-20250514",
  subagents: subagents,
});
```

### `interruptOn`

A common reality for agents is that some tool operations may be sensitive and require human approval before execution. Deep Agents supports human-in-the-loop workflows through LangGraph's interrupt capabilities. You can configure which tools require approval using a checkpointer.

These tool configs are passed to our prebuilt [HITL middleware](https://docs.langchain.com/oss/typescript/langchain/middleware#human-in-the-loop) so that the agent pauses execution and waits for feedback from the user before executing configured tools.

```typescript
import { tool } from "langchain";
import { createDeepAgent } from "deepagents";
import { z } from "zod";

const getWeather = tool(
  async ({ city }: { city: string }) => {
    return `The weather in ${city} is sunny.`;
  },
  {
    name: "get_weather",
    description: "Get the weather in a city.",
    schema: z.object({
      city: z.string(),
    }),
  },
);

const agent = createDeepAgent({
  model: "claude-sonnet-4-20250514",
  tools: [getWeather],
  interruptOn: {
    get_weather: {
      allowedDecisions: ["approve", "edit", "reject"],
    },
  },
});
```

### `backend`

Deep Agents use backends to manage file system operations and memory storage. You can configure different backends depending on your needs:

```typescript
import {
  createDeepAgent,
  StateBackend,
  StoreBackend,
  FilesystemBackend,
  CompositeBackend,
} from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

// Default: StateBackend (in-memory, ephemeral)
const agent1 = createDeepAgent({
  // No backend specified - uses StateBackend by default
});

// StoreBackend: Persistent storage using LangGraph Store
const agent2 = createDeepAgent({
  backend: (config) => new StoreBackend(config),
  store: new InMemoryStore(), // Provide a store
  checkpointer: new MemorySaver(), // Optional: for conversation persistence
});

// FilesystemBackend: Store files on actual filesystem
const agent3 = createDeepAgent({
  backend: (config) => new FilesystemBackend({ rootDir: "./agent-workspace" }),
});

// CompositeBackend: Combine multiple backends
const agent4 = createDeepAgent({
  backend: (config) =>
    new CompositeBackend({
      state: new StateBackend(config),
      store: config.store ? new StoreBackend(config) : undefined,
    }),
  store: new InMemoryStore(),
  checkpointer: new MemorySaver(),
});
```

See [examples/backends/](examples/backends/) for detailed examples of each backend type.

### Sandbox Execution

For agents that need to run shell commands, you can create a sandbox backend by extending `BaseSandbox`. This enables the `execute` tool which allows agents to run arbitrary shell commands in an isolated environment.

```typescript
import {
  createDeepAgent,
  BaseSandbox,
  type ExecuteResponse,
  type FileUploadResponse,
  type FileDownloadResponse,
} from "deepagents";
import { spawn } from "child_process";

// Create a concrete sandbox by extending BaseSandbox
class LocalShellSandbox extends BaseSandbox {
  readonly id = "local-shell";
  private readonly workingDirectory: string;

  constructor(workingDirectory: string) {
    super();
    this.workingDirectory = workingDirectory;
  }

  // Only execute() is required - BaseSandbox implements all file operations
  async execute(command: string): Promise<ExecuteResponse> {
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", command], {
        cwd: this.workingDirectory,
      });

      const chunks: string[] = [];
      child.stdout.on("data", (data) => chunks.push(data.toString()));
      child.stderr.on("data", (data) => chunks.push(data.toString()));

      child.on("close", (exitCode) => {
        resolve({
          output: chunks.join(""),
          exitCode,
          truncated: false,
        });
      });
    });
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    // Implement file upload logic
    return files.map(([path]) => ({ path, error: null }));
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    // Implement file download logic
    return paths.map((path) => ({
      path,
      content: null,
      error: "file_not_found",
    }));
  }
}

// Use the sandbox with your agent
const sandbox = new LocalShellSandbox("./workspace");

const agent = createDeepAgent({
  backend: sandbox,
  systemPrompt: "You can run shell commands using the execute tool.",
});
```

When using a sandbox backend, the agent gains access to an `execute` tool that can run shell commands. The tool automatically returns the command output, exit code, and whether the output was truncated.

See [examples/sandbox/local-sandbox.ts](examples/sandbox/local-sandbox.ts) for a complete implementation.

## Deep Agents Middleware

Deep Agents are built with a modular middleware architecture. As a reminder, Deep Agents have access to:

- A planning tool
- A filesystem for storing context and long-term memories
- The ability to spawn subagents

Each of these features is implemented as separate middleware. When you create a deep agent with `createDeepAgent`, we automatically attach **todoListMiddleware**, **FilesystemMiddleware** and **SubAgentMiddleware** to your agent.

Middleware is a composable concept, and you can choose to add as many or as few middleware to an agent depending on your use case. That means that you can also use any of the aforementioned middleware independently!

### TodoListMiddleware

Planning is integral to solving complex problems. If you've used claude code recently, you'll notice how it writes out a To-Do list before tackling complex, multi-part tasks. You'll also notice how it can adapt and update this To-Do list on the fly as more information comes in.

**todoListMiddleware** provides your agent with a tool specifically for updating this To-Do list. Before, and while it executes a multi-part task, the agent is prompted to use the write_todos tool to keep track of what its doing, and what still needs to be done.

```typescript
import { createAgent, todoListMiddleware } from "langchain";

// todoListMiddleware is included by default in createDeepAgent
// You can customize it if building a custom agent
const agent = createAgent({
  model: "claude-sonnet-4-20250514",
  middleware: [
    todoListMiddleware({
      // Optional: Custom addition to the system prompt
      systemPrompt: "Use the write_todos tool to...",
    }),
  ],
});
```

### FilesystemMiddleware

Context engineering is one of the main challenges in building effective agents. This can be particularly hard when using tools that can return variable length results (ex. web_search, rag), as long ToolResults can quickly fill up your context window.

**FilesystemMiddleware** provides tools to your agent to interact with both short-term and long-term memory:

- **ls**: List the files in your filesystem
- **read_file**: Read an entire file, or a certain number of lines from a file
- **write_file**: Write a new file to your filesystem
- **edit_file**: Edit an existing file in your filesystem
- **glob**: Find files matching a pattern
- **grep**: Search for text within files
- **execute**: Run shell commands (only available when using a `SandboxBackendProtocol`)

```typescript
import { createAgent } from "langchain";
import { createFilesystemMiddleware } from "deepagents";

// FilesystemMiddleware is included by default in createDeepAgent
// You can customize it if building a custom agent
const agent = createAgent({
  model: "claude-sonnet-4-20250514",
  middleware: [
    createFilesystemMiddleware({
      backend: ..., // Optional: customize storage backend
      systemPrompt: "Write to the filesystem when...", // Optional custom system prompt override
      customToolDescriptions: {
        ls: "Use the ls tool when...",
        read_file: "Use the read_file tool to...",
      }, // Optional: Custom descriptions for filesystem tools
    }),
  ],
});
```

### SubAgentMiddleware

Handing off tasks to subagents is a great way to isolate context, keeping the context window of the main (supervisor) agent clean while still going deep on a task. The subagents middleware allows you supply subagents through a task tool.

A subagent is defined with a name, description, system prompt, and tools. You can also provide a subagent with a custom model, or with additional middleware. This can be particularly useful when you want to give the subagent an additional state key to share with the main agent.

```typescript
import { tool } from "langchain";
import { createAgent } from "langchain";
import { createSubAgentMiddleware, type SubAgent } from "deepagents";
import { z } from "zod";

const getWeather = tool(
  async ({ city }: { city: string }) => {
    return `The weather in ${city} is sunny.`;
  },
  {
    name: "get_weather",
    description: "Get the weather in a city.",
    schema: z.object({
      city: z.string(),
    }),
  },
);

const weatherSubagent: SubAgent = {
  name: "weather",
  description: "This subagent can get weather in cities.",
  systemPrompt: "Use the get_weather tool to get the weather in a city.",
  tools: [getWeather],
  model: "gpt-4o",
  middleware: [],
};

const agent = createAgent({
  model: "claude-sonnet-4-20250514",
  middleware: [
    createSubAgentMiddleware({
      defaultModel: "claude-sonnet-4-20250514",
      defaultTools: [],
      subagents: [weatherSubagent],
    }),
  ],
});
```
