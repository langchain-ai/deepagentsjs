---
name: swarm
description: >-
  REQUIRED when a dataset exceeds ~50 KB or ~100 items — do not attempt to
  process large inputs manually. Dispatches work across many independent items
  in parallel: create a table, fan out to subagents, aggregate results.
module: ./index.ts
required-ptc-tools:
  - task
  - read_file
  - write_file
  - glob
---

# Swarm

Process many independent items in parallel. `create` builds a table handle;
`run` fans work out across rows and merges results back. One row = one unit
of work.

## When to use

**Trigger condition**: You MUST use swarm when a dataset file exceeds ~50 KB
or contains more than ~100 independent items. At that scale, manual processing
is unreliable and will produce wrong results — swarm is the correct tool.

Also use swarm when many items each need the same independent operation,
regardless of size.

## When NOT to use

- Fewer than ~5 items (just call `tools.task()` directly)
- Items depend on each other's output (use sequential tool calls instead)

## Flow

1. **Explore.** Read **5 lines max** with `read_file` as an agent tool —
   not inside `js_eval`. One read is almost always enough. Once you can
   describe the line format and what column to extract, stop and move on.
   Do NOT create a table yet.
2. **Create.** In a `js_eval`, read the **complete** input and call
   `create()` once. When the file is large, read in chunks of ~200 lines
   and accumulate. Log only counts — never log raw content (see Rules).
3. **Execute.** `run` with an `instruction` template and optional
   `context`. Returns `{ completed, failed, skipped, failures }`.
4. **Aggregate.** Inspect with `rows()` or chain another `run` pass.

Use separate `js_eval` calls for each step — do NOT write create + run +
inspect in a single cell.

## Choosing a source

**`glob` / `filePaths`** — one file = one row. Use when each file is an
independent unit of work (e.g. code review across a repo, summarising a
folder of documents). Each row gets `{ id, file }`; the subagent reads
the file itself via the `{file}` placeholder.

**`tasks`** — pass pre-built records directly. Use when the data to process
lives inside a file (e.g. a JSONL dataset, a CSV, a JSON array). Read and
parse the file first, then pass the records:

```javascript
const raw = await readFile("/data.jsonl");
const records = raw.trim().split("\n").map(l => JSON.parse(l));
const table = await create({ tasks: records });
```

Passing `filePaths: ["/data.jsonl"]` would produce a table with **one row**
pointing at the file — not one row per record inside it.

## Rules

- **One sample read, then build.** One `read_file` at the agent level is
  enough to understand the format. Do not do multiple exploration reads.
  Do not use `js_eval` for exploration — use it only to build the table and
  run swarm.
- **Never `console.log` raw file contents in `js_eval`.** Console output is
  capped at ~5 KB. Logging a full file will truncate, making you think data
  is missing when it isn't. Log only counts and short samples:
  `console.log('lines:', lines.length, 'sample:', lines[0])`.
- **Sample at the agent level, read fully in js_eval.** Use a small-limit
  `read_file` (agent tool) to understand the format. Then read the complete
  input inside `js_eval` when building the table — the data stays inside
  the sandbox, not in your context window.
- **Everything the subagent needs must be in `instruction` + `context`.**
  Subagents can't see your notes.
- **Results are final.** Don't dispatch recheck/verify tasks. Fix the
  instruction and re-dispatch failed rows via `filter`.
- **One retry for failures, then move on.**
- **Never write to `.swarm/` directly.** Always use `create()` to build
  tables — it handles persistence, eviction, and sequencing.

## Instruction + context

`instruction` is a per-item template with `{column}` placeholders
(interpolated from each row).

`context` is free-form prose prepended to every subagent prompt. Put
dataset-wide information here: what the data is, domain terms,
classification rules, edge cases, examples.

```javascript
const { create, run, rows } = await import("@/skills/swarm");

const table = await create({ glob: "src/**/*.ts" });
const r = await run(table, {
  instruction: "Review {file} for security issues. List findings or write 'no issues'.",
  context: "TypeScript Express backend using Prisma ORM. Focus on injection, auth bypass, path traversal.",
  column: "review",
});
console.log(r);
// → { completed: 45, failed: 2, skipped: 0, failures: [...] }
```

## Structured output

Use `responseSchema` for programmatic aggregation. Schema properties become
top-level columns on each row.

```javascript
await run(table, {
  instruction: "Classify: {text}",
  responseSchema: {
    type: "object",
    properties: {
      sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
      confidence: { type: "number" },
    },
    required: ["sentiment", "confidence"],
  },
});
// Row after: { id: "r1", text: "...", sentiment: "positive", confidence: 0.95 }
```

## Batching

Batching is automatic — when a table has more than 50 rows, `run()` groups
them into batches to keep total subagent dispatches bounded. You don't need
to configure this.

## Chaining passes

`run` updates the table in place — chain calls to accumulate columns.

```javascript
const table = await create({ tasks: interviews });
await run(table, { instruction: "Classify sentiment of {file}", column: "sentiment" });
await run(table, {
  filter: { column: "sentiment", equals: "negative" },
  instruction: "Summarize why {file} had negative sentiment.",
  column: "summary",
});
```

## Filtering

`filter: { column: "result", exists: false }` — re-dispatch unprocessed rows.

```javascript
{ column: "status", equals: "done" }
{ column: "status", notEquals: "done" }
{ column: "category", in: ["A", "B"] }
{ column: "review", exists: false }      // null or undefined
{ and: [filter1, filter2] }
{ or: [filter1, filter2] }
```

## Inspecting results

```javascript
const issues = await rows(table, {
  filter: { column: "review", notEquals: "no issues" },
  columns: ["file", "review"],
});
console.log(issues);
```

Aggregation:

```javascript
const data = await rows(table, { columns: ["sentiment"] });
const counts = {};
data.forEach(r => { counts[r.sentiment] = (counts[r.sentiment] || 0) + 1 });
console.log(counts);
// → { positive: 120, negative: 45, neutral: 35 }
```

## API Reference

### `create(source)`

Create a table. Returns a handle `{ id, count, columns }`.

| Source | Description |
|--------|------------|
| `{ glob: "src/**/*.ts" }` | Match files by pattern. Columns: `id`, `file` |
| `{ filePaths: ["a.ts", "b.ts"] }` | Explicit file list. Columns: `id`, `file` |
| `{ tasks: [{ id: "t1", text: "..." }] }` | Custom rows. Each must have `id` |

### `run(handle, options)`

Dispatch work across rows. Returns `{ completed, failed, skipped, failures }`.

| Option | Default | Description |
|--------|---------|------------|
| `instruction` | (required) | Template with `{column}` placeholders |
| `context` | — | Prose prepended to every subagent prompt |
| `column` | `"result"` | Column name for the result |
| `filter` | — | Only dispatch matching rows |
| `subagentType` | `"general-purpose"` | Subagent to use |
| `responseSchema` | — | JSON Schema for structured output |

### `rows(handle, options?)`

Retrieve rows. Use for inspection and JS-based aggregation.

| Option | Description |
|--------|------------|
| `filter` | Only return matching rows |
| `columns` | Project to specific columns |
| `limit` | Max rows returned |
