<div align="center">
  <a href="https://docs.langchain.com/oss/javascript/deepagents/overview#deep-agents-overview">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/langchain-ai/deepagentsjs/refs/heads/main/.github/images/logo-light.svg">
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/langchain-ai/deepagentsjs/refs/heads/main/.github/images/logo-dark.svg">
      <img alt="Deep Agents Logo" src="https://raw.githubusercontent.com/langchain-ai/deepagentsjs/refs/heads/main/.github/images/logo-light.svg" width="50%">
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
  <a href="https://x.com/langchain_js" target="_blank"><img src="https://img.shields.io/twitter/url/https/twitter.com/langchain_js.svg?style=social&label=Follow%20%40LangChain_JS" alt="Twitter / X"></a>
</div>

<br>

Deep Agents is an agent harness. An opinionated, ready-to-run agent out of the box. Instead of wiring prompts, tools, and context management yourself, you get a working agent immediately and customize what you need.

**What's included:**

- **Planning** — `write_todos` for task breakdown and progress tracking
- **Filesystem** — `read_file`, `write_file`, `edit_file`, `ls`, `glob`, `grep` for working memory
- **Sub-agents** — `task` for delegating work with isolated context windows
- **Smart defaults** — built-in prompt and middleware that make these tools useful out of the box
- **Context management** — file-based workflows to keep long tasks manageable

> [!NOTE]
> Looking for the Python package? See [langchain-ai/deepagents](https://github.com/langchain-ai/deepagents).

## Quickstart

```bash
npm install deepagents
# or
pnpm add deepagents
# or
yarn add deepagents
```

```typescript
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent();

const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content: "Research LangGraph and write a summary in summary.md",
    },
  ],
});
```

The agent can plan, read/write files, and manage longer tasks with sub-agents and filesystem tools.

> [!TIP]
> For developing, debugging, and deploying AI agents and LLM applications, see [LangSmith](https://docs.langchain.com/langsmith/home).

## Customization

Add tools, swap models, and customize prompts as needed:

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent({
  model: new ChatOpenAI({ model: "gpt-5", temperature: 0 }),
  tools: [myCustomTool],
  systemPrompt: "You are a research assistant.",
});
```

See the [JavaScript Deep Agents docs](https://docs.langchain.com/oss/javascript/deepagents/overview) for full configuration options.

## LangGraph Native

`createDeepAgent` returns a compiled [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) graph, so you can use streaming, Studio, checkpointers, and other LangGraph features.

## Why Use It

- **100% open source** — MIT licensed and extensible
- **Provider agnostic** — works with tool-calling chat models
- **Built on LangGraph** — production runtime with streaming and persistence
- **Batteries included** — planning, file access, sub-agents, and defaults out of the box
- **Fast to start** — install and run with sensible defaults
- **Easy to customize** — add tools/models/prompts when you need to

---

## Documentation

- [docs.langchain.com](https://docs.langchain.com/oss/javascript/deepagents/overview) - Concepts and guides
- [Examples](/examples) - Working agents and patterns
- [LangChain Forum](https://forum.langchain.com) - Community discussion and support

## Security

Deep Agents follows a "trust the LLM" model. The agent can do anything its tools allow. Enforce boundaries at the tool/sandbox level, not by expecting the model to self-police. See the [security policy](https://github.com/langchain-ai/deepagentsjs?tab=security-ov-file) for more information.
