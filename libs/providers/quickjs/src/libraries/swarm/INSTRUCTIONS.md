# Swarm

Process many independent items in parallel. `create` builds a table handle;
`run` fans work out across rows and merges results back. One row = one unit
of work — swarm handles batching automatically.

**IMPORTANT: Always write the complete pipeline — `create`, all `run` passes,
`rows`, and aggregation — in a single eval call.** Never split swarm
operations across multiple eval calls. Do not call `create` in one eval and
`run` in another. Do not use `glob` or `readFile` as separate tool calls to
explore files before creating a table — `create({ glob })` handles that for
you inside the eval. One eval, one complete pipeline.

## Quick Start

```javascript
import { create, run, rows } from "swarm";

const table = await create({ tasks: items });
const result = await run(table.id, {
  instruction: "Classify {text}",
  responseSchema: {
    type: "object",
    properties: { label: { type: "string" } },
    required: ["label"],
  },
});
const data = await rows(table.id);
```

## Compose Complete Pipelines

ALWAYS write the entire pipeline in a **single eval script**. This means
one eval that contains `create`, all `run` passes, `rows` retrieval, and
result aggregation together. Never split these across multiple eval calls.

Wrong — two separate evals:
```
// Eval 1
const table = await create({ glob: "src/**/*.ts" });
// Eval 2 (don't do this)
await run("t_abc123", { ... });
```

Right — one complete eval:
```javascript
import { create, run, rows } from "swarm";

// Create table from files on disk
const table = await create({ glob: "src/**/*.ts" });

// Pass 1: find issues
await run(table.id, {
  instruction: "Review {file} for bugs",
  subagentType: "bug-finder",
  responseSchema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            severity: { type: "string" },
          },
          required: ["title", "severity"],
        },
      },
    },
    required: ["findings"],
  },
});

// Pass 2: verify — flatten findings into a new table, dispatch each
const reviewed = await rows(table.id);
const allFindings = reviewed.flatMap((r) =>
  (r.findings || []).map((f) => ({ id: `${r.id}-${f.title}`, ...f, file: r.file }))
);
const verifyTable = await create({ tasks: allFindings });
await run(verifyTable.id, {
  instruction: 'Verify whether "{title}" in {file} is a real bug',
  subagentType: "verifier",
  responseSchema: {
    type: "object",
    properties: {
      confirmed: { type: "boolean" },
      reason: { type: "string" },
    },
    required: ["confirmed", "reason"],
  },
});

// Aggregate results in JS
const verified = await rows(verifyTable.id);
const confirmed = verified.filter((r) => r.confirmed);
console.log(`${confirmed.length}/${verified.length} findings confirmed`);
console.log(JSON.stringify(confirmed, null, 2));
```

## Manage Output Size

Swarm results can get large — dozens of findings with full descriptions
easily produce thousands of lines. Everything you `console.log` in an eval
comes back as the tool response, and an oversized tool response wastes
context window and slows you down.

Use the filesystem to keep the tool response small. During the eval, write
detailed results to files and only `console.log` counts and file paths.
Do NOT log individual finding titles, descriptions, reasons, or any
per-item details — that data belongs in the files. After the eval
completes, you still have full access — just `readFile` the results path
if you need more detail to answer the user.

```javascript
// Write full results to files
await tools.writeFile({
  file_path: "/results/findings.json",
  content: JSON.stringify(confirmed, null, 2),
});

// Log ONLY counts and file paths — nothing else
console.log(`${confirmed.length}/${total.length} findings confirmed`);
console.log(`  Critical: ${bySeverity.critical.length}`);
console.log(`  High: ${bySeverity.high.length}`);
console.log(`Results: /results/findings.json`);

// WRONG — do not loop over findings in console.log:
// for (const f of confirmed) {
//   console.log(`[${f.severity}] ${f.title}`);   // ← NO
//   console.log(`  ${f.description}`);            // ← NO
// }
```

**Rule of thumb**: `console.log` gets counts and file paths. The files
get everything else. After the eval, `readFile` the results to build
your response.

## Write Effective Instructions

The quality of your `instruction` and `context` directly determines how
well subagents perform. Vague instructions cause subagents to over-use
tools, produce shallow results, and waste time. Specific instructions
produce focused, faster work.

