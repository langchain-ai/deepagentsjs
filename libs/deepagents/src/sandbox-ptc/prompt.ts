/**
 * System prompt generation for Sandbox PTC.
 *
 * Injects API documentation into the agent's system prompt so the LLM
 * knows that `tool_call` and `spawn_agent` shell functions are available
 * inside the sandbox.
 */

import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * Build the PTC system prompt section listing available shell functions.
 */
export function generateSandboxPtcPrompt(
  tools: StructuredToolInterface[],
): string {
  if (tools.length === 0) return "";

  const toolDocs = tools
    .map((t) => {
      return `- \`${t.name}\` (bash: \`tool_call ${t.name} '<json>'\`, python: \`tool_call("${t.name}", {...})\`, node: \`toolCall("${t.name}", {...})\`) — ${t.description}`;
    })
    .join("\n");

  return `
## Sandbox Programmatic Tool Calling (PTC)

When running commands via the \`execute\` tool, the following functions are
automatically available for calling agent tools from within the sandbox.

### Bash

\`\`\`bash
# Call a tool — blocks until result is returned
result=$(tool_call <tool_name> '<json_input>')
echo "$result"

# Spawn a subagent
result=$(spawn_agent "Research quantum computing" "general-purpose")

# Parallel tool calls using background jobs
tool_call web_search '{"query":"topic A"}' > /tmp/a.txt &
tool_call web_search '{"query":"topic B"}' > /tmp/b.txt &
wait
cat /tmp/a.txt /tmp/b.txt
\`\`\`

### Python

\`\`\`python
# Import is auto-injected — just call directly
# If writing a .py file, add: from da_runtime import *
# Or: import sys; sys.path.insert(0, '/tmp'); from da_runtime import *

result = tool_call("web_search", {"query": "hello"})
print(result)

agent_result = spawn_agent("Research topic", "general-purpose")
\`\`\`

### Node.js

\`\`\`javascript
const { toolCall, spawnAgent } = require('/tmp/.da_runtime.js');

const result = toolCall("web_search", { query: "hello" });
console.log(result);

const agentResult = spawnAgent("Research topic", "general-purpose");
\`\`\`

### Available tools
${toolDocs}
`;
}
