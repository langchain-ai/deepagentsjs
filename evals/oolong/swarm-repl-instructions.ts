import { createMiddleware } from "langchain";

export const SWARM_REPL_INSTRUCTIONS = `\
## Swarm-style table processing in the REPL

You have access to a set of helper functions for structured fan-out work.
These are NOT imports — paste the bootstrap block once at the top of your
first eval, then call \`create\`, \`run\`, \`rows\`, and \`reduce\` freely
in any subsequent eval.

### Bootstrap (paste once)

\`\`\`javascript
const _tables = {};

function _evalFilter(f, row) {
  if (!f) return true;
  if (f.and) return f.and.every((c) => _evalFilter(c, row));
  if (f.or) return f.or.some((c) => _evalFilter(c, row));
  const val = f.column.split(".").reduce((o, k) => o?.[k], row);
  if ("equals" in f) return val === f.equals;
  if ("notEquals" in f) return val !== f.notEquals;
  if ("in" in f) return f.in.includes(val);
  if ("exists" in f) return f.exists ? val != null : val == null;
  return true;
}

function _interp(tmpl, row) {
  return tmpl.replace(/\{([^}]+)\}/g, (_, path) => {
    const val = path.split(".").reduce((o, k) => o?.[k], row);
    if (val == null) return "";
    return typeof val === "string" ? val : JSON.stringify(val);
  });
}

async function _mapConc(items, fn, concurrency = 8) {
  const out = Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return out;
}

async function create(source) {
  const id = String(Object.keys(_tables).length);
  let tableRows;
  if (source.tasks) {
    tableRows = source.tasks.map((t) => ({ ...t }));
  } else if (source.filePaths) {
    tableRows = source.filePaths.map((f, idx) => ({
      id: String(idx),
      file: f,
    }));
  } else {
    tableRows = [];
  }
  _tables[id] = tableRows;
  return {
    id,
    count: tableRows.length,
    columns: Object.keys(tableRows[0] || {}),
  };
}

async function run(tableId, options) {
  const allRows = _tables[tableId];
  if (!allRows) throw new Error("Table not found: " + tableId);
  const matched = options.filter
    ? allRows.filter((r) => _evalFilter(options.filter, r))
    : allRows;
  const rowById = {};
  for (const r of allRows) rowById[String(r.id)] = r;
  let completed = 0,
    failed = 0;
  await _mapConc(
    matched,
    async (row) => {
      try {
        const prompt = _interp(options.instruction, row);
        const raw = await tools.subagent({
          description: options.context
            ? options.context + "\\n\\n" + prompt
            : prompt,
          ...(options.responseSchema && {
            response_schema: options.responseSchema,
          }),
        });
        const parsed = JSON.parse(raw);
        const target = rowById[String(row.id)];
        for (const [k, v] of Object.entries(parsed)) {
          if (k !== "id" && k !== "file") target[k] = v;
        }
        completed++;
      } catch (_e) {
        failed++;
      }
    },
    options.concurrency || 8,
  );
  return {
    completed,
    failed,
    skipped: allRows.length - matched.length,
  };
}

async function rows(tableId, options = {}) {
  let result = [...(_tables[tableId] || [])];
  if (options.filter)
    result = result.filter((r) => _evalFilter(options.filter, r));
  if (options.columns)
    result = result.map((r) => {
      const o = {};
      for (const c of options.columns) if (c in r) o[c] = r[c];
      return o;
    });
  if (options.limit != null) result = result.slice(0, options.limit);
  return result;
}

async function reduce(tableId, options) {
  const data = await rows(tableId, {
    filter: options.filter,
    columns: options.columns,
  });
  if (!data.length) return "No rows matched.";
  const raw = await tools.subagent({
    description:
      options.instruction +
      "\\n\\nBase your answer on these " +
      data.length +
      " records:\\n\\n" +
      JSON.stringify(data, null, 2),
  });
  return raw;
}
\`\`\`

### API overview

**\`create(source)\` → \`{ id, count, columns }\`**

Build an in-memory table. Supply exactly one of:
- \`{ tasks: [{ id, ...columns }] }\` — custom rows (each must have a string \`id\`)
- \`{ filePaths: ["src/a.ts", ...] }\` — becomes \`{ id, file }\` rows

Keep the returned \`id\` — pass it to every subsequent \`run\`/\`rows\`/\`reduce\`
call. Never call \`create\` again for the same table; re-declare the table id
variable when re-importing across evals.

**\`run(tableId, options)\` → \`{ completed, failed, skipped }\`**

Fan out \`tools.subagent\` calls across matched rows, merge JSON results back
as new columns. Options:
- \`instruction\` — template with \`{column}\` placeholders interpolated per-row
- \`context\` — prose prepended to every subagent prompt
- \`filter\` — only process matching rows (see Filtering below)
- \`responseSchema\` — JSON Schema (\`type: "object"\`); properties become columns
- \`concurrency\` — max concurrent calls (default 8)

Each subagent gets a full agentic loop via \`tools.subagent\`. Use bounded
concurrency and structured schemas for machine-consumed results.

**\`rows(tableId, options?)\` → \`row[]\`**

Read rows for JS-side logic. Options: \`filter\`, \`columns\`, \`limit\`.
Use for counts, branching, or building a new table — not for large result
dumps. For human-facing synthesis, use \`reduce()\` instead.

**\`reduce(tableId, options)\` → \`string\`**

Synthesize rows into a single answer via a subagent. Options:
- \`instruction\` — how to synthesize (e.g. "Summarize findings by file")
- \`filter\` — only synthesize matching rows
- \`columns\` — project to specific columns before synthesizing

### Filtering

\`\`\`javascript
{ column: "status", equals: "pending" }
{ column: "status", notEquals: "done" }
{ column: "lang", in: ["en", "fr"] }
{ column: "result", exists: true }
{ and: [{ column: "category", equals: "handler" }, { column: "severity", equals: "high" }] }
{ or: [...] }
\`\`\`

Dot-paths work for nested columns: \`{ column: "meta.score", exists: true }\`.

### Usage pattern

\`\`\`javascript
// Stage 1 — classify every row cheaply
await run(table.id, {
  instruction: "Classify the sentiment of {text} as positive/negative/neutral.",
  responseSchema: {
    type: "object",
    properties: { sentiment: { type: "string" } },
    required: ["sentiment"],
  },
});

// Stage 2 — deeper review only on uncertain rows (filter uses Stage 1 column)
await run(table.id, {
  instruction: "Provide a detailed sentiment analysis for: {text}",
  filter: { column: "sentiment", equals: "neutral" },
  responseSchema: {
    type: "object",
    properties: {
      sentiment: { type: "string" },
      confidence: { type: "number" },
      rationale: { type: "string" },
    },
    required: ["sentiment", "confidence"],
  },
});

// Synthesize — raw rows stay out of context
const report = await reduce(table.id, {
  instruction: "Summarize the sentiment distribution across all items.",
});
console.log(report);
\`\`\`

### Persistence across evals

Table *data* lives for the whole turn — an \`id\` from one eval works in
later evals. But the bootstrap variables (\`_tables\`, \`create\`, etc.) reset
between evals, so re-paste the bootstrap block at the top of each eval
that needs these functions. Keep the table \`id\` string to reconnect.

### Operating discipline

- Paste the bootstrap once before any call to \`create\`/\`run\`/\`rows\`/\`reduce\`.
- Keep concurrency ≤ 8–10 to avoid rate limits.
- Use \`responseSchema\` whenever the result will be consumed by code.
- Use \`reduce()\` for human-facing synthesis; avoid \`console.log\`-ing large
  \`rows()\` results back into context.
- Persist large structured outputs to files with \`tools.writeFile\`.
`;

export function createSwarmReplInstructionMiddleware() {
  return createMiddleware({
    name: "SwarmReplInstructionMiddleware",
    wrapModelCall(request, handler) {
      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(SWARM_REPL_INSTRUCTIONS),
      });
    },
  });
}
