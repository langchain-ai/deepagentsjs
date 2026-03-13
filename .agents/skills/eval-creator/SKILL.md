---
name: eval-writer
description: "Create new eval suites for the deepagentsjs monorepo. Handles dataset design, test case scaffolding, scoring logic, vitest configuration, and LangSmith integration. Use when the user asks to: (1) create an eval, (2) write an evaluation, (3) add a benchmark, (4) build an eval suite, (5) evaluate agent behaviour, (6) add test cases for a capability, or (7) implement an existing benchmark (e.g. oolong, AgentBench, SWE-bench). Trigger on phrases like 'create eval', 'new eval', 'add eval', 'benchmark', 'evaluate', 'eval suite', 'write evals for'."
---

# Eval Writer

Create new eval suites for the `deepagentsjs` monorepo. Each eval is an
independent workspace package under `evals/` that uses the `@deepagents/evals`
harness, runs via vitest, and reports results to LangSmith.

## Before you start

Read the existing eval infrastructure to understand current patterns:

```
internal/eval-harness/src/index.ts    # EvalRunner, RunAgentParams, matchers
internal/eval-harness/src/deepagent.ts # DeepAgentEvalRunner, extend()
internal/eval-harness/src/setup.ts     # Registered runners
evals/README.md                        # User-facing docs
internal/eval-harness/README.md        # Harness internals
```

Scan existing evals for conventions:

```
evals/basic/index.test.ts     # Simple: system prompt, reasoning
evals/files/index.test.ts     # File ops: read, write, edit, glob, grep
evals/subagents/index.test.ts # Delegation: task tool, named subagents
```

## Workflow

### 1. Understand the eval requirements

Clarify with the user:

- **What capability** is being evaluated? (file ops, tool use, multi-turn reasoning, memory, code generation, etc.)
- **Where do test cases come from?** Options:
  - **Inline** — hardcoded in the test file (simple, good for <20 cases)
  - **JSON/JSONL fixture** — checked into the eval package (good for 20-200 cases)
  - **External dataset** — downloaded at setup time (good for published benchmarks)
  - **LangSmith dataset** — pulled from LangSmith API (good for collaborative curation)
- **How should results be scored?** Options:
  - **Trajectory matchers** — step count, tool calls, final text (built-in)
  - **Exact/fuzzy match** — compare output to reference (simple)
  - **LLM-as-judge** — use a model to grade the output (complex evals)
  - **Code execution** — run generated code and check results (SWE-bench style)
  - **Custom evaluator** — domain-specific scoring function
- **Does the agent need special configuration?** (custom tools, subagents, system prompt, initial files)

### 2. Create the eval package

Every eval is a workspace package under `evals/<name>/`.

#### Directory structure

```
evals/<name>/
├── package.json
├── vitest.config.ts
├── index.test.ts
├── README.md
└── (optional) fixtures/       # JSON/JSONL test data
└── (optional) vitest.setup.ts  # Dataset loading, custom setup
└── (optional) evaluators.ts   # Custom scoring functions
```

#### package.json

```json
{
  "name": "@deepagents/eval-<name>",
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

Add extra dependencies as needed (e.g. `zod` for tool schemas, `langchain`
for `tool()` helper, dataset-specific packages).

#### vitest.config.ts

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

Adjust `testTimeout` for long-running evals (multi-turn, code execution).
Add `"./vitest.setup.ts"` to `setupFiles` if the eval needs custom setup (dataset loading, etc.).

#### README.md

```markdown
# <name>

<One-line description of what this eval tests.>
```

#### Verify workspace registration

Check that `pnpm-workspace.yaml` includes `"evals/*"`. It should already
be there — if not, add it.

### 3. Design test cases

#### Pattern A: Inline test cases (simple evals)

Best for small, hand-crafted test suites. Each test is an `ls.test()` call
with `inputs` and optional `referenceOutputs`.

```ts
ls.test(
  "descriptive test name",
  {
    inputs: { query: "What is 2+2?" },
    referenceOutputs: { expectedAnswer: "4" },
  },
  async ({ inputs, referenceOutputs }) => {
    const result = await runner.run({ query: inputs.query });
    // assertions...
  },
);
```

#### Pattern B: Data-driven with ls.test.each (medium evals)

Best for 10-200 cases from a fixture file. Load the data and iterate:

```ts
import testCases from "./fixtures/cases.json";

