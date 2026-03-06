# @langchain/quickjs

Sandboxed JavaScript/TypeScript REPL for [deepagents](https://github.com/langchain-ai/deepagentsjs), powered by [QuickJS-NG](https://github.com/quickjs-ng/quickjs) through [QuickJS-Emscripten](https://github.com/justjake/quickjs-emscripten)

[![npm version](https://img.shields.io/npm/v/@langchain/quickjs.svg)](https://www.npmjs.com/package/@langchain/quickjs)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Installation

```bash
npm install @langchain/quickjs deepagents
```

## Quick Start

```typescript
import { createDeepAgent } from "deepagents";
import { createQuickJSMiddleware } from "@langchain/quickjs";

const agent = createDeepAgent({
  model: "claude-sonnet-4-5",
  middleware: [createQuickJSMiddleware()],
});

const result = await agent.invoke({
  messages: [
    { role: "user", content: "Calculate the first 20 Fibonacci numbers" },
  ],
});
```

The agent now has a `js_eval` tool. It can write and execute JavaScript/TypeScript in a sandboxed REPL where variables persist across calls:

```typescript
// Call 1: the agent writes
var fibs = [0, 1];
for (let i = 2; i < 20; i++) fibs.push(fibs[i - 1] + fibs[i - 2]);
console.log(fibs);

// Call 2: state persists — `fibs` is still available
console.log(`Sum: ${fibs.reduce((a, b) => a + b, 0)}`);
```

## Features

### WASM Sandbox

All code runs inside a QuickJS WASM interpreter. There is no `require`, no `import`, no `fetch`, no filesystem access — only the explicitly bridged helpers (`readFile`, `writeFile`, and optionally `tools.*`).

### TypeScript Support

LLMs naturally produce TypeScript. An AST-based transform pipeline strips type annotations, interfaces, and generics before evaluation — the model doesn't need to write pure JavaScript.

### Virtual Filesystem

The REPL has `readFile(path)` and `writeFile(path, content)` functions that read from and write to the agent's backend (LangGraph state by default):

```typescript
const raw = await readFile("/data.json");
const data = JSON.parse(raw);
const summary = { total: data.items.length };
await writeFile("/summary.json", JSON.stringify(summary, null, 2));
```

### Programmatic Tool Calling (PTC)

Any agent tool can be exposed inside the REPL as a typed async function. Instead of the LLM emitting tool calls one at a time, it writes code that calls tools directly — loops, conditionals, parallel execution, and result transformation all happen in code:

```typescript
const agent = createDeepAgent({
  model: "claude-sonnet-4-5-20250929",
  middleware: [
    createQuickJSMiddleware({
      ptc: true, // expose all agent tools inside the REPL
    }),
  ],
});
```

Inside the REPL, the agent can then write:

```typescript
const urls = ["/users", "/orders", "/products"];
const results = await Promise.all(
  urls.map((u) => tools.httpRequest({ url: "https://api.example.com" + u })),
);
const parsed = results.map((r) => JSON.parse(r));
console.log(`Users: ${parsed[0].length}, Orders: ${parsed[1].length}`);
```

PTC configuration is progressive:

| Value                   | Behavior                            |
| ----------------------- | ----------------------------------- |
| `false`                 | Disabled (default)                  |
| `true`                  | All agent tools except VFS builtins |
| `string[]`              | Only these tools                    |
| `{ include: string[] }` | Only these tools                    |
| `{ exclude: string[] }` | All tools except these              |

### Recursive Language Model (RLM)

When the `task` tool is exposed via PTC, the agent can spawn sub-agents in parallel from within the REPL:

```typescript
const agent = createDeepAgent({
  model: "claude-sonnet-4-5-20250929",
  subagents: [
    {
      name: "general-purpose",
      description: "Research agent",
      systemPrompt: "...",
    },
  ],
  middleware: [createQuickJSMiddleware({ ptc: ["task"] })],
});
```

The agent then writes code like:

```typescript
const topics = ["quantum computing", "fusion energy", "CRISPR"];
const results = await Promise.all(
  topics.map((topic) =>
    tools.task({
      description: `Research ${topic} in depth`,
      subagentType: "general-purpose",
    }),
  ),
);
const report = topics.map((t, i) => `## ${t}\n${results[i]}`).join("\n\n");
await writeFile("/research.md", report);
```

## API

### `createQuickJSMiddleware(options?)`

Creates a middleware that adds the `js_eval` tool to your agent.

```typescript
interface QuickJSMiddlewareOptions {
  backend?: BackendProtocol | BackendFactory; // File I/O backend (default: StateBackend)
  ptc?: boolean | string[] | { include: string[] } | { exclude: string[] }; // PTC config
  memoryLimitBytes?: number; // Default: 50MB
  maxStackSizeBytes?: number; // Default: 320KB
  executionTimeoutMs?: number; // Default: 30s (-1 to disable)
  systemPrompt?: string | null; // Override the built-in REPL system prompt
}
```

### `ReplSession`

The underlying session class. Usually you don't interact with this directly — the middleware manages sessions per thread.

```typescript
ReplSession.getOrCreate(id, options?)  // Get or create a session
ReplSession.get(id)                    // Look up existing session
session.eval(code, timeoutMs)          // Execute code
session.flushWrites(backend)           // Persist buffered file writes
session.toJSON() / ReplSession.fromJSON(data)  // Serialization
```

## License

MIT — see [LICENSE](./LICENSE).
