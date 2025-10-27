# 🧠 Deep Agents

<div align="center">

![Deep Agents](deep_agents.png)

**A TypeScript library for building controllable, long-horizon AI agents with LangGraph**

[![npm version](https://img.shields.io/npm/v/deepagents.svg)](https://www.npmjs.com/package/deepagents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

[Documentation](https://docs.langchain.com/labs/deep-agents/overview) | [Examples](./examples) | [Report Bug](https://github.com/langchain-ai/deepagentsjs/issues) | [Request Feature](https://github.com/langchain-ai/deepagentsjs/issues)

</div>

---

## 📖 Overview

Using an LLM to call tools in a loop is the simplest form of an agent. However, this architecture can yield agents that are "shallow" and fail to plan and act over longer, more complex tasks. 

Applications like **Deep Research**, **Manus**, and **Claude Code** have overcome this limitation by implementing a combination of four key components:

1. **Planning Tool** - Strategic task decomposition
2. **Sub-Agents** - Specialized agents for subtasks
3. **File System Access** - Persistent state and memory
4. **Detailed Prompts** - Context-rich instructions

**Deep Agents** is a TypeScript package that implements these patterns in a general-purpose way, enabling you to easily create sophisticated agents for your applications.

> [!TIP]
> Looking for the Python version? Check out [hwchase17/deepagents](https://github.com/hwchase17/deepagents)

---

## ✨ Features

- 🎯 **Task Planning & Decomposition** - Break complex tasks into manageable steps
- 🤖 **Sub-Agent Architecture** - Delegate specialized work to focused agents
- 💾 **File System Integration** - Persistent memory and state management
- 🔄 **LangGraph Powered** - Built on the robust LangGraph framework
- 📝 **TypeScript First** - Full type safety and IntelliSense support
- 🔌 **Extensible** - Easy to customize and extend for your use case

---

## 🚀 Installation

Install using your preferred package manager:

```bash
# Using Yarn
yarn add deepagents

# Using npm
npm install deepagents

# Using pnpm
pnpm add deepagents
```

---

## 🏁 Quick Start

```typescript
import { createDeepAgent } from 'deepagents';


// Create a Deep Agent
const agent = createDeepAgent({
  tools: [/* your tools */],
  prompt: 'You are a helpful AI assistant...',
});

// Run the agent
const result = await agent.invoke({
  messages: [{ role: 'user', content: 'Your task here' }],
});

console.log(result);
```

---

## 📚 Documentation

For comprehensive guides, API references, and advanced usage:

- **[Official Documentation](https://docs.langchain.com/labs/deep-agents/overview)**
- **[API Reference](https://docs.langchain.com/labs/deep-agents/api)**
- **[Examples](./examples)** - Real-world implementation examples

---



## 🔗 Related Projects

- **[LangChain](https://github.com/langchain-ai/langchainjs)** - Building applications with LLMs
- **[LangGraph](https://github.com/langchain-ai/langgraphjs)** - Building stateful, multi-actor applications
- **[Deep Agents (Python)](https://github.com/hwchase17/deepagents)** - Python implementation

---

## 🙏 Acknowledgments

Built with ❤️ by the [LangChain](https://github.com/langchain-ai) team.

<div align="center">

**[⬆ Back to Top](#-deep-agents)**

</div>
