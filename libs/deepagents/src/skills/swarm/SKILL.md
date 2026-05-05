---
name: swarm
description: >-
  Dispatches many independent items in parallel: create a table, fan out to
  subagents, aggregate results. One row = one unit of work.
module: ./index.ts
metadata:
  required-ptc-tools: task read_file write_file glob
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
`eval`, then pass the records. One record = one row — do not group
multiple items into a single row.

For small files (under ~500 lines), parse and create in one block:

```javascript
const { create } = await import("@/skills/swarm");
const raw = await tools.readFile({ file_path: "/data.jsonl" });
const records = raw.trim().split("\n").map(l => JSON.parse(l));
const table = await create({ tasks: records });
console.log(table);
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
console.log(table);
```

When the file is too large to parse and dispatch in one `eval` call, split
across two blocks. Only the block that calls swarm functions needs the import:

```javascript
// eval 1: parse only — no swarm import needed
const raw = await tools.readFile({ file_path: "/data.jsonl" });
globalThis.records = raw.trim().split("\n").map(l => JSON.parse(l));
console.log(`Parsed ${globalThis.records.length} records`);
```

```javascript
// eval 2: create and dispatch
const { create, run } = await import("@/skills/swarm");
const table = await create({ tasks: globalThis.records });
const result = await run(table, { instruction: "Classify {text}", column: "label" });
console.log(result);
```

Passing `filePaths: ["/data.jsonl"]` would produce a table with **one row**
pointing at the file — not one row per record inside it.

## Instruction + context

`instruction` is a per-item template with `{column}` placeholders.
Placeholders are resolved by the framework — your column names appear in
prompts as references to the values listed alongside, never as raw
template syntax. Subagents do the work — do not process items yourself in
JS and write the results into rows.

`context` is free-form prose prepended to every subagent prompt. Use it for
shared background: domain terms, classification rules, examples, etc.

```javascript
const { create, run } = await import("@/skills/swarm");

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
const { run } = await import("@/skills/swarm");
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
const { rows } = await import("@/skills/swarm");
const data = await rows(table, { columns: ["sentiment"] });
const counts = {};
data.forEach(r => { counts[r.sentiment] = (counts[r.sentiment] || 0) + 1 });
console.log(counts);
// → { positive: 120, negative: 45, neutral: 35 }
```

## Chaining passes

`run` updates the table in place — chain calls to accumulate columns.

```javascript
const { create, run } = await import("@/skills/swarm");
const table = await create({ tasks: interviews });
await run(table, { instruction: "Classify sentiment of {text}", column: "sentiment" });
await run(table, {
  filter: { column: "sentiment", equals: "negative" },
  instruction: "Summarize why {text} had negative sentiment.",
  column: "summary",
});
```

## Action-only tasks

When subagents perform actions (write a file, apply a fix) rather than return
data, the result column serves as a completion marker. The `column` default
(`"result"`) still tracks which rows succeeded, and `exists: false` filtering
still works for retries.

```javascript
const { create, run } = await import("@/skills/swarm");
const table = await create({ glob: "src/**/*.ts" });
await run(table, {
  instruction: "Add missing JSDoc to all exported functions in {file}.",
  column: "fixed",
});
// retry any that failed
await run(table, {
  instruction: "Add missing JSDoc to all exported functions in {file}.",
  column: "fixed",
  filter: { column: "fixed", exists: false },
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

- **Only import `@/skills/swarm` in blocks where you call swarm functions.**
  Data preparation (reading files, parsing, storing in `globalThis`) does not
  need the import. Destructure only what you use: `{ create }`, `{ run }`,
  `{ create, run }`, etc.
- **Console output is capped at ~5 KB.** Never log raw file contents —
  log only counts and short samples.
- **`readFile` inside `eval` returns raw content — no line-number
  prefixes.** Request at most 500 lines per call. For files with more
  than 500 lines, loop with incrementing `offset`.
- **When building a table from a file, read it inside `eval`.** Data read
  inside the sandbox stays there; it never enters the agent's context window.
- **Never write to `.swarm/` directly.** Always use `create()`.
- **Everything the subagent needs must be in `instruction` + `context`.**
  Subagents can't see the agent's context.
- **Row ids must be unique.** `create()` rejects sources that produce
  duplicate ids. For `tasks`, that's a caller-side responsibility; for
  `glob` / `filePaths`, ids are auto-disambiguated by parent directory.
- **Unknown columns fail fast.** If `instruction` references `{foo}` and
  no matched row provides `foo`, `run()` throws before any subagent is
  dispatched.

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
| `concurrency` | `10` | Max concurrent subagent dispatches (clamped to 1–10) |

### `rows(handle, options?)`

Retrieve rows. Use for inspection and JS-based aggregation.

| Option | Description |
|--------|------------|
| `filter` | Only return matching rows |
| `columns` | Project to specific columns |
| `limit` | Max rows returned |
