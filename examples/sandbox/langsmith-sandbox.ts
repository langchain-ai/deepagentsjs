/* eslint-disable no-console */
/**
 * LangSmith Sandbox Example
 *
 * This example demonstrates the Sandbox Execution Support feature of DeepAgents
 * using LangSmith's cloud-based sandbox infrastructure. It shows how to:
 * 1. Create a LangSmith Sandbox backend using the @langchain/langsmith-sandbox package
 * 2. Use the `execute` tool to run shell commands in an isolated environment
 * 3. Leverage file upload/download capabilities
 *
 * The LangSmithSandbox runs commands in an isolated sandbox environment,
 * perfect for code execution, project scaffolding, and automation tasks
 * without requiring local Docker or any local setup.
 *
 * ## Prerequisites
 *
 * Set up LangSmith authentication:
 *
 * 1. Go to https://smith.langchain.com
 * 2. Get your API key from settings
 * 3. Set it as environment variable:
 *
 * ```bash
 * export LANGSMITH_API_KEY=your_api_key_here
 * ```
 *
 * ## Running the Example
 *
 * ```bash
 * # With environment variable
 * npx tsx examples/sandbox/langsmith-sandbox.ts
 *
 * # Or with bun
 * bun run examples/sandbox/langsmith-sandbox.ts
 * ```
 */

import "dotenv/config";

import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";

import { createDeepAgent } from "deepagents";
import { LangSmithSandbox } from "@langchain/langsmith-sandbox";

// System prompt that leverages the execute capability
const systemPrompt = `You are a powerful coding assistant with access to a cloud-based sandboxed shell environment.

You can execute shell commands to:
- Analyze code and projects (e.g., find patterns, count lines, check dependencies)
- Run build tools and scripts (npm, python, pip, make, etc.)
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
3. Chain commands when needed: \`execute("pip install flask && python app.py")\`
4. Check exit codes to verify success

You're working in an isolated cloud sandbox powered by LangSmith, so feel free to experiment!`;

async function main() {
  // Create the LangSmith Sandbox
  // This provisions a new isolated sandbox environment
  console.log("🚀 Creating LangSmith Sandbox...\n");

  const sandbox = await LangSmithSandbox.create({
    templateName: "deepagentsjs",
    timeout: 180, // 3 minutes timeout for sandbox readiness
  });

  console.log(`✅ Sandbox created with ID: ${sandbox.id}\n`);
  console.log(`   Name: ${sandbox.name}`);
  console.log(`   Dataplane URL: ${sandbox.dataplaneUrl}\n`);

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