Bad — vague, subagent doesn't know what matters:
```javascript
await run(table.id, {
  instruction: "Review {file} for issues",
  subagentType: "reviewer",
  responseSchema: { ... },
});
```

Good — tells the subagent exactly what to look for and what to skip:
```javascript
await run(table.id, {
  instruction: "Find race conditions, resource leaks, and injection vectors in {file}. Cite line numbers. Ignore style and naming.",
  subagentType: "reviewer",
  responseSchema: { ... },
});
```

Use `context` to set shared constraints across all dispatches — scope the
task, constrain tool usage, or provide project background that applies to
every row:

```javascript
await run(table.id, {
  instruction: "Review {file} for bugs",
  context: "These are backend modules for an AI agent framework. Focus on the code provided. Only search the web to verify a specific API or pattern — do not search for general review guidance.",
  subagentType: "reviewer",
  responseSchema: { ... },
});
```

Thorough instructions and context help subagents work faster and produce
better results — invest the extra detail up front.

## API

### `create(source)` → `SwarmHandle`

Create a table from a source specification. Returns a lightweight handle
with `id`, `count`, and `columns`. Always call `create` inside the same
eval as `run` and `rows` — never in a separate eval.

**Source types** — exactly one of:

| Field | Description |
|-------|-------------|
| `glob` | Glob pattern(s). Each match → row with `{ id, file }` columns. |
| `filePaths` | Explicit file list. Same `{ id, file }` row shape as glob. |
| `tasks` | Custom row data. Each object must include a string `id` field. |

```javascript
// From glob
const t1 = await create({ glob: "src/**/*.ts" });

// From explicit paths
const t2 = await create({ filePaths: ["a.ts", "b.ts"] });

// From custom data
const t3 = await create({
  tasks: [
    { id: "1", text: "Hello world", lang: "en" },
    { id: "2", text: "Bonjour le monde", lang: "fr" },
  ],
});
```

### `run(tableId, options)` → `RunResult`

Dispatch work across table rows and update the table in place.

**Options:**

| Field | Type | Description |
|-------|------|-------------|
| `instruction` | `string` | Template with `{column}` placeholders interpolated per-row. |
| `context` | `string?` | Shared background prepended to every subagent prompt. |
| `filter` | `SwarmFilter?` | Select a subset of rows to process. |
| `subagentType` | `string?` | Name of the subagent for agent mode. Omit for invoke mode. |
| `responseSchema` | `object` | JSON Schema (`type: "object"`) for structured output. |
| `batchSize` | `number \| function?` | Controls row grouping. See Batching. |
| `concurrency` | `number?` | Max concurrent dispatches (1–10, default 10). |
| `recursionLimit` | `number?` | Max agentic loop iterations per dispatch (1–150, default 50). |

**Returns** `{ completed, failed, skipped, failures }`.

#### Instruction Templates

Use `{column}` placeholders that are interpolated per-row:

```javascript
await run(table.id, {
  instruction: "Review {file} for security issues",
  responseSchema: { ... },
});
```

Nested access via dot paths: `{meta.score}`, `{config.model}`.

#### Context

Shared prose prepended to every subagent prompt. Use `context` to shape
how subagents behave — constrain tool usage, set priorities, provide
project background, or scope the task. This is one of the most effective
levers for controlling subagent quality and cost.

```javascript
await run(table.id, {
  instruction: "Analyze {file}",
  context:
    "This is a React project using TypeScript and Tailwind CSS. " +
    "Focus on the code provided. Only use web search to verify " +
    "a specific API or pattern you are unsure about.",
  subagentType: "reviewer",
  responseSchema: { ... },
});
```

#### Dispatch Modes

- **Agent mode** (`subagentType` set): Full agentic loop with tools. The
  subagent can call tools, iterate, and reason. Use for complex tasks.
- **Invoke mode** (`subagentType` omitted): Direct model call with structured
  output. No tools, no iteration. Use for classification, extraction, labeling.

```javascript
// Agent mode — subagent has tools and can iterate
await run(table.id, {
  instruction: "Review {file} thoroughly",
  subagentType: "reviewer",
  responseSchema: { ... },
});

// Invoke mode — single model call, structured output
await run(table.id, {
  instruction: "Classify {text} as positive, negative, or neutral",
  responseSchema: {
    type: "object",
    properties: { sentiment: { type: "string" } },
    required: ["sentiment"],
  },
});
```

