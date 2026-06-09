# Swarm

Process many items in parallel by dispatching a table of rows to subagents.

**A swarm table is a spreadsheet.** Each `run()` adds new columns to the
existing rows — the properties on `responseSchema` become row columns.
Use `filter` to choose which rows the next `run()` processes. Multi-stage
analysis is just multiple `run()` calls on the same table, each
conditioned on columns produced by an earlier run.

**Tables persist across evals within a turn — but re-import each eval.**
A table you `create` in one eval is still there in later evals: keep its
`id` and pass it to subsequent `run`/`reduce`/`rows` calls. Do NOT call
`create` again for a table you already built. **However, imported names do
NOT carry over** — start every eval with `import { create, run, reduce, rows }
from "swarm";` (a bare `run(...)` in a later eval throws `run is not
defined`). In short: re-import the functions each eval, reuse the table
handle. (Only the table data persists between evals; variable/import
bindings reset. Everything resets between separate user turns.) Doing a
whole workflow in one eval avoids this entirely and saves round-trips, but
splitting is fine as long as each eval re-imports and reuses the handle.

**Land results with `reduce`, not raw `rows`.** To turn the table into a
human-facing answer, `reduce()` synthesizes it in a separate subagent
context and returns only the result — keeping the raw data out of your
context. Dumping `rows()` (or files) back into your context floods it.

## Quick Start

```javascript
import { create, run, rows } from "swarm";

const table = await create({
  tasks: [
    { id: "1", text: "Loved the product!" },
    { id: "2", text: "Shipping was slow." },
  ],
});

// `label` becomes a column on every row
await run(table.id, {
  instruction: "Classify {text} as positive, negative, or neutral",
  responseSchema: {
    type: "object",
    properties: { label: { type: "string" } },
    required: ["label"],
  },
});

const data = await rows(table.id);
```

## Compose with Multiple Runs on One Table

The most powerful pattern is **one table, multiple `run()` passes, with
filters narrowing the work each pass**. The table grows columns; filters
select rows by the columns earlier runs produced.

Walk through a row's lifecycle:

```
After create():     { id: "users.ts", file: "src/users.ts" }
After classify run: { id, file, category: "handler" }
After review run:   { id, file, category, vulnerabilities: [...], severity: "high" }
After verify run:   { id, file, category, vulnerabilities, severity, confirmed: true }
```

Same row, same `id`, more columns. Each `run` writes its `responseSchema`
properties onto the existing row.

### Canonical Multi-Stage Pipeline

```javascript
import { create, run, reduce } from "swarm";

const table = await create({ glob: "src/**/*.ts" });

// Stage 1 — invoke mode (no subagentType): cheap classification on every row
await run(table.id, {
  instruction: "Classify {file} as 'handler', 'util', or 'test'",
  responseSchema: {
    type: "object",
    properties: { category: { type: "string" } },
    required: ["category"],
  },
});

// Stage 2 — agent mode, ONLY on handlers (filter uses Stage 1's column)
await run(table.id, {
  instruction:
    "Review {file} for SQL injection and missing auth checks. " +
    "Cite line numbers.",
  filter: { column: "category", equals: "handler" },
  subagentType: "reviewer",
  responseSchema: {
    type: "object",
    properties: {
      vulnerabilities: { type: "array", items: { type: "string" } },
      severity: { type: "string" },
    },
    required: ["vulnerabilities", "severity"],
  },
});

// Stage 3 — verify only high-severity findings (filter uses Stage 2's column)
await run(table.id, {
  instruction:
    "Independently verify these vulnerabilities found in {file}: " +
    "{vulnerabilities}. Are they real?",
  filter: { column: "severity", equals: "high" },
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

// Synthesize a human-facing report — raw rows stay out of your context
const report = await reduce(table.id, {
  filter: {
    and: [
      { column: "severity", equals: "high" },
      { column: "confirmed", equals: true },
    ],
  },
  instruction:
    "Write a security report of the confirmed high-severity findings, " +
    "grouped by file. Include line numbers and a one-line fix for each.",
});

console.log(report);
```

Every stage operates on the same rows; filters control which rows
participate. Stage 1 uses invoke mode (cheap, no tools) to tag rows for
later stages to filter on.

### When to Use a New Table vs. Filter the Existing One

Default to **filtering the same table**. Only create a new table when row
identity needs to change.

| Situation | Approach |
|---|---|
| Different work for a subset of existing rows | Same table + `filter` |
| Aggregating info into rows you already have | Same table — schema adds columns |
| One input row produces N output items, each needs its own dispatch | New table from flattened rows |
| Items have no natural relationship to existing rows | New table |

