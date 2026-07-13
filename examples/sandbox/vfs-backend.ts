/**
 * Node.js VFS Backend Example
 *
 * This example demonstrates DeepAgents with an in-memory Virtual File System backend.
 * It shows how to:
 * 1. Create a VFS backend using the @langchain/node-vfs package
 * 2. Pre-populate the backend with initial files
 * 3. Let the agent use filesystem tools (`ls`, `read_file`, `write_file`, etc.)
 *
 * The VfsBackend provides an isolated in-memory filesystem,
 * perfect for file workflows without affecting the real filesystem.
 * No external services, Docker, or cloud setup required!
 *
 * ## About Node.js VFS
 *
 * This package uses node-vfs-polyfill which implements the upcoming Node.js
 * Virtual File System feature (nodejs/node#61478). When the official node:vfs
 * module lands, this package will be updated to use the native implementation.
 *
 * ## Running the Example
 *
 * ```bash
 * npx tsx examples/sandbox/vfs-backend.ts
 * # or
 * bun run examples/sandbox/vfs-backend.ts
 * ```
 */

import "dotenv/config";

import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";

import { createDeepAgent } from "deepagents";
import { VfsBackend } from "@langchain/node-vfs";

// System prompt for a filesystem-only backend
const systemPrompt = `You are a powerful coding assistant with access to an in-memory virtual file system.

You can inspect and modify files safely inside this virtual workspace.

## Tools Available

- **ls**: List directory contents
- **read_file**: Read file contents
- **write_file**: Create or fully replace files
- **edit_file**: Modify existing files
- **delete**: Delete files or directories recursively
- **grep**: Search for patterns in files
- **glob**: Find files matching patterns

## Best Practices

1. Start by exploring the workspace: \`ls\`
2. Use the right tool for the job:
   - Use \`read_file\` for viewing file contents
   - Use \`write_file\` for creating new files or replacing an entire file
3. Prefer focused file edits and verification steps

You're working in an isolated in-memory file system, so feel free to experiment.
All files exist only in memory and are cleaned up when the backend stops.`;

async function main() {
  // Create the VFS backend with some initial files
  console.log("🚀 Creating VFS backend...\n");

  const backend = await VfsBackend.create({
    initialFiles: {
      // Pre-populate with a simple project structure
      "/package.json": JSON.stringify(
        {
          name: "vfs-demo",
          version: "1.0.0",
          type: "module",
        },
        null,
        2,
      ),
      "/README.md":
        "# VFS Demo Project\n\nThis project was created in a virtual file system!",
    },
  });

  console.log("✅ Backend created.");
  console.log(`📁 Working directory: ${backend.workingDirectory}\n`);

  try {
    // Create the agent with VFS backend
    const agent = createDeepAgent({
      model: new ChatAnthropic({
        model: "claude-haiku-4-5",
        temperature: 0,
      }),
      systemPrompt,
      backend,
    });

    console.log("🤖 Running agent...\n");

    const result = await agent.invoke(
      {
        messages: [
          new HumanMessage(
            `Create a simple Node.js project with a hello.js file that prints "Hello from VFS!".
            Then explain what to run locally to verify it.
            Finally, list all files in the workspace.`,
          ),
        ],
      },
      { recursionLimit: 50 },
    );

    // Show the final AI response
    const messages = result.messages;
    const lastAIMessage = messages.findLast(AIMessage.isInstance);

    if (lastAIMessage) {
      console.log("\n📝 Agent Response:\n");
      console.log(lastAIMessage.content);
    }
  } finally {
    // Always cleanup the backend
    console.log("\n🧹 Cleaning up backend...");
    await backend.stop();
    console.log("✅ Backend stopped. All files cleaned up.");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
