import "dotenv/config";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import * as path from "path";

import { createDeepAgent, FilesystemBackend } from "../../src/index.js";

const systemPrompt = `You are an expert coding assistant with access to the real filesystem.

You can read and write files directly to the filesystem in your working directory.
This makes you perfect for real coding tasks that need to persist on disk.

## Workflow

1. Read existing code files to understand the project structure
2. Create new files or edit existing ones as needed
3. Write implementation plans and documentation

## Important

- All files you create are written to the actual filesystem
- Use the current working directory as your workspace
- You can use standard filesystem tools (ls, read_file, write_file, edit_file)
- Files persist after the conversation ends`;

const workspaceDir = path.join(process.cwd(), "workspace");

export const agent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    temperature: 0,
  }),
  systemPrompt,
  backend: new FilesystemBackend({
    rootDir: workspaceDir,
    virtualMode: true,
  }),
});

async function main() {
  await agent.invoke(
    {
      messages: [
        new HumanMessage(
          "Create a simple TypeScript utility function that validates email addresses.",
        ),
      ],
    },
    { recursionLimit: 50 },
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
