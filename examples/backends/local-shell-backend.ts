import "dotenv/config";
import path from "node:path";

import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";

import { createDeepAgent, LocalShellBackend } from "deepagents";

const systemPrompt = `You are an expert coding assistant with access to the local filesystem and shell.

You can read and write files directly AND execute shell commands on the host system.
This makes you ideal for local development tasks that require both file manipulation
and running build tools, tests, or other CLI commands.

## Workflow

1. Read existing code files to understand the project structure
2. Create new files or edit existing ones as needed
3. Execute shell commands (e.g., install dependencies, run tests, build projects)
4. Inspect command output and iterate

## Important

- All files and commands operate directly on the host filesystem
- Shell commands run with your user's permissions — use responsibly
- Use the workspace directory as your working directory
- You have access to filesystem tools (ls, read_file, write_file, edit_file) and shell execution`;

const workspaceDir = path.join(process.cwd(), "workspace");

export const agent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-sonnet-4-5",
    temperature: 0,
  }),
  systemPrompt,
  backend: new LocalShellBackend({
    rootDir: workspaceDir,
    virtualMode: true,
    inheritEnv: true,
    timeout: 60,
  }),
});

await agent.invoke(
  {
    messages: [
      new HumanMessage(
        "Create a simple Node.js project with a package.json, install vitest, and write a basic test that passes.",
      ),
    ],
  },
  { recursionLimit: 50 },
);
