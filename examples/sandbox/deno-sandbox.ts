/* eslint-disable no-console */
/**
 * Deno Sandbox Example
 *
 * This example demonstrates the Sandbox Execution Support feature of DeepAgents
 * using Deno Deploy's cloud-based sandbox infrastructure. It shows how to:
 * 1. Create a Deno Sandbox backend using the @langchain/deno-sandbox package
 * 2. Use the `execute` tool to run shell commands in an isolated microVM
 * 3. Leverage file upload/download capabilities
 *
 * The DenoSandbox runs commands in an isolated Linux microVM environment,
 * perfect for code execution, project scaffolding, and automation tasks
 * without requiring local Docker or any local setup.
 *
 * ## Prerequisites
 *
 * Set up Deno Deploy authentication:
 *
 * 1. Go to https://app.deno.com
 * 2. Navigate to Settings → Organization Tokens
 * 3. Create a new token and set it as environment variable:
 *
 * ```bash
 * export DENO_DEPLOY_TOKEN=your_token_here
 * ```
 *
 * ## Running the Example
 *
 * ```bash
 * # With environment variable
 * npx tsx examples/sandbox/deno-sandbox.ts
 *
 * # Or with bun
 * bun run examples/sandbox/deno-sandbox.ts
 * ```
 */

import "dotenv/config";

import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";

import { createDeepAgent } from "deepagents";
import { DenoSandbox } from "@langchain/deno-sandbox";

// System prompt that leverages the execute capability
const systemPrompt = `You are a powerful coding assistant with access to a cloud-based sandboxed shell environment.

You can execute shell commands to:
- Analyze code and projects (e.g., find patterns, count lines, check dependencies)
- Run build tools and scripts (npm, deno, pip, make, etc.)
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
3. Chain commands when needed: \`execute("deno install && deno run build.ts")\`
4. Check exit codes to verify success

You're working in an isolated cloud sandbox powered by Deno Deploy, so feel free to experiment!`;

async function main() {
  // Create the Deno Sandbox
  // This provisions a new isolated Linux microVM environment
  console.log("🚀 Creating Deno Sandbox...\n");

  const sandbox = await DenoSandbox.create({
    memoryMb: 1024, // 1GB memory
    lifetime: "session", // Shutdown when script ends
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
          `Create a simple TypeScript file called hello.ts that prints "Hello from DeepAgents!".
            Then run it with deno to verify it works.
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
