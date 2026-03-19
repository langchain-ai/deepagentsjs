# `@langchain/secure-exec`

A sandboxed JavaScript/TypeScript REPL for [deepagents](https://github.com/langchain-ai/deepagentsjs) powered by [secure-exec](https://secureexec.dev). An alternative to `@langchain/quickjs` that runs code inside a real Node.js V8 worker instead of WASM-sandboxed QuickJS.

---

## Comparison vs `@langchain/quickjs`

| Concern                 | `@langchain/quickjs`                         | `@langchain/secure-exec`                     |
| ----------------------- | -------------------------------------------- | -------------------------------------------- |
| Sandbox engine          | QuickJS WASM (emscripten)                    | V8 Node.js worker                            |
| Node.js APIs            | None (`require` blocked)                     | Full Node.js stdlib (opt-in)                 |
| `npm` modules           | Not possible                                 | Possible with `NodeFileSystem`               |
| TypeScript support      | AST-level stripping (no type errors)         | `@secure-exec/typescript` (real TS compiler) |
| Memory limit unit       | Bytes (`memoryLimitBytes`)                   | Megabytes (`memoryLimitMb`)                  |
| CPU timeout             | Interrupt-handler based                      | Process-level `cpuTimeLimitMs`               |
| State persistence model | Live VM context (functions persist natively) | Source-code accumulation (see below)         |
| WASM dependency         | Yes                                          | No                                           |

---

## Installation

```bash
pnpm add @langchain/secure-exec
```

---

## Quick Start

```typescript
import { createDeepAgent } from "deepagents";
import { createSecureExecMiddleware } from "@langchain/secure-exec";
import { ChatAnthropic } from "@langchain/anthropic";

const agent = createDeepAgent({
  model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
  systemPrompt: "You are a coding assistant.",
  middleware: [
    createSecureExecMiddleware({
      memoryLimitMb: 128,
      cpuTimeLimitMs: 60_000,
      ptc: true,
    }),
  ],
});

const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content: "Write a function to compute fibonacci numbers and test it.",
    },
  ],
});
```

---

## Drop-in Migration from `@langchain/quickjs`

```typescript
// Before
import { createQuickJSMiddleware } from "@langchain/quickjs";
const middleware = createQuickJSMiddleware({ ptc: true });

// After (rename only)
import { createSecureExecMiddleware } from "@langchain/secure-exec";
const middleware = createSecureExecMiddleware({ ptc: true });
// Note: memoryLimitBytes → memoryLimitMb (unit changed from bytes to megabytes)
```

---

## Options Reference

| Option           | Type                                                | Default        | Description                                        |
| ---------------- | --------------------------------------------------- | -------------- | -------------------------------------------------- |
| `backend`        | `AnyBackendProtocol \| BackendFactory`              | `StateBackend` | Backend for `readFile`/`writeFile` inside the REPL |
| `ptc`            | `boolean \| string[] \| { include } \| { exclude }` | `false`        | Enable programmatic tool calling                   |
| `memoryLimitMb`  | `number`                                            | `64`           | Memory limit in **megabytes**                      |
| `cpuTimeLimitMs` | `number`                                            | `30000`        | CPU time budget per evaluation in ms               |
| `allowNodeFs`    | `boolean`                                           | `false`        | Allow sandbox to use Node.js `fs` APIs             |
| `allowNetwork`   | `boolean`                                           | `false`        | Allow outbound network access                      |
| `systemPrompt`   | `string \| null`                                    | `null`         | Override the built-in system prompt                |

---

## Persistence Model

`@langchain/secure-exec` uses **source-code accumulation** to persist state across evals. Each `js_eval` call spawns a fresh V8 isolate, but all prior top-level *declaration* statements are prepended as a preamble before the new code runs.

### What persists

```typescript
// Eval 1: define a function
function greet(name: string) {
  return `Hello, ${name}!`;
}

// Eval 2: the function is available (re-declared from source)
greet("World"); // → "Hello, World!"
```

### What does NOT persist

- **Mutable object state**: An object created in a prior eval is re-instantiated on each call.
- **Side effects**: A network call made during a `const result = await fetch(...)` declaration will re-run on every subsequent eval.

### Avoid this pattern at the top level

```typescript
// ❌ This will re-execute on every subsequent eval
const data = await fetch("https://api.example.com/data").then(r => r.json());
```

Instead, wrap side-effectful code in a function or an expression statement:

```typescript
// ✅ Define the fetcher as a function (persists without re-executing)
async function fetchData() {
  return fetch("https://api.example.com/data").then(r => r.json());
}

// ✅ Then call it as an expression in a separate eval
await fetchData();
```

---

## Programmatic Tool Calling (PTC)

Enable PTC to make agent tools callable from within the REPL:

```typescript
const middleware = createSecureExecMiddleware({
  ptc: true, // expose all tools (except VFS tools)
  // or:
  // ptc: ["web_search", "calculator"], // specific tools
  // ptc: { exclude: ["my_internal_tool"] }, // all except these
});
```

Inside the REPL, tools are available as `async tools.<camelCaseName>(input)`:

```typescript
// In js_eval
const result = await tools.webSearch({ query: "secure-exec Node.js" });
console.log(result);
```

---

## Limitations

- **No outbound network** by default (use `allowNetwork: true` to enable).
- **No child processes** (`execSync`, `spawn`, etc. are blocked).
- **CPU time limit**: 30 seconds per call (configurable via `cpuTimeLimitMs`).
- **Memory limit**: 64 MB per session (configurable via `memoryLimitMb`).
- **Mutable object state resets** on each eval due to the source-accumulation model.
- Node.js only — `NodeRuntime` requires a Node.js host environment.