// testCases = [{ inputs: { query: "..." }, referenceOutputs: { answer: "..." } }, ...]

ls.test.each(testCases)(
  "case: ${inputs.query}",
  async ({ inputs, referenceOutputs }) => {
    const result = await runner.run({ query: inputs.query });
    // assertions using referenceOutputs...
  },
);
```

The fixture JSON must be an array of objects with at minimum `{ inputs: {...} }`.
Optional fields: `referenceOutputs`, `id`, `metadata`, `split`.

#### Pattern C: External dataset (published benchmarks)

For published benchmarks (oolong, AgentBench, SWE-bench, etc.), download
and cache the dataset in a setup file.

Create `vitest.setup.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const CACHE_DIR = join(import.meta.dirname, ".cache");
const DATA_PATH = join(CACHE_DIR, "dataset.json");

export async function loadDataset(): Promise<TestCase[]> {
  if (existsSync(DATA_PATH)) {
    return JSON.parse(readFileSync(DATA_PATH, "utf-8"));
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  // Download from source — adapt to the specific benchmark
  const response = await fetch("https://example.com/dataset.json");
  const data = await response.json();

  // Transform into eval format
  const cases = data.map((item: any) => ({
    inputs: { query: item.question },
    referenceOutputs: { answer: item.gold_answer },
    metadata: { source: item.id, category: item.category },
  }));

  writeFileSync(DATA_PATH, JSON.stringify(cases, null, 2));
  return cases;
}
```

Add `.cache/` to `.gitignore` in the eval package.

Then register it as a vitest setup file in `vitest.config.ts`:

```ts
setupFiles: ["@deepagents/evals/setup", "./vitest.setup.ts"],
```

And in the test file:

```ts
import { loadDataset } from "./vitest.setup.js";

const dataset = await loadDataset();

ls.describe(runner.name, () => {
  ls.test.each(dataset)(
    "${metadata.source}: ${inputs.query}",
    async ({ inputs, referenceOutputs }) => {
      // ...
    },
  );
}, { projectName: "deepagents-js-<name>", upsert: true });
```

#### Pattern D: LangSmith dataset

Pull test cases from a LangSmith dataset. Useful for collaborative curation
where non-engineers add examples via the LangSmith UI.

```ts
import { Client } from "langsmith";

const client = new Client();

export async function loadDataset(): Promise<TestCase[]> {
  const examples = [];
  for await (const example of client.listExamples({
    datasetName: "my-dataset-name",
  })) {
    examples.push({
      id: example.id,
      inputs: example.inputs,
      referenceOutputs: example.outputs ?? {},
    });
  }
  return examples;
}
```

### 4. Write scoring logic

#### Built-in trajectory matchers

The harness provides vitest matchers that also log LangSmith feedback scores.
Use these as the primary building blocks:

```ts
// Exact step count
expect(result).toHaveAgentSteps(3);

// Exact tool-call count across all steps
expect(result).toHaveToolCallRequests(2);

// Check a specific tool call in step N (1-indexed)
expect(result).toHaveToolCallInStep(1, {
  name: "write_file",
  argsContains: { file_path: "/out.txt" },  // partial match
  argsEquals: { file_path: "/out.txt" },     // exact match
});

// Final response text
expect(result).toHaveFinalTextContaining("hello", true /* caseInsensitive */);

// Extract final text for custom assertions
import { getFinalText } from "@deepagents/evals";
const text = getFinalText(result);
expect(text.trim()).toBe("4");

// File system assertions
expect(result.files["/output.md"]).toContain("expected content");
expect(Object.keys(result.files)).toHaveLength(3);
```

#### Custom feedback logging

Log additional LangSmith feedback scores beyond what matchers provide:

```ts
import * as ls from "langsmith/vitest";

// Numeric score
ls.logFeedback({ key: "accuracy", score: 0.95 });

// Boolean score
ls.logFeedback({ key: "correct", score: 1 });

// With comment
ls.logFeedback({ key: "quality", score: 0.8, comment: "Minor formatting issue" });
```

#### LLM-as-judge evaluators

For subjective quality, use `ls.wrapEvaluator()` to create a traced evaluator
that logs feedback automatically:

```ts
import * as ls from "langsmith/vitest";
import { ChatAnthropic } from "@langchain/anthropic";

const judge = new ChatAnthropic({ model: "claude-sonnet-4-5-20250929" });

const evaluateHelpfulness = ls.wrapEvaluator(
  async ({ inputs, outputs, referenceOutputs }) => {
    const response = await judge.invoke([
      {
        role: "system",
        content: `Rate the helpfulness of the assistant's response on a scale of 0-1.
          Respond with JSON: { "score": <number>, "reasoning": "<explanation>" }`,
      },
      {
        role: "user",
        content: `Question: ${inputs.query}\nExpected: ${referenceOutputs.answer}\nActual: ${outputs.response}`,
      },
    ]);

    const parsed = JSON.parse(response.content as string);
    return {
      key: "helpfulness",
      score: parsed.score,
      comment: parsed.reasoning,
    };
  },
);

// In a test:
const result = await runner.run({ query: inputs.query });
const text = getFinalText(result);
await evaluateHelpfulness({
  inputs: { query: inputs.query },
  outputs: { response: text },
  referenceOutputs: referenceOutputs ?? {},
});
```

### 5. Wire up the test file

#### Minimal template

```ts
import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner, getFinalText } from "@deepagents/evals";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
  () => {
    ls.test(
      "test name",
      {
        inputs: { query: "..." },
        referenceOutputs: { answer: "..." },
      },
      async ({ inputs, referenceOutputs }) => {
        const result = await runner.run({ query: inputs.query });

        expect(result).toHaveAgentSteps(1);
        expect(result).toHaveFinalTextContaining(referenceOutputs.answer);
      },
    );
  },
  { projectName: "deepagents-js-<name>", upsert: true },
);
```

#### Key conventions

- **`getDefaultRunner()`** — reads `EVAL_RUNNER` env var. Throws if not set.
- **`runner.name`** — used as `ls.describe` name → becomes the LangSmith dataset name.
- **`runner.run({ query, initialFiles? })`** — pure invocation. Returns `AgentTrajectory`.
- **`runner.extend({ systemPrompt?, tools?, subagents?, ... })`** — returns a new runner with agent config overrides. Use for tests that need custom agent setup.
- **`projectName`** in `ls.describe` config — sets the LangSmith project for tracing. Convention: `"deepagents-js-<eval-name>"`.
- **`upsert: true`** — reuse existing dataset/project instead of creating new ones each run.
- **Always import `expect` from `vitest`** — the harness extends it with custom matchers at import time.
- **`ls.logOutputs()`** is called inside the runner — do NOT call it in test code.

#### Using extend() for custom agent config

```ts
// Custom system prompt
const result = await runner
  .extend({ systemPrompt: "You are a code reviewer." })
  .run({ query: inputs.query });

