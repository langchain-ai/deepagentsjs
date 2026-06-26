# Connectors

## Motivation

Managed Deep Agents need a simple way to attach external tool surfaces without making every developer manually create MCP clients, load tools, wire them into the agent, and manage connection lifecycle.

For the first iteration, connectors should mean exactly one thing: **MCP servers**. MDA should load tools from declared MCP servers and add them to the agent automatically.

Typed vendor clients such as:

```ts
const linear = await runtime.connections.get("linear", { scope: "tenant" });
await linear.issues.create({ title, body });
```

are a separate, later concept: **managed connections**. They require credential ownership, OAuth or setup flows, typed SDK wrapping, authorization, and audit. That is out of scope for the MCP connector POC.

## Product Boundary

For v0, a connector is an MCP server declaration.

MDA is responsible for:

- discovering `connectors/mcp.{ts,py}`
- validating the MCP server config
- creating the MCP client using `@langchain/mcp-adapters`
- loading MCP tools
- adding those tools to the Deep Agent
- closing clients and surfacing connection errors

MDA is not responsible for v0:

- stdio-only MCP servers
- typed SaaS clients like Linear, GitHub, Salesforce, or Slack
- per-user or per-tenant OAuth consent flows
- a connector marketplace
- vendor-specific SDK abstractions
- replacing normal authored tools

If a developer needs vendor-specific code in v0, they should either expose that vendor through an MCP server or write a normal authored tool.

## Workspace Shape

```text
my-agent/
  agent.ts
  AGENTS.md
  tools/
  connectors/
    mcp.ts
```

Python should use the same convention:

```text
my-agent/
  agent.py
  AGENTS.md
  tools/
  connectors/
    mcp.py
```

## TypeScript API

`connectors/mcp.ts` should intentionally stay close to the current `@langchain/mcp-adapters` `MultiServerMCPClient` config:

```ts
// connectors/mcp.ts
import { defineMcpServers } from "managed-deepagents/connectors";

export const mcp = defineMcpServers({
  useStandardContentBlocks: true,
  prefixToolNameWithServerName: true,
  throwOnLoadError: true,

  mcpServers: {
    docs: {
      transport: "http",
      url: "https://docs.example.com/mcp",
    },
  },
});
```

## Python API

The Python API should mirror the same shape as closely as possible:

```python
# connectors/mcp.py
from managed_deepagents.connectors import define_mcp_servers

mcp = define_mcp_servers(
    use_standard_content_blocks=True,
    prefix_tool_name_with_server_name=True,
    throw_on_load_error=True,
    mcp_servers={
        "docs": {
            "transport": "http",
            "url": "https://docs.example.com/mcp",
        },
    },
)
```

For now, MDA should support remote MCP servers over HTTP/SSE only. Stdio MCP servers introduce process management, packaging, sandboxing, and deployment concerns that are outside the first POC.

## Runtime Behavior

The agent author does not manually import the MCP client or call `getTools()`.

Authored tools stay in the agent file:

```ts
// agent.ts
import { createDeepAgent } from "deepagents";
import instructions from "./AGENTS.md";
import { queryDB } from "./tools/query-db";

export const agent = createDeepAgent({
  model: "openai:gpt-5.5",
  systemPrompt: instructions,
  tools: [queryDB],
});
```

MDA compiles this into a runtime that includes:

- authored tools from `agent.ts` / `agent.py`
- MCP tools loaded from `connectors/mcp.{ts,py}`

Conceptually:

```ts
const mcpTools = await managedMcpClient.getTools();

createDeepAgent({
  ...agentConfig,
  tools: [...authoredTools, ...mcpTools],
});
```

## Naming

MDA should default `prefixToolNameWithServerName` to `true`.

Example:

```text
docs__search
github__create_issue
linear__list_issues
```

This avoids collisions between authored tools and common MCP tool names like `search`, `read`, `write`, or `create`.

Developers can opt out only if MDA validates that no tool names collide.

## Error Handling

If an MCP server cannot connect or its tools cannot load, deployment should fail. There is no optional connector mode in the POC.

```ts
export const mcp = defineMcpServers({
  onConnectionError: "throw",
  throwOnLoadError: true,
  mcpServers: {
    docs: {
      transport: "http",
      url: "https://docs.example.com/mcp",
    },
  },
});
```

Recommended defaults:

- `throwOnLoadError: true`
- `onConnectionError: "throw"`
- `useStandardContentBlocks: true`
- `prefixToolNameWithServerName: true`

## Future: Managed Connections

After MCP connectors, MDA can introduce managed connections:

```ts
const linear = await runtime.connections.get("linear", {
  scope: "tenant",
});

await linear.issues.create({ title, body });
```

This should be treated as a different layer with different responsibilities:

- connection declarations
- credential storage
- tenant/user ownership
- OAuth or setup flows
- typed vendor clients
- authorization and approval policies
- audit records for external side effects

This is valuable, but it should not complicate the MCP connector POC.
