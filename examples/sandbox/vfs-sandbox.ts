/* eslint-disable no-console */
/**
 * Node.js VFS Sandbox Example
 *
 * This example demonstrates the Sandbox Execution Support feature of DeepAgents
 * using an in-memory Virtual File System. It shows how to:
 * 1. Create a VFS Sandbox backend using the @langchain/vfs-sandbox package
 * 2. Use the `execute` tool to run shell commands in an isolated environment
 * 3. Pre-populate the sandbox with initial files
 *
 * The VfsSandbox runs commands in an isolated in-memory filesystem,
 * perfect for code execution without affecting the real filesystem.
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
 * npx tsx examples/sandbox/vfs-sandbox.ts
 * # or
 * bun run examples/sandbox/vfs-sandbox.ts
 * ```
 */

import "dotenv/config";

import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";

import { createDeepAgent } from "deepagents";
import { VfsSandbox } from "@langchain/vfs-sandbox";

// System prompt that leverages the execute capability
const systemPrompt = `You are a powerful coding assistant with access to an in-memory virtual file system.

You can execute shell commands to:
- Analyze code and projects (e.g., find patterns, count lines, check dependencies)
- Run build tools and scripts (npm, node, etc.)
- Create and run code files
- Manipulate files and directories

## Tools Available

- **execute**: Run any shell command and see the output
- **ls**: List directory contents
- **read_file**: Read file contents
- **write_file**: Create new files
- **edit_file**: Modify existing files
- **grep**: Search for patterns in files
- **glob**: Find files matching patterns

## Best Practices

1. Start by exploring the workspace: \`ls\` or \`execute("ls -la")\`
2. Use the right tool for the job:
   - Use \`execute\` for complex commands, pipelines, and running programs
   - Use \`read_file\` for viewing file contents
   - Use \`write_file\` for creating new files
3. Chain commands when needed: \`execute("npm install && npm test")\`
4. Check exit codes to verify success

You're working in an isolated in-memory file system, so feel free to experiment!
All files exist only in memory and are cleaned up when the sandbox stops.`;

async function main() {
  // Create the VFS Sandbox with some initial files
  console.log("🚀 Creating VFS Sandbox...\n");

  const sandbox = await VfsSandbox.create({
    initialFiles: {
      // Pre-populate with a simple project structure
      "/package.json": JSON.stringify(
        {
          name: "vfs-demo",
          version: "1.0.0",
          type: "module",
        },
        null,
        2
      ),
      "/README.md": "# VFS Demo Project\n\nThis project was created in a virtual file system!",
    },
  });

  console.log(`✅ Sandbox created with ID: ${sandbox.id}`);
  console.log(`📁 Working directory: ${sandbox.workingDirectory}\n`);

  try {
    // Create the agent with sandbox backend
    const agent = createDeepAgent({
      model: new ChatAnthropic({
        model: "claude-haiku-4-5",
        temperature: 0,
      }),
      systemPrompt,
      backend: sandbox,
    });

    console.log("🤖 Running agent...\n");

    const result = await agent.invoke(
      {
        messages: [
          new HumanMessage(
            `Create a simple Node.js project with a hello.js file that prints "Hello from VFS!".
            Then run it with node to verify it works.
            Finally, show me the output and list all files in the workspace.`,
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
    // Always cleanup the sandbox
    console.log("\n🧹 Cleaning up sandbox...");
    await sandbox.stop();
    console.log("✅ Sandbox stopped. All files cleaned up.");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
