# Connectors

## Motivation

Managed Deep Agents need a way to use external tools without forcing developers to manually create MCP clients, load tools, wire them into the agent, manage connection lifecycle, or duplicate deployment configuration. For the POC, connectors should be narrowly scoped to **MCP servers** and should map closely to the existing `@langchain/mcp-adapters` configuration surface.

The goal is not to introduce a new third-party vendor SDK layer yet. APIs like `runtime.connections.get("linear")` may become useful later for typed vendor clients, OAuth ownership, and tenant-scoped credentials, but they are out of scope for the first version.

## Product Boundary

For v0, a connector is:

- a declared MCP server
- loaded by MDA at dev/deploy time
- converted into LangChain tools using `@langchain/mcp-adapters`
- automatically added to the Deep Agent's tool list
- managed by the runtime for startup, teardown, errors, and tracing

A connector is not yet:

- a typed Linear/GitHub/Salesforce client
- a general OAuth connection system
- a custom tool runtime
- an arbitrary integration marketplace
- a replacement for normal user-authored tools

Developers can still write ordinary tools in code. Connectors are for importing tool surfaces exposed by MCP servers.

## Workspace Shape

```text
my-agent/
  agent.ts
  AGENTS.md
  tools/
  connectors/
    mcp.ts
```

`connectors/mcp.ts` is the source of truth for MCP servers used by the agent.

## API

The POC should expose a small helper that intentionally resembles `MultiServerMCPClient`:

```ts
// connectors/mcp.ts
import { defineMcpConnectors } from "managed-deepagents/connectors";

export const connectors = defineMcpConnectors({
  useStandardContentBlocks: true,
  throwOnLoadError: true,
  prefixToolNameWithServerName: true,

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
        Authorization: secret("DOCS_MCP_TOKEN"),
      },
    },
  },
});
```

The shape should stay close enough to `MultiServerMCPClient` that developers can move between raw LangChain MCP usage and MDA with minimal translation.

## Runtime Behavior

On `deepagents dev` and `deepagents deploy`, MDA should:

1. discover `connectors/mcp.{ts,py}`
2. validate the MCP server configuration
3. resolve referenced secrets
4. create a managed `MultiServerMCPClient`
5. call `client.getTools()`
6. add the resulting tools to the Deep Agent
7. close the client when the runtime shuts down

Agent code should not need to import the MCP client:

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

At runtime, the agent receives both its authored tools and the MCP tools loaded from connectors.

## Naming

MDA should default `prefixToolNameWithServerName` to `true` for managed connectors.

This avoids collisions between:

- authored tools
- tools from multiple MCP servers
- common MCP tool names like `search`, `read`, `write`, or `create`

Example:

```text
docs__search
github__create_issue
linear__list_issues
```

Developers can opt out only if validation confirms there are no collisions.

## Secrets

Connector credentials should use MDA secrets, not raw hard-coded tokens:

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

For the POC, static deployment or tenant-scoped secrets are enough. Full OAuth-backed MCP auth can come later.

## Identity

Connectors should receive runtime identity only through explicit, managed mechanisms.

For HTTP MCP servers that need request identity, MDA can support per-call header injection:

```ts
docs: {
  transport: "http",
  url: "https://docs.example.com/mcp",
  headers: {
    Authorization: secret("DOCS_MCP_TOKEN"),
  },
  runtimeHeaders: {
    "X-Actor-Id": identity("actor.id"),
    "X-Tenant-Id": identity("tenant.id"),
  },
}
```

MDA resolves `runtimeHeaders` on each tool call from the trusted `runtime.identity`. Agent code should not manually construct identity headers for connector tools.

For the POC, this can be limited to HTTP/SSE transports. Stdio MCP servers do not support per-call headers.

## Error Handling

MDA should expose the same basic failure modes as `@langchain/mcp-adapters`:

```ts
export const connectors = defineMcpConnectors({
  onConnectionError: "throw",
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

If a connector is optional, the developer can mark it explicitly:

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

## Out of Scope for POC

- `runtime.connections.get("linear")` typed vendor clients
- managed OAuth consent flows for third-party SaaS vendors
- connector marketplace
- UI-based connector installation
- per-user OAuth token brokering
- automatic MCP server hosting
- non-MCP connector protocols
- custom connector code beyond normal MCP configuration

## Open Questions

- Should Python use the same `connectors/mcp.py` convention in v0 or follow after TypeScript?
- Should stdio MCP servers be allowed in managed deployments, or only local dev and trusted build/runtime environments?
- Should connector tools be added to every run by default, or should agents be able to lazy-load connector tool groups?
- How should connector tool calls appear in LangSmith traces: as ordinary tools, MCP tools with server metadata, or both?

## Takeaway

For v0, connectors should be a managed MCP tool-loading convention, not a broad integration platform. Developers declare MCP servers using a config shape close to `@langchain/mcp-adapters`; MDA validates them, resolves secrets, loads tools, injects them into the Deep Agent, and owns lifecycle and observability.
