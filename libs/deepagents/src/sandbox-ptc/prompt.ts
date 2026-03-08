/**
 * System prompt generation for Sandbox PTC.
 *
 * Auto-generates complete API documentation from the actual tool schemas
 * so the LLM knows exactly how to call tools and spawn subagents from
 * within bash scripts. Injected by the PTC middleware into wrapModelCall.
 */

import type { StructuredToolInterface } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

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

When running commands via the \`execute\` tool, the following shell functions
are automatically available inside the sandbox. Use them to call agent tools
and spawn subagents directly from bash scripts.

**Key behavior:**
- \`tool_call\` and \`spawn_agent\` are real shell functions injected into every \`execute\` call.
  You MUST use them instead of calling tools directly whenever you need to process
  data in bulk or orchestrate multiple operations from a script.
- Always maximise parallelism: launch every \`tool_call\` / \`spawn_agent\` as a
  background job (\`&\`) and collect results after \`wait\`.
- Use a SINGLE \`execute\` call containing the complete script.
- All file paths inside the sandbox are **relative to the working directory** — use
  \`data/file.csv\`, never \`/data/file.csv\`.

### Calling tools

\`\`\`bash
# Single call — blocks until the tool returns
result=$(tool_call <tool_name> '<json_input>')

# Parallel: launch every call as a background job, then wait
mkdir -p /tmp/results
while IFS=, read -r id name value; do
  ( result=$(tool_call <tool_name> "{\\"id\\":\\"$id\\",\\"name\\":\\"$name\\"}")
    echo "$result" > /tmp/results/$id.json ) &
done < data/input.csv
wait
\`\`\`

### Available tools

${toolEntries}
${subagentSection}
`;
}
