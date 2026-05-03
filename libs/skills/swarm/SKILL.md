---
name: swarm
description: >-
  Dispatches many independent items in parallel: create a table, fan out to
  subagents, aggregate results. One row = one unit of work.
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
of work — swarm handles batching automatically.

## Flow

1. **Create.** Build a table from a source — files, a glob pattern, or
   pre-parsed records. One row per item. Returns a handle.
2. **Run.** Dispatch an `instruction` template across rows. Results are merged
   back into the table. Returns `{ completed, failed, skipped, failures }`.
3. **Aggregate.** Use `rows()` and plain JS to count, filter, or summarize.
   Do not spawn additional subagents for aggregation.
4. **Retry.** Re-run with `filter: { column: "<col>", exists: false }` to
   reprocess only failed rows.

## Choosing a source

**`glob` / `filePaths`** — one file = one row. Use when each file is an
independent unit of work. Each row gets `{ id, file }`; the subagent reads
the file itself via the `{file}` placeholder.

**`tasks`** — pass pre-built records directly. Use when the data lives inside
a file (JSONL, CSV, JSON array). Read and parse the file first inside
`js_eval`, then pass the records. One record = one row — do not group
multiple items into a single row.

For small files (under ~500 lines):

```javascript
const raw = await tools.readFile({ file_path: "/data.jsonl" });
const records = raw.trim().split("\n").map(l => JSON.parse(l));
const table = await create({ tasks: records });
```

For large files, read in chunks of 500 lines to avoid truncation:

```javascript
const { create } = await import("@/skills/swarm");
let records = [];
let offset = 0;
while (true) {
  const chunk = await tools.readFile({ file_path: "/data.txt", offset, limit: 500 });
  const lines = chunk.split("\n").filter(l => l.trim());
  for (const l of lines) { records.push({ id: `r${records.length}`, text: l }); }
  if (lines.length < 500) break;
  offset += 500;
}
const table = await create({ tasks: records });
```

Passing `filePaths: ["/data.jsonl"]` would produce a table with **one row**
pointing at the file — not one row per record inside it.

## Instruction + context

`instruction` is a per-item template with `{column}` placeholders
(interpolated from each row). Subagents do the work — do not process items
yourself in JS and write the results into rows.

`context` is free-form prose prepended to every subagent prompt. Use it for
shared background: domain terms, classification rules, examples, etc.

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

Use `responseSchema` when the output is a known set of values. Schema
properties become top-level columns on each row and improve accuracy by
constraining what subagents can return.

```javascript
await run(table, {
  instruction: "Classify: {text}",
  responseSchema: {
    type: "object",
    properties: {
      sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
    },
    required: ["sentiment"],
  },
});
// Row after: { id: "r1", text: "...", sentiment: "positive" }
```

## Aggregation

After `run()`, use `rows()` and plain JS — no additional subagents needed.

```javascript
const data = await rows(table, { columns: ["sentiment"] });
const counts = {};
data.forEach(r => { counts[r.sentiment] = (counts[r.sentiment] || 0) + 1 });
console.log(counts);
// → { positive: 120, negative: 45, neutral: 35 }
```

## Chaining passes

`run` updates the table in place — chain calls to accumulate columns.

```javascript
const table = await create({ tasks: interviews });
await run(table, { instruction: "Classify sentiment of {text}", column: "sentiment" });
await run(table, {
  filter: { column: "sentiment", equals: "negative" },
  instruction: "Summarize why {text} had negative sentiment.",
  column: "summary",
});
```

## Filtering

```javascript
{ column: "status", equals: "done" }
{ column: "status", notEquals: "done" }
{ column: "category", in: ["A", "B"] }
{ column: "result", exists: false }      // not yet processed
{ and: [filter1, filter2] }
{ or: [filter1, filter2] }
```

## Technical notes

- **Console output is capped at ~5 KB.** Never log raw file contents —
  log only counts and short samples.
- **`readFile` inside `js_eval` returns raw content — no line-number
  prefixes.** Request at most 500 lines per call. For files with more
  than 500 lines, loop with incrementing `offset`.
- **When building a table from a file, read it inside `js_eval`.** Data read
  inside the sandbox stays there; it never enters the agent's context window.
- **Never write to `.swarm/` directly.** Always use `create()`.
- **Everything the subagent needs must be in `instruction` + `context`.**
  Subagents can't see the agent's context.

## API Reference

### `create(source)`

Create a table. Returns a handle `{ id, count, columns }`.

| Source | Description |
|--------|------------|
| `{ glob: "src/**/*.ts" }` or `{ glob: ["src/**/*.ts", "lib/**/*.ts"] }` | Match files by one or more patterns. Columns: `id`, `file` |
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
| `batchSize` | auto | Rows per subagent call |

### `rows(handle, options?)`

Retrieve rows. Use for inspection and JS-based aggregation.

| Option | Description |
|--------|------------|
| `filter` | Only return matching rows |
| `columns` | Project to specific columns |
| `limit` | Max rows returned |
