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
- resolving connector secrets
- creating the MCP client using `@langchain/mcp-adapters`
- loading MCP tools
- adding those tools to the Deep Agent
- closing clients and surfacing connection errors

MDA is not responsible for v0:

- typed SaaS clients like Linear, GitHub, Salesforce, or Slack
- per-user or per-tenant OAuth consent flows
- a connector marketplace
- vendor-specific SDK abstractions
- replacing normal authored tools

If a developer needs vendor-specific code in v0, they should either expose that vendor through an MCP server or write a normal tool that uses managed secrets.

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
import { defineMcpServers, secret } from "managed-deepagents/connectors";

export const mcp = defineMcpServers({
  useStandardContentBlocks: true,
  prefixToolNameWithServerName: true,
  throwOnLoadError: true,

  mcpServers: {
    math: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-math"],
      restart: {
        enabled: true,
        maxAttempts: 3,
        delayMs: 1000,
      },
    },

    docs: {
      transport: "http",
      url: "https://docs.example.com/mcp",
      headers: {
        Authorization: `Bearer ${secret("DOCS_MCP_TOKEN")}`,
      },
    },
  },
});
```

## Python API

The Python API should mirror the same shape as closely as possible:

```python
# connectors/mcp.py
from managed_deepagents.connectors import define_mcp_servers, secret

mcp = define_mcp_servers(
    use_standard_content_blocks=True,
    prefix_tool_name_with_server_name=True,
    throw_on_load_error=True,
    mcp_servers={
        "math": {
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-math"],
        },
        "docs": {
            "transport": "http",
            "url": "https://docs.example.com/mcp",
            "headers": {
                "Authorization": f"Bearer {secret('DOCS_MCP_TOKEN')}",
            },
        },
    },
)
```

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

## Secrets

Connector credentials should use MDA secrets:

```ts
headers: {
  Authorization: `Bearer ${secret("GITHUB_MCP_TOKEN")}`,
}
```

MDA should validate required connector secrets at deploy time:

```bash
deepagents secrets check
```

Secrets used by connectors must be:

- redacted from traces and logs
- unavailable to the model prompt
- scoped to the connector that requested them
- auditable when resolved

For the POC, static deployment-scoped secrets are sufficient. Tenant-scoped secrets can follow if needed, but per-user OAuth should wait for managed connections.

## Error Handling

MDA should keep the MCP adapter's failure semantics visible:

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

Optional connectors can be marked explicitly:

```ts
analytics: {
  transport: "http",
  url: "https://analytics.example.com/mcp",
  optional: true,
}
```

Optional connectors may fail without blocking agent startup, but MDA should surface a warning in dev, deploy output, and LangSmith runtime metadata.

## Local Development

`deepagents dev` should show loaded connector tools:

```text
Connectors:
  docs: connected
    docs__search
    docs__read_page
  math: connected
    math__add
    math__multiply
```

It should fail fast when:

- required secrets are missing
- a server cannot connect
- tool names collide
- a transport config is invalid

This keeps connector issues visible before deployment.

## Deployment

`deepagents deploy --dry-run` should include connector changes:

```text
Connectors:
  + docs        http   https://docs.example.com/mcp
  + math        stdio  npx -y @modelcontextprotocol/server-math

Required secrets:
  DOCS_MCP_TOKEN: set
```

Removing a connector from `connectors/mcp.ts` removes it from the deployed agent on the next deploy.

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

## Open Questions

- Should stdio MCP servers be allowed in managed deployments, or only local dev and trusted build/runtime environments?
- How should connector tool calls appear in LangSmith traces: as ordinary tools, MCP tools with server metadata, or both?
- Should tenant-scoped static secrets be included in v0, or should v0 only support deployment-scoped secrets?

## Takeaway

For v0, connectors should be a managed MCP tool-loading convention, not a broad integration platform. Developers define MCP servers in `connectors/mcp.{ts,py}` using a config shape close to `@langchain/mcp-adapters`; MDA validates the config, resolves secrets, loads tools, injects them into the Deep Agent, and owns lifecycle and observability.