// Custom tools
const result = await runner
  .extend({ tools: [myCustomTool] })
  .run({ query: inputs.query });

// Custom subagents
const result = await runner
  .extend({
    subagents: [{
      name: "researcher",
      description: "Research assistant",
      systemPrompt: "You help with research.",
      tools: [searchTool],
    }],
  })
  .run({ query: inputs.query });
```

#### Using initialFiles for seeded state

```ts
const result = await runner.run({
  query: "Read /data.csv and count the rows.",
  initialFiles: {
    "/data.csv": "name,age\nAlice,30\nBob,25\n",
  },
});
```

#### Sandbox-backed evals (containerized execution)

The default eval runners use the in-memory `StateBackend` — the agent can
read/write files but cannot execute shell commands, install packages, or
interact with a real OS. This is fine for testing tool selection, reasoning,
and file operations.

For evals that need real execution (SWE-bench, code generation, agentic
benchmarks), the agent must run against a sandbox backend. Available
sandbox providers:

| Provider | Package | Use case |
| --- | --- | --- |
| Modal | `@deepagents/modal` | Remote containers, GPU support |
| Daytona | `@deepagents/daytona` | Cloud dev environments |
| Deno | `@deepagents/deno` | Lightweight local sandboxes |
| Node VFS | `@deepagents/node-vfs` | In-process virtual filesystem + shell |

Pass the sandbox via `extend({ backend })`. Manage its lifecycle with
`beforeAll` / `afterAll` (suite-level) or `beforeEach` / `afterEach`
(per-test isolation):

```ts
import * as ls from "langsmith/vitest";
import { expect, beforeAll, afterAll } from "vitest";
import { getDefaultRunner, getFinalText } from "@deepagents/evals";
import { ModalSandbox } from "@deepagents/modal";

const runner = getDefaultRunner();
let sandbox: ModalSandbox;

beforeAll(async () => {
  sandbox = await ModalSandbox.create({
    image: "python:3.12-slim",
    timeout: 600,
  });
});