When one row produces N items that each need their own dispatch, flatten
them into a new table:

```javascript
const files = await rows(fileTable.id);
const findingTable = await create({
  tasks: files.flatMap((r) =>
    (r.findings ?? []).map((f, i) => ({
      id: `${r.id}-${i}`,
      file: r.file,
      title: f.title,
    })),
  ),
});
// Now dispatch verification per finding...
```

If you're tempted to flatten just to attach more columns to existing
items — don't. Filter the original table instead.

## Write Effective Dispatches

Subagents have the full agentic loop. Vague prompts produce expensive,
unfocused work — a "review this file" dispatch can spend 30 iterations
chasing imports and grepping callers. Do the thinking upfront so each
dispatch is scoped.

Two levers: a specific `instruction` and a constraining `context`. Read
a representative file first so you know what to ask for and what to
forbid.

```javascript
const sample = await tools.readFile({ file_path: "src/api/users.ts" });

await run(table.id, {
  instruction:
    "In {file}, find SQL injection in query construction, " +
    "unvalidated request params, and missing auth checks on routes. " +
    "Cite line numbers.",
  context:
    "Express + Knex. Auth middleware is router-level — flag routes " +
    "needing additional permission checks. Analyze only the dispatched " +
    "file: do not read imports, trace dependencies, or grep the codebase.",
  subagentType: "reviewer",
  responseSchema: findingsSchema,
});
```

`context` is prepended to every subagent prompt — use it to tell
subagents what NOT to do. Every extra tool call grows the subagent's
prompt for the next call, so constraints compound.

## Get Results Out Without Flooding Your Context

The table keeps row data in the sandbox during the fan-out. The trap is
pulling it all back at the end: `rows()` followed by `console.log` of the
data — or `writeFile` then `readFile` — drops the entire dataset into your
context in one shot, undoing the isolation the table bought you.

There are two right ways to land results, depending on what you need:

**1. Acting on the data → keep it in the sandbox.** If the next step is
more work per row (verify, fix, re-classify), chain another `run()` with a
filter. The data never needs to enter your context — see "Compose with
Multiple Runs on One Table" above.

**2. A human-facing answer → `reduce()` it.** When you need a synthesized
report, summary, or judgment over the rows, use `reduce()`. It dispatches
the synthesis to a separate subagent context and returns only the result —
the raw rows never touch your context. When the rows are too large for one
context, `reduce()` automatically fans out into parallel sub-reducers and
combines their summaries, so it scales past a single window.

```javascript
const report = await reduce(table.id, {
  filter: { column: "confirmed", equals: true },
  instruction:
    "Write a security report of the confirmed findings, grouped by file, " +
    "ordered by severity. Include line numbers.",
});
console.log(report); // small, synthesized — the only thing crossing back
```

Reach for `console.log(await rows(...))` only for **small** results (a
handful of rows, or a count you computed in JS). For anything large or
narrative, `reduce()` — never dump raw rows into your context, and don't
use files as a workaround for *reading* (reading a file back into context
is the same flood).

**Persisting results to a file is fine — and is different from reading them
back.** If asked to save structured output (e.g. to `/results/output.json`),
do it from *inside* the eval: `const r = await rows(table.id); await
tools.writeFile({ file_path: "/results/output.json", content:
JSON.stringify(r) });`. The rows stay in the sandbox and only a small
write-confirmation returns — your context is never flooded. Persisting and
`reduce()` compose: write the structured artifact for downstream use, and
`reduce()` for the human-facing summary.

## API Reference

### `create(source)` → `SwarmHandle`

Returns a lightweight handle with `id`, `count`, `columns`. Call `create`
once per table and reuse the returned `id` for all later `run`/`reduce`/`rows`
calls — including in subsequent evals.

| Source | Description |
|---|---|
| `glob` | Glob pattern(s). Each match → `{ id, file }` row. |
| `filePaths` | Explicit list. Same `{ id, file }` shape. |
| `tasks` | Custom rows. Each object must include a string `id`. |

### `run(tableId, options)` → `RunResult`

Dispatches work across matching rows and merges results back as columns.

