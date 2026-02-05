/* eslint-disable no-console */
/**
 * Modal Sandbox Example
 *
 * This example demonstrates the Sandbox Execution Support feature of DeepAgents
 * using Modal's cloud-based sandbox infrastructure. It shows how to:
 * 1. Create a Modal Sandbox backend using the @langchain/modal package
 * 2. Use the `execute` tool to run shell commands in an isolated container
 * 3. Leverage file upload/download capabilities
 *
 * The ModalSandbox runs commands in an isolated container environment,
 * perfect for code execution, project scaffolding, and automation tasks
 * without requiring local Docker or any local setup.
 *
 * ## Prerequisites
 *
 * Set up Modal authentication:
 *
 * 1. Install the Modal CLI: `pip install modal`
 * 2. Run `modal setup` to authenticate
 * 3. Or set environment variables directly:
 *
 * ```bash
 * export MODAL_TOKEN_ID=your_token_id_here
 * export MODAL_TOKEN_SECRET=your_token_secret_here
 * ```
 *
 * ## Running the Example
 *
 * ```bash
 * # With environment variable
 * npx tsx examples/sandbox/modal-sandbox.ts
 *
 * # Or with bun
 * bun run examples/sandbox/modal-sandbox.ts
 * ```
 */

import "dotenv/config";

import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";

import { createDeepAgent } from "deepagents";
import { ModalSandbox } from "@langchain/modal";

// System prompt that leverages the execute capability
const systemPrompt = `You are a powerful coding assistant with access to a cloud-based sandboxed shell environment.

You can execute shell commands to:
- Analyze code and projects (e.g., find patterns, count lines, check dependencies)
- Run build tools and scripts (npm, node, pip, make, etc.)
- Scaffold new projects
- Run tests and linters
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
3. Chain commands when needed: \`execute("npm install && npm run build")\`
4. Check exit codes to verify success

You're working in an isolated cloud sandbox powered by Modal, so feel free to experiment!`;

async function main() {
  // Create the Modal Sandbox
  // This provisions a new isolated container environment
  console.log("🚀 Creating Modal Sandbox...\n");

  const sandbox = await ModalSandbox.create({
    imageName: "python:3.12-slim", // Base image with Python
    timeoutMs: 600_000, // 10 minute timeout
  });

  console.log(`✅ Sandbox created with ID: ${sandbox.id}\n`);

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

    const result = await agent.invoke({
      messages: [
        new HumanMessage(
          `Create a simple Python file called hello.py that prints "Hello from DeepAgents!".
            Then run it with python to verify it works.
            Finally, show me the output.`,
        ),
      ],
    });

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
    await sandbox.close();
    console.log("✅ Sandbox closed.");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