#### Response Schema

Every `run()` requires a `responseSchema` — a JSON Schema with `type: "object"`.
Each property in the schema becomes a column on the row after the run completes.

```javascript
await run(table.id, {
  instruction: "Extract entities from {text}",
  responseSchema: {
    type: "object",
    properties: {
      entities: {
        type: "array",
        items: { type: "string" },
      },
      count: { type: "number" },
    },
    required: ["entities", "count"],
  },
});
```

### `rows(tableId, options?)` → `Record<string, unknown>[]`

Retrieve rows from a table for inspection or JS-based aggregation.

**Options:**

| Field | Type | Description |
|-------|------|-------------|
| `filter` | `SwarmFilter?` | Only return matching rows. |
| `columns` | `string[]?` | Project to specific columns. |
| `limit` | `number?` | Max rows to return. |

```javascript
// All rows
const all = await rows(table.id);

// Filtered + projected
const failed = await rows(table.id, {
  filter: { column: "status", equals: "failed" },
  columns: ["id", "error"],
});
```

## Filtering

Filters select subsets of rows for `run()` or `rows()`.

**Leaf predicates:**

```javascript
{ column: "status", equals: "pending" }
{ column: "status", notEquals: "completed" }
{ column: "lang", in: ["en", "fr", "de"] }
{ column: "result", exists: true }    // non-null/undefined
{ column: "result", exists: false }   // null/undefined
```

**Combinators:**

```javascript
{ and: [
  { column: "status", equals: "failed" },
  { column: "retries", exists: true },
]}

{ or: [
  { column: "priority", equals: "high" },
  { column: "age", equals: "stale" },
]}
```

Dot-path column access: `{ column: "meta.score", exists: true }`.

## Batching

By default, swarm auto-batches rows to keep total dispatches within the
concurrency cap (max 10). You can override with `batchSize`:

```javascript
// Fixed batch size — 5 rows per subagent call
await run(table.id, {
  instruction: "Classify these items: {text}",
  batchSize: 5,
  responseSchema: { ... },
});

// Dynamic batch size — function receives (row, totalRows)
await run(table.id, {
  instruction: "Process {text}",
  batchSize: (row, total) => total > 100 ? 10 : 1,
  responseSchema: { ... },
});
```

Single-row batches produce interpolated per-row prompts. Multi-row batches
produce batch prompts with wrapped schemas that the model fills per-row.

## Chaining Runs

Chain multiple `run()` calls to build multi-stage pipelines. Each run
updates the table in place — new columns from the response schema are
merged onto existing rows.

```javascript
const table = await create({ glob: "src/**/*.ts" });

// Stage 1: classify
await run(table.id, {
  instruction: "Classify {file} as 'component', 'utility', or 'test'",
  responseSchema: {
    type: "object",
    properties: { category: { type: "string" } },
    required: ["category"],
  },
});

// Stage 2: review only components (uses column from stage 1)
await run(table.id, {
  instruction: "Review {file} for accessibility issues",
  filter: { column: "category", equals: "component" },
  subagentType: "reviewer",
  responseSchema: {
    type: "object",
    properties: {
      issues: { type: "array", items: { type: "string" } },
      severity: { type: "string" },
    },
    required: ["issues", "severity"],
  },
});
```

## Action-Only Tasks

For tasks that produce side effects (writing files, running commands) rather
than structured data, use a minimal response schema:

```javascript
await run(table.id, {
  instruction: "Fix the lint errors in {file}",
  subagentType: "fixer",
  responseSchema: {
    type: "object",
    properties: { fixed: { type: "boolean" } },
    required: ["fixed"],
  },
});
```

## Technical Notes

- **Concurrency**: Max 10 concurrent subagent dispatches per `run()`. Rows
  exceeding this are queued.
- **Table persistence**: Tables are stored as JSONL on the backend. The handle
  (`id`, `count`, `columns`) is lightweight — row data stays on disk.
- **Handle-based design**: `create()` returns a handle, not the data. Use
  `rows()` to retrieve data for JS-based aggregation. This keeps large
  datasets out of the agent's context window.
- **Failures**: `RunResult.failures` groups errors by message with counts
  and affected row IDs. Use this to decide whether to retry.
- **Placeholder validation**: `run()` validates that every `{column}`
  reference in the instruction resolves on at least one matched row.