| Option | Description |
|---|---|
| `instruction` | Template with `{column}` placeholders interpolated per-row. |
| `context` | Shared prose prepended to every subagent prompt. |
| `filter` | Select a subset of rows. See Filtering. |
| `subagentType` | Subagent name for agent mode. Omit for invoke mode. |
| `responseSchema` | JSON Schema (`type: "object"`). Properties become row columns. |
| `batchSize` | Number or `(row, total) => number` for row grouping. |
| `concurrency` | Max concurrent dispatches (1–10, default 10). |

Returns `{ completed, failed, skipped, failures }`. Note `skipped` counts
rows excluded by the filter — that's expected when filtering, not an error.

#### Agent vs. Invoke Mode

- **Agent mode** (`subagentType` set): full agentic loop with tools.
  Expensive. Use for code review, research, anything requiring iteration.
- **Invoke mode** (no `subagentType`): single model call, structured
  output, no tools. Cheap. Use for classification, extraction, labeling —
  especially as a Stage 1 to tag rows for later filtering.

```javascript
// Invoke — cheap classification, no tools
await run(table.id, {
  instruction: "Classify {text} as positive/negative/neutral",
  responseSchema: {
    type: "object",
    properties: { sentiment: { type: "string" } },
    required: ["sentiment"],
  },
});

// Agent — full loop
await run(table.id, {
  instruction: "Review {file} thoroughly",
  subagentType: "reviewer",
  responseSchema: { ... },
});
```

#### Instruction Placeholders

`{column}` is interpolated per-row. Strings insert verbatim; numbers and
booleans are stringified; arrays and objects are JSON-encoded (so
`{vulnerabilities}` for an array column produces `["...", "..."]` in
the prompt). Dot paths for nested: `{meta.score}`. `run()` validates
every placeholder resolves on at least one matched row.

### `rows(tableId, options?)` → `Record<string, unknown>[]`

Read rows for JS-side aggregation or to write to a file.

| Option | Description |
|---|---|
| `filter` | Only return matching rows. |
| `columns` | Project to specific columns. |
| `limit` | Max rows to return. |

```javascript
const confirmed = await rows(table.id, {
  filter: { column: "confirmed", equals: true },
  columns: ["id", "file", "vulnerabilities"],
});
```

Use `rows()` for in-JS logic (counts, branching, building a new table) or
small results. For large or human-facing output, use `reduce()` instead —
`rows()` pulls raw data into your context.

### `reduce(tableId, options)` → `string`

Synthesize rows into a single artifact via a subagent, keeping the raw
data out of your context. Returns only the synthesized string. When the
rows exceed one context, `reduce()` fans out into parallel sub-reducers
and combines their summaries automatically.

| Option | Description |
|---|---|
| `instruction` | How to synthesize, e.g. "Summarize findings by file". |
| `filter` | Only synthesize matching rows. |
| `columns` | Project to specific columns first (drop large unused ones). |
| `subagentType` | Run reduction in agent mode (with tools). Omit for a single model call. |
| `concurrency` | Max concurrent sub-reducers (1–10) when fanning out. |
| `tokenBudget` | Approx. row-data tokens per reducer before splitting. Has a sane default. |

```javascript
const report = await reduce(table.id, {
  filter: { column: "confirmed", equals: true },
  instruction: "Write a report of confirmed findings, grouped by file.",
});
console.log(report);
```

## Filtering

Used by `run()`, `rows()`, and `reduce()`.

**Leaf predicates:**

```javascript
{ column: "status", equals: "pending" }
{ column: "status", notEquals: "completed" }
{ column: "lang", in: ["en", "fr", "de"] }
{ column: "result", exists: true }    // non-null
{ column: "result", exists: false }   // null/undefined
```

**Combinators:**

```javascript
{ and: [
  { column: "category", equals: "handler" },
  { column: "severity", equals: "high" },
]}

{ or: [...] }
```

Dot-path access: `{ column: "meta.score", exists: true }`.

## Batching

Swarm auto-batches to stay within concurrency (max 10). Pass
`batchSize: N` to force N rows per dispatch (multi-row batches use a
wrapped schema the model fills per-row).

## Notes

- **Persistence**: Table *data* lives for the whole turn — a handle from one
  eval works in every later eval. But *imports and variables* do not carry
  across evals; re-import `{ create, run, reduce, rows }` at the top of each
  eval. Everything resets between separate user turns.
- **Handle-based**: `create()` returns a small handle; row data stays
  in the sandbox. Use `rows()` to pull data when you need it.
- **Failures**: `RunResult.failures` groups errors by message with counts
  and row IDs. Use to decide whether to retry.
- **Placeholder validation**: `run()` errors if a `{column}` placeholder
  resolves on no matched row.