afterAll(async () => {
  await sandbox?.terminate();
});

ls.describe(
  runner.name,
  () => {
    ls.test(
      "agent can run python",
      { inputs: { query: "Write a Python script that prints 'hello' and run it." } },
      async ({ inputs }) => {
        const result = await runner
          .extend({ backend: sandbox })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("hello");
      },
    );
  },
  { projectName: "deepagents-js-sandbox-eval", upsert: true },
);
```

For per-test isolation (each test gets a fresh sandbox):

```ts
import { beforeEach, afterEach } from "vitest";

let sandbox: ModalSandbox;

beforeEach(async () => {
  sandbox = await ModalSandbox.create({ image: "python:3.12-slim" });
});

afterEach(async () => {
  await sandbox?.terminate();
});
```

**When to containerize:**
- The eval requires `execute()` (shell commands)
- The eval involves installing packages or modifying system state
- The eval runs untrusted or generated code
- Tests need filesystem isolation from each other

**When in-memory is fine:**
- Testing tool selection, reasoning, or response quality
- File read/write/edit operations (handled by `StateBackend` + `initialFiles`)
- System prompt adherence, subagent routing

Add the sandbox provider to `package.json` dependencies:

```json
{
  "dependencies": {
    "@deepagents/modal": "workspace:*"
  }
}
```

And increase `testTimeout` in `vitest.config.ts` — sandbox creation adds
overhead:

```ts
testTimeout: 300_000,  // 5 minutes for sandbox evals
hookTimeout: 120_000,  // sandbox setup/teardown
```

### 6. Install and verify

```bash
# From repo root
pnpm install

# Build the harness (if you changed it)
cd internal/eval-harness && pnpm build && cd ../..

# Run the new eval
EVAL_RUNNER=sonnet-4-5 pnpm --filter @deepagents/eval-<name> test:eval
```

### 7. Update documentation

Add the new eval to `evals/README.md` in the "Available eval suites" table:

```markdown
| [`<name>/`](./<name>/) | <one-line description> |
```

## Parity with Python deepagents evals

The Python `deepagents` package has eval suites in
`libs/deepagents/tests/evals/`. The JS evals should maintain parity.
When creating a new eval, check the Python source at
`https://github.com/langchain-ai/deepagents/blob/v0.5/libs/deepagents/tests/evals/`
for the reference implementation.

### Current parity status

| Python eval | JS eval | Status |
| --- | --- | --- |
| `test_system_prompt.py` | `evals/basic/` | ✅ Covered |
| `test_file_operations.py` | `evals/files/` | ✅ Covered |
| `test_subagents.py` | `evals/subagents/` | ✅ Covered |
| `test_memory.py` | `evals/memory/` | ✅ Covered |
| `test_hitl.py` | `evals/hitl/` | ✅ Covered |
| `test_skills.py` | `evals/skills/` | ✅ Covered |
| `test_summarization.py` | `evals/summarization/` | ❌ **Missing** |

### Notes on HITL evals

HITL evals require multi-step invocation (invoke → check interrupts → resume
with `Command`). The eval runner's `run()` does a single invocation, so HITL
tests construct agents directly via `createDeepAgent()` with a `checkpointer`
and `interruptOn` config. See `evals/hitl/index.test.ts` for the pattern.

### Notes on summarization evals

Summarization evals need `SummarizationMiddleware` with low token thresholds,
a checkpointer, a real/virtual filesystem backend, and multi-turn invocations.
These tests would bypass the standard `EvalRunner` and construct agents
directly, similar to HITL.

## Reference: ls.test.each API

`ls.test.each` is the most powerful pattern for data-driven evals. The table
must be an array of objects with at least `{ inputs }`:

```ts
ls.test.each([
  { inputs: { query: "Q1" }, referenceOutputs: { answer: "A1" } },
  { inputs: { query: "Q2" }, referenceOutputs: { answer: "A2" } },
  // Optional additional fields: id, metadata, split
  { id: "custom-id", inputs: { query: "Q3" }, referenceOutputs: { answer: "A3" }, split: "hard" },
])(
  "case: ${inputs.query}",  // Name template — interpolates from row
  async ({ inputs, referenceOutputs, testMetadata }) => {
    // testMetadata.exampleId, testMetadata.datasetId, etc.
    const result = await runner.run({ query: inputs.query });
    // ...
  },
);
```

