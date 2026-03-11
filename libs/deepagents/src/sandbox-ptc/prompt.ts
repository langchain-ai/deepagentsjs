/**
 * System prompt generation for PTC.
 *
 * Two prompt generators:
 * - `generateSandboxPtcPrompt` — for sandbox mode (bash/python/node scripts via execute)
 * - `generateWorkerReplPrompt` — for Worker REPL mode (JS code via js_eval)
 *
 * Both auto-generate API documentation from actual tool schemas.
 */

import type { StructuredToolInterface } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { NetworkPolicy } from "./types.js";
import { summarizePolicy } from "./network-policy.js";

function safeToJsonSchema(
  schema: unknown,
): Record<string, unknown> | undefined {
  try {
    return toJsonSchema(schema as Parameters<typeof toJsonSchema>[0]) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

/**
 * Generate a compact JSON schema description for a tool's input.
 * Produces something like: `{"query": "<string>", "limit": "<number>"}`
 */
function schemaToExample(
  jsonSchema: Record<string, unknown> | undefined,
): string {
  if (!jsonSchema) return "{}";
  const props = jsonSchema.properties as
    | Record<string, { type?: string; description?: string }>
    | undefined;
  if (!props) return "{}";

  const fields = Object.entries(props).map(([key, val]) => {
    const t = val.type ?? "string";
    if (t === "number" || t === "integer") return `"${key}": <${t}>`;
    if (t === "boolean") return `"${key}": <boolean>`;
    return `"${key}": "<${t}>"`;
  });
  return `{${fields.join(", ")}}`;
}

/**
 * Build the PTC system prompt section from actual tool definitions.
 */
export function generateSandboxPtcPrompt(
  tools: StructuredToolInterface[],
  network?: NetworkPolicy,
): string {
  if (tools.length === 0) return "";

  const isTaskTool = (t: StructuredToolInterface) => t.name === "task";
  const regularTools = tools.filter((t) => !isTaskTool(t));
  const taskTool = tools.find(isTaskTool);

  const toolEntries = regularTools
    .map((t) => {
      const schema = t.schema ? safeToJsonSchema(t.schema) : undefined;
      const example = schemaToExample(schema);
      return `#### \`${t.name}\`
${t.description}
\`\`\`bash
result=$(tool_call ${t.name} '${example}')
\`\`\``;
    })
    .join("\n\n");

  let subagentSection = "";
  if (taskTool) {
    const agentTypesMatch = taskTool.description.match(
      /Available(?:\s+agent\s+types)?:?\s*((?:- .+\n?)+)/i,
    );
    const agentTypes = agentTypesMatch
      ? agentTypesMatch[1].trim()
      : "- general-purpose: General-purpose agent";

    subagentSection = `
### Spawning subagents

The \`spawn_agent\` function launches a subagent to handle a subtask.
It blocks until the subagent completes and returns its text response.

\`\`\`bash
result=$(spawn_agent "<task description>" "<agent_type>")
echo "$result"
\`\`\`

Available agent types:
${agentTypes}

#### Parallel subagent spawning
\`\`\`bash
for i in $(seq 1 10); do
  ( result=$(spawn_agent "Analyse record $i" "general-purpose")
    echo "$result" > /tmp/analysis_$i.txt ) &
done
wait
\`\`\`
`;
  }

  return `
## Sandbox Programmatic Tool Calling (PTC)

When running commands via the \`execute\` tool, PTC functions are automatically
available for calling agent tools and spawning subagents from scripts.
PTC is auto-injected for **bash**, **Python**, and **Node.js** — use whichever
language fits the task best.

**Key behavior:**
- Use PTC functions instead of calling tools directly whenever you need to process
  data in bulk or orchestrate multiple operations from a script.
- Always maximise parallelism where possible.
- Use a SINGLE \`execute\` call containing the complete script.
- All file paths inside the sandbox are **relative to the working directory** — use
  \`data/file.csv\`, never \`/data/file.csv\`.

### Bash

\`tool_call\` and \`spawn_agent\` are shell functions. Use background jobs for parallelism.

\`\`\`bash
result=$(tool_call <tool_name> '<json_input>')

# Parallel execution
for i in $(seq 1 N); do
  ( result=$(tool_call <tool_name> '{"id":'$i'}')
    echo "$result" > /tmp/results/$i.json ) &
done
wait
\`\`\`

### Python

\`tool_call()\` and \`spawn_agent()\` are auto-imported when running \`python3\`.
Use \`concurrent.futures\` for parallelism.

\`\`\`python
# Functions are pre-loaded — just call them
result = tool_call("tool_name", {"key": "value"})

# Parallel execution
from concurrent.futures import ThreadPoolExecutor, as_completed
with ThreadPoolExecutor(max_workers=100) as pool:
    futures = {pool.submit(tool_call, "tool_name", {"id": i}): i for i in range(100)}
    for future in as_completed(futures):
        result = future.result()

# Spawn subagent
analysis = spawn_agent("Analyse this data", "general-purpose")
\`\`\`

### Node.js

\`toolCall()\` and \`spawnAgent()\` are auto-injected as globals when running \`node\`.
Both are **async** (return Promises). Use \`Promise.all()\` for parallelism.

\`\`\`javascript
// Single call
const result = await toolCall("tool_name", { key: "value" });

// Parallel execution with Promise.all
const results = await Promise.all(
  items.map(item => toolCall("tool_name", { id: item.id }))
);

// Parallel subagent spawning
const analyses = await Promise.all(
  records.map(r => spawnAgent(\`Analyse: \${JSON.stringify(r)}\`, "general-purpose"))
);

// toolCallSync() is also available for synchronous (blocking) calls
const syncResult = toolCallSync("tool_name", { key: "value" });
\`\`\`

**Important:** Write the script as an async IIFE or use top-level await:
\`\`\`javascript
(async () => {
  const results = await Promise.all([...]);
  console.log(results);
})();
\`\`\`

### Available tools

${toolEntries}
${subagentSection}
${network ? `### Network access (fetch)\n\n${summarizePolicy(network)}\n` : ""}
`;
}

/**
 * Build the Worker REPL system prompt section from actual tool definitions.
 * Used when no sandbox backend is provided (Worker REPL mode).
 */
export function generateWorkerReplPrompt(
  tools: StructuredToolInterface[],
  network?: NetworkPolicy,
): string {
  if (tools.length === 0) return "";

  const isTaskTool = (t: StructuredToolInterface) => t.name === "task";
  const regularTools = tools.filter((t) => !isTaskTool(t));
  const taskTool = tools.find(isTaskTool);

  const toolEntries = regularTools
    .map((t) => {
      const schema = t.schema ? safeToJsonSchema(t.schema) : undefined;
      const example = schemaToExample(schema);
      return `- **\`${t.name}\`** — ${t.description}
  \`\`\`javascript
  const result = await toolCall("${t.name}", ${example});
  \`\`\``;
    })
    .join("\n\n");

  let subagentSection = "";
  if (taskTool) {
    const agentTypesMatch = taskTool.description.match(
      /Available(?:\\s+agent\\s+types)?:?\\s*((?:- .+\\n?)+)/i,
    );
    const agentTypes = agentTypesMatch
      ? agentTypesMatch[1].trim()
      : "- general-purpose: General-purpose agent";

    subagentSection = `
### Spawning subagents

\`spawnAgent()\` launches a subagent. Returns a Promise with the agent's response.

\`\`\`javascript
const analysis = await spawnAgent("Analyse this data and provide recommendations", "general-purpose");
console.log(analysis);

// Parallel subagent spawning
const results = await Promise.all(
  items.map(item => spawnAgent(\`Analyse: \${JSON.stringify(item)}\`, "general-purpose"))
);
\`\`\`

Available agent types:
${agentTypes}
`;
  }

  return `
## JavaScript REPL (\`js_eval\`)

You have access to a sandboxed JavaScript REPL running in an isolated Worker.
Variables and closures do NOT persist across calls.
Use \`console.log()\` for output — it is captured and returned.

### Key behavior

- \`toolCall(name, input)\` and \`spawnAgent(description, type)\` are async globals.
  Always use \`await\` when calling them.
- Maximise parallelism with \`Promise.all()\` whenever possible.
- Top-level \`await\` is supported — no need for async IIFE wrappers.
- No \`require\`, \`import\`, \`fetch\`, or filesystem access.

### Calling tools

\`\`\`javascript
// Single tool call
const result = await toolCall("tool_name", { key: "value" });
console.log(result);

// Parallel tool calls
const results = await Promise.all(
  items.map(item => toolCall("tool_name", { id: item.id }))
);
console.log(results);
\`\`\`

### Available tools

${toolEntries}
${subagentSection}
${network ? `### Network access (fetch)\n\n${summarizePolicy(network)}\n` : ""}
`;
}
