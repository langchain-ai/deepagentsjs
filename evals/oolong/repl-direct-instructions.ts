import { createMiddleware } from "langchain";

/**
 * REPL-Direct strategy for Oolong benchmark tasks.
 *
 * ## Reasoning
 *
 * Oolong tasks fall into two structurally distinct categories:
 *
 * ### Category A — Structural aggregation (user / timeline tasks)
 * The answer can be derived entirely by parsing the structured fields already
 * present in each context line:
 *   "Date: Mar 05, 2023 || User: 44106 || Instance: ..."
 *
 * For "which user appears most often?" or "how many dates appear exactly 4
 * times?" — the label IS the parsed field value. No model judgment is needed.
 * A single `tools.readFile` call followed by pure JS regex/Map aggregation
 * produces the exact answer in one step, with zero subagents and zero
 * classification errors.
 *
 * ### Category B — Classification aggregation (counting tasks)
 * The context contains unlabeled instances that must be classified into one of
 * N categories (e.g. spam/ham, question-type buckets). The labels are NOT
 * embedded in the lines — they must be inferred from the instance text. These
 * tasks genuinely require LLM classification.
 *
 * However, even here the REPL-direct pattern is better than naive subagent
 * fan-out for a key reason: the agent can classify items IN BATCHES inside
 * a single subagent call rather than one subagent per item. Batching 50–200
 * items per call reduces total calls from O(N) to O(N/batchSize), keeps the
 * orchestration layer deterministic, and then aggregates results in pure JS.
 *
 * ### Why not the existing SUBAGENT_REPL pattern?
 * The existing pattern was designed for tasks where each item requires
 * independent reasoning (code review, adversarial verification). For Oolong,
 * most items are structurally identical classification calls. Spawning one
 * subagent per item is wasteful: each subagent has full agentic-loop overhead,
 * and classification errors can accumulate across hundreds of agents.
 *
 * ### Why not the SWARM pattern?
 * Swarm's table abstraction is excellent for multi-stage workflows where earlier
 * runs produce columns that filter later runs. Oolong tasks are single-stage:
 * classify every item, then count. The swarm bootstrap overhead and the
 * reduce()-via-subagent synthesis step add cost without benefit when the
 * final aggregation is pure arithmetic.
 *
 * ### The optimal algorithm per task category
 *
 * Structural tasks (user, date, inline fields):
 *   1. tools.readFile("/context.txt")  [one call]
 *   2. Parse lines in JS (regex, split)
 *   3. Build a Map/counter in JS
 *   4. Compute answer in JS
 *   5. Return the answer in the exact required format
 *
 * Classification tasks (counting tasks with unlabeled instances):
 *   1. tools.readFile("/context.txt")  [one call]
 *   2. Extract all instance texts in JS
 *   3. Batch items (50–150 per batch)
 *   4. For each batch: one tools.subagent call that classifies all items in the
 *      batch and returns a structured JSON array of {id, label} pairs
 *   5. Aggregate counts in JS from the returned arrays
 *   6. Compute and return the answer
 *
 * This hybrid keeps structural work in deterministic JS and reserves subagent
 * calls for genuine classification work — with batching to minimise call count.
 */
