# Evals

Behavioural evaluations for `deepagents`. Each subdirectory is an independent
workspace package containing vitest tests that run a real agent against LLM
APIs and assert on the resulting trajectory.

Results are streamed to [LangSmith](https://smith.langchain.com) as experiments
so you can compare runs across models and track regressions over time.

## Available eval suites

| Suite                                                | Description                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`basic/`](./basic/)                                 | System prompt adherence, simple reasoning, avoiding unnecessary tool calls       |
| [`files/`](./files/)                                 | File operations — read, write, edit, ls, grep, glob, parallel I/O, deep nesting  |
| [`followup-quality/`](./followup-quality/)           | Clarifying question quality for underspecified user requests                        |
| [`hitl/`](./hitl/)                                   | Human-in-the-loop interrupt behavior, review configs, resume after approval      |
| [`external-benchmarks/`](./external-benchmarks/)     | Curated hard-set from FRAMES, Nexus, and BFCL v3 benchmark samples               |
| [`memory/`](./memory/)                               | AGENTS.md memory injection — recall, guided behavior, multiple sources, graceful fallback |
| [`memory-agent-bench/`](./memory-agent-bench/)       | MemoryAgentBench-style long-context memorization and retrieval scenarios          |
| [`memory-multiturn/`](./memory-multiturn/)           | Multi-turn memory persistence: implicit preferences, explicit instructions, transient filtering |
| [`skills/`](./skills/)                               | Skill file discovery, reading, selection, combination, and editing via skill source paths |
| [`subagents/`](./subagents/)                         | Subagent delegation — `task` tool routing to named and general-purpose subagents |
| [`summarization/`](./summarization/)                 | Summarization middleware behavior and conversation-history offloading             |
| [`tau2-airline/`](./tau2-airline/)                   | Tau2-airline inspired policy-grounded airline support tasks                       |
| [`todos/`](./todos/)                                 | Sequential `write_todos` state updates and completion behavior                     |
| [`tool-selection/`](./tool-selection/)               | Direct/indirect tool routing and multi-step chaining across mock integrations      |
| [`tool-usage-relational/`](./tool-usage-relational/) | Multi-step tool chaining with relational data lookups (users, locations, foods)  |

## Running evals

Evals require the `EVAL_RUNNER` environment variable to select a model runner.
Available runners are registered in
[`internal/eval-harness/src/setup.ts`](../internal/eval-harness/src/setup.ts):

You also need `LANGSMITH_API_KEY` set for result tracking (and the appropriate
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` for the model you choose).

```bash
# Run all eval suites with Sonnet 4.5
EVAL_RUNNER=sonnet-4-5 pnpm test:eval

# Run a single suite
EVAL_RUNNER=sonnet-4-5 pnpm --filter @deepagents/eval-basic test:eval

# Run with a different model
EVAL_RUNNER=gpt-4.1 pnpm --filter @deepagents/eval-files test:eval
```

## Writing a new eval

1. Create a new directory under `evals/` (e.g. `evals/my-eval/`).

2. Add a `package.json`:

   ```json
   {
     "name": "@deepagents/eval-my-eval",
     "private": true,
     "type": "module",
     "scripts": {
       "test:eval": "vitest run"
     },
     "dependencies": {
       "@deepagents/evals": "workspace:*",
       "deepagents": "workspace:*",
       "langsmith": "^0.5.4",
       "vitest": "^4.0.18"
     }
   }
   ```

3. Add a `vitest.config.ts`:

   ```ts
   import { defineConfig } from "vitest/config";

   export default defineConfig({
     test: {
       environment: "node",
       globals: false,
       testTimeout: 120_000,
       hookTimeout: 60_000,
       teardownTimeout: 60_000,
       include: ["**/*.test.ts"],
       setupFiles: ["@deepagents/evals/setup"],
       reporters: ["default", "langsmith/vitest/reporter"],
     },
   });
   ```

4. Write your test in `index.test.ts`:

   ```ts
   import * as ls from "langsmith/vitest";
   import { expect } from "vitest";
   import { getDefaultRunner } from "@deepagents/evals";

   const runner = getDefaultRunner();

   ls.describe(
     runner.name,
     () => {
       ls.test(
         "my test case",
         { inputs: { query: "Hello" } },
         async ({ inputs }) => {
           const result = await runner.run({ query: inputs.query });
           expect(result).toHaveAgentSteps(1);
         },
       );
     },
     { projectName: "deepagents-js-my-eval", upsert: true },
   );
   ```

5. Run `pnpm install` from the repo root to link the new workspace.

### Customising the agent per test

Use `runner.extend()` to create a derived runner with different agent
configuration. The `run()` method only takes invocation params (`query`,
`initialFiles`).

```ts
// Custom system prompt
const result = await runner
  .extend({ systemPrompt: "Your name is Foo Bar." })
  .run({ query: "What is your name?" });

// Custom tools
const result = await runner
  .extend({ tools: [myTool] })
  .run({ query: "Use the tool." });

// Custom subagents
const result = await runner
  .extend({
    subagents: [
      { name: "helper", description: "A helper agent", tools: [myTool] },
    ],
  })
  .run({ query: "Delegate to the helper." });

// Seed files
const result = await runner.run({
  query: "Read /data.txt",
  initialFiles: { "/data.txt": "hello world" },
});
```

### Custom matchers

The harness provides vitest matchers that also log LangSmith feedback:

- `toHaveAgentSteps(n)` — assert exact step count
- `toHaveToolCallRequests(n)` — assert total tool-call count
- `toHaveToolCallInStep(step, { name, argsContains?, argsEquals? })` — assert a specific tool call in a step (1-indexed)
- `toHaveFinalTextContaining(text, caseInsensitive?)` — assert the final response contains text

## Architecture

See [`internal/eval-harness/README.md`](../internal/eval-harness/README.md)
for details on the harness internals.
