/* eslint-disable no-console */
/**
 * LangSmith Sandbox Example
 *
 * This example demonstrates using LangSmith Sandboxes as the execution backend
 * for DeepAgents. Since LangSmith is part of the core LangChain ecosystem,
 * no additional provider package is needed — `LangSmithSandbox` ships directly
 * in the `deepagents` package.
 *
 * It shows how to:
 * 1. Create a LangSmith Sandbox via `LangSmithSandbox.create()`
 * 2. Use the `execute` tool to run shell commands in the cloud sandbox
 * 3. Clean up the sandbox when finished
 *
 * ## Prerequisites
 *
 * Set your LangSmith API key:
 *
 * ```bash
 * export LANGSMITH_API_KEY=your_api_key_here
 * ```
 *
 * You also need a sandbox template created in your LangSmith workspace.
 * The default template name used here is `"deepagents"`.
 *
 * ## Running the Example
 *
 * ```bash
 * npx tsx examples/sandbox/langsmith-sandbox.ts
 * ```
 */

import "dotenv/config";

import { HumanMessage, AIMessage } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";

import { createDeepAgent, LangSmithSandbox } from "deepagents";

const systemPrompt = `You are a powerful coding assistant with access to a cloud-based sandboxed shell environment provided by LangSmith.

You can execute shell commands to:
- Analyze code and projects
- Run build tools and scripts (node, python, npm, pip, etc.)
- Scaffold new projects and files
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

1. Start by exploring the workspace with \`ls\` or \`execute("ls -la")\`
2. Use \`execute\` for complex commands, pipelines, and running programs
3. Chain commands when needed: \`execute("npm install && npm test")\`
4. Check exit codes to verify success

You're working in an isolated sandbox powered by LangSmith — feel free to experiment!`;

async function main() {
  console.log("Creating LangSmith Sandbox...\n");

  const backend = await LangSmithSandbox.create({
    templateName: "deepagents",
  });

  console.log(`Sandbox created with ID: ${backend.id}\n`);

  try {
    const agent = createDeepAgent({
      model: new ChatAnthropic({
        model: "claude-haiku-4-5",
        temperature: 0,
      }),
      systemPrompt,
      backend,
    });

    console.log("Running agent...\n");

    const result = await agent.invoke({
      messages: [
        new HumanMessage(
          `Create a simple Python file called hello.py that prints "Hello from DeepAgents!".
           Then run it with python to verify it works.
           Finally, show me the output.`,
        ),
      ],
    });

    const lastAIMessage = result.messages.findLast(AIMessage.isInstance);
    if (lastAIMessage) {
      console.log("\nAgent Response:\n");
      console.log(lastAIMessage.content);
    }
  } finally {
    console.log("\nCleaning up sandbox...");
    await backend.close();
    console.log("Sandbox deleted.");
  }
}

main().catch(error => {
  console.error("Error:", error);
  process.exit(1);
});
