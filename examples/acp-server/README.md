# DeepAgents ACP Server Example

This example demonstrates how to run DeepAgents as an ACP (Agent Client Protocol) server for integration with IDEs like Zed, JetBrains, and other ACP-compatible clients.

## Prerequisites

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Build the packages:
   ```bash
   pnpm build
   ```

## Running the Server

### Direct Execution

```bash
npx tsx examples/acp-server/server.ts
```

### With Debug Logging

```bash
DEBUG=true npx tsx examples/acp-server/server.ts
```

### With Custom Workspace

```bash
WORKSPACE_ROOT=/path/to/your/project npx tsx examples/acp-server/server.ts
```

## IDE Configuration

### Zed

Add to your Zed settings (`~/.config/zed/settings.json` on Linux, `~/Library/Application Support/Zed/settings.json` on macOS):

```json
{
  "agent": {
    "profiles": {
      "deepagents": {
        "name": "DeepAgents",
        "command": "npx",
        "args": ["tsx", "examples/acp-server/server.ts"],
        "cwd": "/path/to/deepagentsjs",
        "env": {
          "WORKSPACE_ROOT": "${workspaceFolder}"
        }
      }
    }
  }
}
```

### JetBrains IDEs

JetBrains ACP support is coming soon. Check the [ACP documentation](https://agentclientprotocol.com/get-started/clients) for updates.

## Features

The DeepAgents ACP server provides:

- **Full Filesystem Access**: Read, write, edit files in the workspace
- **Code Search**: Grep and glob patterns for finding code
- **Task Management**: Todo list tracking for complex tasks
- **Subagent Delegation**: Spawn specialized subagents for specific tasks
- **Session Persistence**: Maintain conversation context across interactions
- **Multiple Modes**: Switch between Agent, Plan, and Ask modes

## Customization

Edit `server.ts` to customize:

- Model selection
- System prompt
- Skills and memory paths
- Custom tools
- Middleware configuration

## Protocol Details

The server implements the [Agent Client Protocol](https://agentclientprotocol.com):

- Communication: JSON-RPC 2.0 over stdio
- Session management with persistent state
- Streaming responses via session updates
- Tool call tracking and status updates
- Plan/todo list synchronization

## Troubleshooting

### Server not starting

- Check that all dependencies are installed: `pnpm install`
- Ensure packages are built: `pnpm build`
- Check for TypeScript errors: `pnpm typecheck`

### Debug logging

Enable debug mode to see detailed logs:

```bash
DEBUG=true npx tsx examples/acp-server/server.ts
```

Logs are written to stderr to avoid interfering with the ACP protocol on stdout.

### Connection issues

- Verify the command path in your IDE configuration
- Check that the workspace path exists
- Ensure the LLM API key is set (e.g., `ANTHROPIC_API_KEY`)