export const REPL_DIRECT_INSTRUCTIONS = `\
## Oolong task strategy: REPL-first, batch subagents only when needed

The context file \`/context.txt\` is already available in the filesystem.
Every line has the structure:

    Date: <date> || User: <user_id> || Instance: <text>

Followed by a header preamble and a recall footer.

### Step 1 — Always start by reading and parsing the file in the REPL

\`\`\`javascript
const raw = await tools.readFile({ file_path: "/context.txt" });
const lines = raw
  .split("\\n")
  .filter((l) => l.startsWith("Date:"));
\`\`\`

Parse structured fields for every line:

\`\`\`javascript
const records = lines.map((line) => {
  const dateMatch  = line.match(/^Date:\\s*([^|]+?)\\s*\\|\\|/);
  const userMatch  = line.match(/\\|\\|\\s*User:\\s*(\\S+?)\\s*\\|\\|/);
  const instMatch  = line.match(/\\|\\|\\s*Instance:\\s*(.+)$/);
  return {
    date:     dateMatch?.[1]?.trim()  ?? "",
    user:     userMatch?.[1]?.trim()  ?? "",
    instance: instMatch?.[1]?.trim()  ?? "",
  };
});
\`\`\`

### Step 2 — Decide: structural or classification?

**Structural tasks** — the answer is derivable from \`date\` or \`user\` fields
already in the parsed records. Solve entirely in JS:

\`\`\`javascript
// Most frequent user
const freq = new Map();
for (const r of records) freq.set(r.user, (freq.get(r.user) ?? 0) + 1);
const mostFreqUser = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
console.log("User: " + mostFreqUser);
\`\`\`

\`\`\`javascript
// How many dates appear exactly N times
const dateFreq = new Map();
for (const r of records) dateFreq.set(r.date, (dateFreq.get(r.date) ?? 0) + 1);
const count = [...dateFreq.values()].filter((v) => v === 4).length;
console.log("Answer: " + count);
\`\`\`

Do NOT call subagents for structural tasks. Every date and user ID is already
in the parsed record — counting them is pure arithmetic.

**Classification tasks** — the labels are NOT embedded in the lines. These
tasks ask about aggregate statistics over inferred labels (e.g. spam/ham,
question-type categories). You must classify each instance. Use batched
subagents as described below.

Signs you are on a classification task:
- The question refers to labels that are NOT date or user-ID values
- The context header describes a dataset with a fixed set of named categories
- Example: "how many items should be classified as label 'spam'?"
- Example: "which label is least common: description, entity, location, ...?"

### Step 3 (classification tasks only) — Batch-classify with subagents

Read the label options from the context header or question. Then classify all
instances in batches of 100 items per subagent call. Each subagent receives a
compact JSON batch and returns a structured array.

\`\`\`javascript
const LABELS = ["spam", "ham"];          // replace with actual labels from header
const BATCH_SIZE = 100;

async function classifyBatch(batch, labels) {
  const raw = await tools.subagent({
    description: [
      "Classify each instance into one of these labels: " + labels.join(", ") + ".",
      "Return ONLY a JSON array with one object per item: [{id, label}, ...].",
      "Use the exact label strings. Do not add explanation.",
      "",
      "Items to classify (JSON array of {id, text}):",
      JSON.stringify(batch),
    ].join("\\n"),
    response_schema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id:    { type: "number" },
              label: { type: "string" },
            },
            required: ["id", "label"],
          },
        },
      },
      required: ["results"],
    },
  });
  return JSON.parse(raw).results;
}

// Build batches
const batches = [];
for (let i = 0; i < records.length; i += BATCH_SIZE) {
  batches.push(
    records.slice(i, i + BATCH_SIZE).map((r, j) => ({
      id:   i + j,
      text: r.instance,
    })),
  );
}

// Run batches with bounded concurrency (max 8 at once)
async function runBatched(batches, fn, concurrency = 8) {
  const results = [];
  for (let i = 0; i < batches.length; i += concurrency) {
    const slice = batches.slice(i, i + concurrency);
    const settled = await Promise.allSettled(slice.map((b) => fn(b)));
    for (const s of settled) {
      if (s.status === "fulfilled") results.push(...s.value);
    }
  }
  return results;
}

const classified = await runBatched(batches, (b) => classifyBatch(b, LABELS));
\`\`\`

### Step 4 (classification tasks only) — Aggregate in JS

\`\`\`javascript
const counts = new Map();
for (const { label } of classified) {
  counts.set(label, (counts.get(label) ?? 0) + 1);
}

// Most frequent label
const mostFreq = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

// Count for a specific label
const spamCount = counts.get("spam") ?? 0;

// Comparison between two labels
const aCount = counts.get("description and abstract concept") ?? 0;
const bCount = counts.get("entity") ?? 0;
const relation = aCount > bCount ? "more common than"
                : aCount < bCount ? "less common than"
                : "same frequency as";
\`\`\`

### Step 5 — Return the answer in the EXACT format requested

Read the question carefully. It always specifies the answer format, e.g.:
- "Give your final answer in the form 'Label: answer'"
- "Give your final answer in the form 'Answer: [X]'"
- "Give your final answer in the form 'User: [X]'"

Return ONLY the answer in that exact format — no explanation, no preamble.

### Operating rules

1. Always read \`/context.txt\` first — it is already seeded, do not skip this step.
2. Parse the file in the REPL using \`split("\\n")\` and string operations — do NOT
   ask a subagent to read or summarize the file. The file can be very long
   (65k+ tokens) and must be processed in full.
3. For structural tasks (date/user aggregation), solve in pure JS. Zero subagents.
4. For classification tasks, use batched subagents (100 items per batch, 8
   concurrent). Never spawn one subagent per item.
5. Aggregate counts in JS — never ask a subagent to count or sum for you.
6. Output only the answer in the exact format specified by the question.
7. If the REPL splits a long \`tools.readFile\` result across eval calls due to
   output truncation, read the raw variable length instead of relying on console
   output — the string is in memory even if not printed in full.
`;

export function createReplDirectMiddleware() {
  return createMiddleware({
    name: "ReplDirectMiddleware",
    wrapModelCall(request, handler) {
      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(REPL_DIRECT_INSTRUCTIONS),
      });
    },
  });
}
