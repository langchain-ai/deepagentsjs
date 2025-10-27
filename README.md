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
- 🌊 **Streaming Support** - Real-time updates, token streaming, and progress tracking
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
  instructions: 'You are a helpful AI assistant...',
});

// Run the agent
const result = await agent.invoke({
  messages: [{ role: 'user', content: 'Your task here' }],
});

console.log(result);
```

### With Streaming

```typescript
import { createDeepAgent, StreamingPresets } from 'deepagents';

const agent = createDeepAgent({
  tools: [/* your tools */],
  instructions: 'You are a helpful AI assistant...',
});

// Stream state updates in real-time
const stream = await agent.stream(
  { messages: [{ role: 'user', content: 'Your task here' }] },
  { streamMode: 'updates' }
);

for await (const update of stream) {
  console.log('Update:', update);
}
```

### With Sub-Agents

```typescript
import { createDeepAgent, type SubAgent } from 'deepagents';

const researchAgent: SubAgent = {
  name: 'researcher',
  description: 'Conducts in-depth research',
  prompt: 'You are a research specialist...',
  tools: ['search', 'read_file', 'write_file'],
};

const agent = createDeepAgent({
  tools: [searchTool],
  instructions: 'You coordinate research projects...',
  subagents: [researchAgent],
});

const result = await agent.invoke({
  messages: [{ role: 'user', content: 'Research LangGraph' }],
});
```

---

## 📚 Documentation

For comprehensive guides, API references, and advanced usage:

- **[Official Documentation](https://docs.langchain.com/labs/deep-agents/overview)**
- **[API Reference](https://docs.langchain.com/labs/deep-agents/api)**
- **[Examples](./examples)** - Real-world implementation examples

### Available Examples

- **[research-agent.ts](./examples/research/research-agent.ts)** - Complete research agent with critique sub-agent
- **[streaming-basic.ts](./examples/streaming-basic.ts)** - Basic streaming patterns and modes
- **[streaming-advanced.ts](./examples/streaming-advanced.ts)** - Advanced streaming with sub-agents and progress tracking

---

## 🌊 Streaming Capabilities

Deep Agents supports all LangGraph streaming modes since it's built on `createReactAgent`:

### Streaming Modes

1. **`values`** - Stream full state after each node execution
2. **`updates`** - Stream delta updates after each node (recommended for efficiency)
3. **`messages`** - Stream LLM tokens in real-time (requires @langchain/langgraph>=0.2.20)
4. **`debug`** - Stream debug information about execution
5. **`custom`** - Stream custom data from within nodes
6. **Multiple modes** - Combine modes for comprehensive observability

### Basic Usage

**Stream state updates:**
```typescript
const stream = await agent.stream(
  { messages: [{ role: 'user', content: 'Your task' }] },
  { streamMode: 'updates' }
);

for await (const update of stream) {
  console.log('Node update:', update);
}
```

**Stream LLM tokens (real-time):**
```typescript
const stream = await agent.stream(
  { messages: [{ role: 'user', content: 'Explain LangGraph' }] },
  { streamMode: 'messages' }
);

for await (const [message, _metadata] of stream) {
  if (message.content) {
    process.stdout.write(message.content);
  }
}
```

**Stream multiple modes:**
```typescript
const stream = await agent.stream(
  { messages: [{ role: 'user', content: 'Research topic' }] },
  { streamMode: ['updates', 'messages', 'debug'] }
);

for await (const [mode, data] of stream) {
  console.log(`[${mode}]:`, data);
}
```

### Helper Utilities

Deep Agents provides streaming utilities for common patterns:

```typescript
import { 
  processStream, 
  StreamingPresets, 
  TokenAccumulator 
} from 'deepagents';

// Use preset configurations
const stream = await agent.stream(input, StreamingPresets.PRODUCTION);

// Process stream with custom handlers
await processStream(stream, {
  onTodosUpdate: (todos) => {
    console.log('✓ Todos:', todos.map(t => `${t.status}: ${t.content}`));
  },
  onFilesUpdate: (files) => {
    console.log('✓ Files:', Object.keys(files));
  },
  onToken: (token) => {
    process.stdout.write(token);
  },
  onComplete: (finalState) => {
    console.log('\n✓ Complete!', finalState);
  },
});

// Accumulate tokens for later use
const accumulator = new TokenAccumulator();
for await (const [message] of stream) {
  if (message.content) {
    accumulator.add(message.content);
  }
}
console.log('Full response:', accumulator.getText());
```

### Streaming Presets

```typescript
StreamingPresets.FULL_STATE      // { streamMode: "values" }
StreamingPresets.UPDATES_ONLY    // { streamMode: "updates" }
StreamingPresets.LLM_TOKENS      // { streamMode: "messages" }
StreamingPresets.ALL             // { streamMode: ["values", "updates", "messages"] }
StreamingPresets.PRODUCTION      // { streamMode: ["updates", "messages"] }
```

### Advanced: Streaming from Sub-Agents

Sub-agent executions are automatically streamed as part of the parent agent's stream:

```typescript
const agent = createDeepAgent({
  tools: [searchTool],
  subagents: [researchSubAgent, writerSubAgent],
  instructions: 'You coordinate research...',
});

const stream = await agent.stream(
  { messages: [{ role: 'user', content: 'Research and write report' }] },
  { streamMode: 'updates' }
);

for await (const update of stream) {
  // Updates include both main agent and sub-agent activities
  if (update.todos) console.log('Todos updated');
  if (update.files) console.log('Files updated');
  if (update.messages) console.log('Messages updated');
}
```

See [examples/streaming-basic.ts](./examples/streaming-basic.ts) and [examples/streaming-advanced.ts](./examples/streaming-advanced.ts) for complete demonstrations.

---

## 📚 Documentation

For comprehensive guides, API references, and advanced usage:

- **[Official Documentation](https://docs.langchain.com/labs/deep-agents/overview)**
- **[API Reference](https://docs.langchain.com/labs/deep-agents/api)**
- **[Streaming Guide](./STREAMING.md)** - Complete streaming documentation with examples
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
