/**
 * DeepAgents ACP Server Example
 *
 * This example demonstrates how to start a DeepAgents ACP server
 * that can be used with IDEs like Zed, JetBrains, and other ACP clients.
 *
 * Usage:
 *   npx tsx examples/acp-server/server.ts
 *
 * Then configure your IDE to use this agent. For Zed, add to settings.json:
 *
 * {
 *   "agent": {
 *     "profiles": {
 *       "deepagents": {
 *         "name": "DeepAgents",
 *         "command": "npx",
 *         "args": ["tsx", "examples/acp-server/server.ts"],
 *         "cwd": "/path/to/deepagentsjs"
 *       }
 *     }
 *   }
 * }
 */

import { DeepAgentsServer } from "deepagents-server";
import { FilesystemBackend } from "deepagents";
import path from "node:path";

// Get workspace root from environment or use current directory
const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();

// Create the ACP server with a coding assistant agent
const server = new DeepAgentsServer({
  // Agent configuration
  agents: [
    {
      name: "coding-assistant",
      description:
        "AI coding assistant powered by DeepAgents with full filesystem access, " +
        "code search, task management, and subagent delegation capabilities.",

      // Use Claude Sonnet as the default model
      model: "claude-sonnet-4-5-20250929",

      // Use filesystem backend rooted at the workspace
      backend: new FilesystemBackend({
        rootDir: workspaceRoot,
      }),

      // Load skills from the workspace if available
      skills: [
        path.join(workspaceRoot, ".deepagents", "skills"),
        path.join(workspaceRoot, "skills"),
      ],

      // Load memory/context from AGENTS.md files
      memory: [
        path.join(workspaceRoot, ".deepagents", "AGENTS.md"),
        path.join(workspaceRoot, "AGENTS.md"),
      ],

      // Custom system prompt (optional)
      systemPrompt: `You are an AI coding assistant integrated with an IDE through the Agent Client Protocol (ACP).

You have access to the workspace at: ${workspaceRoot}

When working on tasks:
1. First understand the codebase structure
2. Make a plan before making changes
3. Test your changes when possible
4. Explain your reasoning

Always be helpful, concise, and focused on the user's coding tasks.`,
    },
  ],

  // Server configuration
  serverName: "deepagents-acp-server",
  serverVersion: "0.0.1",
  workspaceRoot,

  // Enable debug logging (set to true to see debug output on stderr)
  debug: process.env.DEBUG === "true",
});

// Start the server
console.error("[deepagents] Starting ACP server...");
console.error(`[deepagents] Workspace: ${workspaceRoot}`);

server.start().catch((error) => {
  console.error("[deepagents] Server error:", error);
  process.exit(1);
});
