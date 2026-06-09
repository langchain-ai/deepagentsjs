import { createMiddleware } from "langchain";

export const SUBAGENT_REPL_INSTRUCTIONS = `\
## Programmatic subagents with \`tools.subagent\`

\`tools.subagent\` is the REPL primitive for delegating work to a separate
general-purpose deepagent. Use JavaScript in the REPL as the orchestrator: hold
arrays, filter rows, batch calls, merge structured results, and synthesize from
the returned data. The subagent itself gets a full agentic loop and tool access;
your REPL code decides what to ask, how many agents to launch, and how to combine
their answers.

### The primitive

\`\`\`javascript
const raw = await tools.subagent({
  description,      // full task prompt for the delegated agent
  response_schema,  // optional JSON Schema with type: "object"
}); // -> Promise<string>
\`\`\`

There is no mode switch and no subagent type selector. Every call delegates to
the same general-purpose deepagent with an agentic loop. The return value is
always a string. If you pass \`response_schema\`, parse the returned string with
\`JSON.parse(raw)\`.

### When to call a subagent

Use a subagent when the work benefits from an isolated context or independent
agentic pass:

- Inspecting one file, record, document, question, or candidate answer.
- Running the same analysis over many independent items.
- Getting independent judgments before a synthesis step.
- Letting another agent read files, search locally, iterate, and return a
  bounded result.
- Checking the main agent's hypothesis with a focused adversarial or verifying
  pass.

Do not call a subagent just to compute simple JS transformations. Sort, group,
deduplicate, filter, parse JSON, and aggregate directly in the REPL.

### Mental model

Keep the control plane in JavaScript. Treat \`tools.subagent\` like an async map
operation over items:

1. Build a compact item array in the REPL.
2. Fan out bounded subagent calls over those items.
3. Parse each structured response.
4. Merge the response back onto its source item.
5. Filter or rank the array.
6. Run another pass only over the survivors if needed.
7. Synthesize the final answer from the structured data.

The best workflows are deterministic at the orchestration layer and agentic only
inside each delegated unit of work.

### Response schemas

Prefer \`response_schema\` whenever the result will be consumed by code. The
schema must be a JSON Schema object with \`type: "object"\`. Keep schemas small
and explicit: use primitive fields, arrays of small objects, and required keys.

\`\`\`javascript
const raw = await tools.subagent({
  description: [
    "Judge whether this metaphor question was answered correctly.",
    "Return calibrated evidence, not prose.",
    JSON.stringify(item),
  ].join("\\n\\n"),
  response_schema: {
    type: "object",
    properties: {
      correct: { type: "boolean" },
      confidence: { type: "number" },
      rationale: { type: "string" },
      evidence_quotes: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["correct", "confidence", "rationale"],
  },
});

const judgment = JSON.parse(raw);
\`\`\`

Without a schema, the subagent returns the final message text. Use that for
one-off exploratory analysis, but prefer schemas for fanout and multi-stage
workflows.

### Fan out with bounded concurrency

Use \`Promise.all\` in batches. Do not launch hundreds of agents at once. A batch
size around 5-10 is usually enough to get parallelism without creating noisy,
expensive, or rate-limited runs.

\`\`\`javascript
async function mapConcurrent(items, fn, batch = 8) {
  const out = [];
  for (let i = 0; i < items.length; i += batch) {
    const slice = items.slice(i, i + batch);
    out.push(...(await Promise.all(slice.map(fn))));
  }
  return out;
}

const judged = await mapConcurrent(rows, async (row) => {
  const raw = await tools.subagent({
    description: "Analyze this row and return JSON only:\\n" + JSON.stringify(row),
    response_schema: {
      type: "object",
      properties: {
        label: { type: "string" },
        confidence: { type: "number" },
        notes: { type: "string" },
      },
      required: ["label", "confidence"],
    },
  });
  return { ...row, ...JSON.parse(raw) };
});
\`\`\`

### Compose stages

Use multiple passes when it reduces cost or improves quality. First run a cheap,
focused classification or extraction. Then filter in JS. Then run deeper
subagents only on ambiguous or high-value items.

\`\`\`javascript
const firstPass = await mapConcurrent(items, async (item) => {
  const raw = await tools.subagent({
    description: "Classify this item as keep/reject/uncertain:\\n" + JSON.stringify(item),
    response_schema: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["keep", "reject", "uncertain"] },
        reason: { type: "string" },
      },
      required: ["decision", "reason"],
    },
  });
  return { ...item, ...JSON.parse(raw) };
});

const uncertain = firstPass.filter((item) => item.decision === "uncertain");
const reviewed = await mapConcurrent(uncertain, async (item) => {
  const raw = await tools.subagent({
    description: "Do a deeper review. Cite concrete evidence.\\n" + JSON.stringify(item),
    response_schema: {
      type: "object",
      properties: {
        final_decision: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        rationale: { type: "string" },
      },
      required: ["final_decision", "rationale"],
    },
  });
  return { ...item, review: JSON.parse(raw) };
});
\`\`\`

### Prompt each subagent like a standalone worker

Each subagent only sees the task description you pass plus the shared agent
state made available by the runner. Include all task-specific data it needs:
file paths, row IDs, question text, candidate answers, evaluation criteria, and
the exact shape of the expected response. If the subagent should inspect files,
give it concrete paths and tell it what evidence to return.

Bad delegation: "Check this."

Good delegation: "Review \`src/foo.ts\` for SQL injection risk. Read the file,
cite line numbers, return JSON with \`has_issue\`, \`severity\`, \`lines\`, and
\`rationale\`."

### Use files deliberately

The REPL can call file tools directly for orchestration, and subagents can use
their own tools inside the delegated loop. Prefer this split:

- Use REPL tools such as \`tools.glob\` and \`tools.readFile\` to build the item
  list, sample data, or pre-load small snippets.
- Use \`tools.subagent\` when each item needs an independent read, search, or
  reasoning pass.
- Do not paste huge file contents into every subagent prompt if a file path is
  enough. Pass paths and instructions instead.

### Keep outputs bounded

Subagents are useful because they compress work into structured outputs. Ask for
short rationales, evidence snippets, IDs, booleans, labels, scores, and arrays of
specific findings. Avoid asking each subagent for long essays unless the final
task needs prose from every item.

### Persist results without flooding context

Keep intermediate arrays in JS variables. Do not \`console.log\` a full result set
unless it is tiny. For larger experiments, write JSON to a file:

\`\`\`javascript
await tools.writeFile({
  file_path: "/results/subagent-results.json",
  content: JSON.stringify(judged, null, 2),
});
\`\`\`

Log compact summaries instead:

\`\`\`javascript
console.log({
  total: judged.length,
  positive: judged.filter((row) => row.label === "positive").length,
});
\`\`\`

### Failure handling

Wrap individual calls when you need partial progress. Return an error object
merged onto the item instead of failing the whole batch.

\`\`\`javascript
const results = await mapConcurrent(items, async (item) => {
  try {
    const raw = await tools.subagent({
      description: "Analyze:\\n" + JSON.stringify(item),
      response_schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    });
    return { ...item, result: JSON.parse(raw) };
  } catch (error) {
    return { ...item, error: String(error) };
  }
});
\`\`\`

### Operating discipline

- Use bounded concurrency.
- Use schemas for machine-consumed outputs.
- Keep subagent prompts complete and item-specific.
- Use JS for deterministic orchestration and aggregation.
- Stage broad workflows instead of doing everything in one giant prompt.
- Persist large outputs to files and print only summaries.
- Stop spawning subagents once the remaining work is simple synthesis.
`;

export function createSubagentReplInstructionMiddleware() {
  return createMiddleware({
    name: "SubagentReplInstructionMiddleware",
    wrapModelCall(request, handler) {
      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(SUBAGENT_REPL_INSTRUCTIONS),
      });
    },
  });
}
