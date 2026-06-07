# Swarm

Process many independent items in parallel. `create` builds a table handle;
`run` fans work out across rows and merges results back. One row = one unit
of work — swarm handles batching automatically.

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

Write the entire pipeline — create, all run passes, rows retrieval, and
aggregation — in a **single eval script**. Do not split operations across
multiple tool calls. Each round-trip through the interpreter is expensive;
a single script avoids unnecessary overhead and prevents context loss
between evals.

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
detailed results to files and only `console.log` a compact summary with
counts and file paths. After the eval completes, you still have full access
to the data — just `readFile` the results path if you need more detail to
answer the user.

```javascript
// Write full results to a file — keeps them out of the tool response
await tools.writeFile({
  file_path: "/results/findings.json",
  content: JSON.stringify(confirmed, null, 2),
});

// Log only a compact summary — this is what comes back as the tool response
console.log(`=== SUMMARY ===`);
console.log(`${confirmed.length}/${total.length} findings confirmed`);
console.log(`  Critical: ${confirmed.filter(f => f.severity === "critical").length}`);
console.log(`  High: ${confirmed.filter(f => f.severity === "high").length}`);
console.log(`Full results: /results/findings.json`);
```

For multi-file output, organize by category or stage:

```javascript
await tools.writeFile({ file_path: "/results/pass1-findings.json", content: ... });
await tools.writeFile({ file_path: "/results/pass2-verified.json", content: ... });
console.log("Results written to /results/pass1-findings.json and /results/pass2-verified.json");
```

**Rule of thumb**: `console.log` the shape (counts, severity breakdown,
file paths), write the details to files. After the eval completes, read
the results file to formulate your response. This keeps the eval tool
response small while preserving full access to the data.

## API

### `create(source)` → `SwarmHandle`

Create a table from a source specification. Returns a lightweight handle
with `id`, `count`, and `columns`.

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

Shared prose prepended to every subagent prompt. Use for project-wide
background that applies to all rows:

```javascript
await run(table.id, {
  instruction: "Analyze {file}",
  context: "This is a React project using TypeScript and Tailwind CSS.",
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