## Reference: LangSmith integration

### How datasets map

| Concept | LangSmith entity |
| --- | --- |
| `ls.describe(name, ...)` | Dataset (name = dataset name) |
| `ls.test(name, { inputs, referenceOutputs }, fn)` | Example in dataset |
| Running the test suite | Experiment on the dataset |
| `ls.logFeedback(...)` | Feedback on the experiment run |
| `ls.logOutputs(...)` | Experiment output (called by runner) |

### Environment variables

| Variable | Purpose |
| --- | --- |
| `EVAL_RUNNER` | Which model runner to use (e.g. `sonnet-4-5`) |
| `LANGSMITH_API_KEY` | LangSmith auth |
| `LANGSMITH_PROJECT` | Override tracing project (normally set via `projectName`) |
| `LANGSMITH_TEST_TRACKING` | Set to `"false"` to disable LangSmith reporting |
| `ANTHROPIC_API_KEY` | For Anthropic model runners |
| `OPENAI_API_KEY` | For OpenAI model runners |

### Available runners

Defined in `internal/eval-harness/src/setup.ts`:

| Runner name | Model |
| --- | --- |
| `sonnet-4-5` | Claude Sonnet 4.5 |
| `sonnet-4-5-thinking` | Claude Sonnet 4.5 with extended thinking |
| `opus-4-6` | Claude Opus 4.6 |
| `gpt-4.1` | GPT-4.1 |
| `gpt-4.1-mini` | GPT-4.1 Mini |
| `o3-mini` | o3-mini |

## Reference: Implementing published benchmarks

When implementing an existing benchmark, follow these attribution and
methodology guidelines.

### Attribution

Always credit the original benchmark authors. In the eval's `README.md`:

```markdown
# <benchmark-name>

Implementation of [<Benchmark Name>](<paper-or-repo-url>) by <authors> (<year>).

> <brief description from the paper abstract>

## Citation

\`\`\`bibtex
@article{...}
\`\`\`

## Adaptations

<Describe any differences from the original benchmark methodology:>
- <e.g. "Subset of N cases selected for cost efficiency">
- <e.g. "Adapted for agentic tool-use evaluation rather than direct QA">
- <e.g. "Uses LLM-as-judge instead of human annotation">
```

### Common benchmark patterns

#### QA / Factual benchmarks (e.g. MMLU, TrivialQA)

- Test cases: question + gold answer
- Scoring: exact match or fuzzy match on final text
- Pattern: `ls.test.each` with fixture JSON

#### Multi-turn / Conversational (e.g. MT-Bench)

- Test cases: conversation turns that build on each other
- Scoring: LLM-as-judge on each turn
- Pattern: sequential `runner.run()` calls sharing state, or multi-message queries

#### Tool-use benchmarks (e.g. ToolBench, API-Bank)

- Test cases: task requiring specific tool calls
- Scoring: trajectory matchers (correct tools called, correct args)
- Pattern: `runner.extend({ tools: [...] })` with custom tools that return canned responses

#### Code generation (e.g. HumanEval, SWE-bench)

- Test cases: problem description + test suite
- Scoring: execute generated code, check test results
- **Requires sandbox**: yes — agent must run code and observe output
- Pattern: `runner.extend({ backend: sandbox })`, write code to file, execute tests via sandbox

#### Memory / Long-context (e.g. oolong, needle-in-haystack)

- Test cases: large context + retrieval question
- Scoring: whether the agent finds the target information
- **Requires sandbox**: no — seed files via `initialFiles`, check final text
- Pattern: in-memory `StateBackend` is sufficient

#### Agentic benchmarks (e.g. AgentBench, WebArena)

- Test cases: multi-step tasks requiring planning
- Scoring: combination of trajectory analysis + final state checking
- **Requires sandbox**: yes — agent needs shell access, package installs, environment interaction
- Pattern: `runner.extend({ backend: sandbox })` with per-test sandbox isolation

### Handling large datasets

For benchmarks with thousands of cases:

1. **Subset selection** — pick a representative subset (e.g. 100 cases per category). Document the selection criteria.
2. **Split support** — use `split` field in test cases to categorise (e.g. `"easy"`, `"hard"`). Run subsets via vitest filtering.
3. **Caching** — download once, cache in `.cache/` (gitignored).
4. **Cost awareness** — estimate API cost before running. Log it in the README. Consider a `--dry-run` that validates fixtures without calling the LLM.
