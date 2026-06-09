# Swarm

Process many items in parallel by dispatching a table of rows to subagents.

**A swarm table is a spreadsheet.** Each `run()` adds new columns to the
existing rows — the properties on `responseSchema` become row columns.
Use `filter` to choose which rows the next `run()` processes. Multi-stage
analysis is just multiple `run()` calls on the same table, each
conditioned on columns produced by an earlier run.

**Write the whole pipeline in one eval.** Tables are session-scoped — they
exist only inside the eval script that created them. `create`, every
`run`, and `rows` must live in the same eval. Splitting across evals
throws "table not found."

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
import { create, run, rows } from "swarm";

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

// Aggregate with a filter on rows()
const confirmed = await rows(table.id, {
  filter: {
    and: [
      { column: "severity", equals: "high" },
      { column: "confirmed", equals: true },
    ],
  },
});

await tools.writeFile({
  file_path: "/results/findings.json",
  content: JSON.stringify(confirmed, null, 2),
});

console.log(`${confirmed.length} confirmed high-severity findings`);
console.log("Results: /results/findings.json");
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

## Manage Output Size

Everything you `console.log` comes back as the tool response. Write
detailed results to files; log only counts and file paths. After the
eval completes you can `readFile` the results if you need detail to
answer the user.

```javascript
await tools.writeFile({
  file_path: "/results/findings.json",
  content: JSON.stringify(confirmed, null, 2),
});

console.log(`${confirmed.length}/${total} findings confirmed`);
console.log(`Results: /results/findings.json`);
// DO NOT loop and log per-item details.
```

## API Reference

### `create(source)` → `SwarmHandle`

Returns a lightweight handle with `id`, `count`, `columns`. Always call
inside the same eval as `run` and `rows`.

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

## Filtering

Used by both `run()` and `rows()`.

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

- **Session-scoped**: Tables live only inside the eval that created them.
  No cross-eval persistence.
- **Handle-based**: `create()` returns a small handle; row data stays
  in the sandbox. Use `rows()` to pull data when you need it.
- **Failures**: `RunResult.failures` groups errors by message with counts
  and row IDs. Use to decide whether to retry.
- **Placeholder validation**: `run()` errors if a `{column}` placeholder
  resolves on no matched row.
