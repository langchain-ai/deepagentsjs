/* eslint-disable no-console */
/**
 * Vercel Sandbox Example
 *
 * This example demonstrates the Sandbox Execution Support feature of DeepAgents
 * using Vercel's cloud-based sandbox infrastructure. It shows how to:
 * 1. Create a Vercel Sandbox backend using the @langchain/vercel-sandbox package
 * 2. Use the `execute` tool to run shell commands in an isolated microVM
 * 3. Leverage file upload/download capabilities
 *
 * The VercelSandbox runs commands in an isolated Linux microVM environment,
 * perfect for code execution, project scaffolding, and automation tasks
 * without requiring local Docker or any local setup.
 *
 * ## Prerequisites
 *
 * Set up Vercel authentication using ONE of these methods:
 *
 * ### Option 1: OIDC Token (Recommended for local development)
 *
 * ```bash
 * # Link your project to Vercel
 * vercel link
 *
 * # Pull environment variables (creates .env.local with VERCEL_OIDC_TOKEN)
 * vercel env pull
 * ```
 *
 * ### Option 2: Access Token (For CI/CD or external environments)
 *
 * Set these environment variables:
 * - `VERCEL_TOKEN`: Generate at https://vercel.com/account/tokens
 * - `VERCEL_TEAM_ID`: From your team settings
 * - `VERCEL_PROJECT_ID`: From your project settings
 *
 * ## Running the Example
 *
 * ```bash
 * # With OIDC token (after vercel env pull)
 * node --env-file .env.local --experimental-strip-types examples/sandbox/vercel-sandbox.ts
 *
 * # Or with bun
 * bun run examples/sandbox/vercel-sandbox.ts
 *
 * # Or with tsx
 * npx tsx examples/sandbox/vercel-sandbox.ts
 * ```
 */

import "dotenv/config";

import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";

import { createDeepAgent } from "deepagents";
import { VercelSandbox } from "@langchain/vercel-sandbox";

// System prompt that leverages the execute capability
const systemPrompt = `You are a powerful coding assistant with access to a cloud-based sandboxed shell environment.

You can execute shell commands to:
- Analyze code and projects (e.g., find patterns, count lines, check dependencies)
- Run build tools and scripts (npm, pip, make, etc.)
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
3. Chain commands when needed: \`execute("npm install && npm test")\`
4. Check exit codes to verify success

You're working in an isolated cloud sandbox powered by Vercel, so feel free to experiment!`;

async function main() {
  // Create the Vercel Sandbox
  // This provisions a new isolated Linux microVM environment
  console.log("🚀 Creating Vercel Sandbox...\n");

  const sandbox = await VercelSandbox.create({
    runtime: "node24", // Use Node.js 24 runtime
    timeout: 300000, // 5 minute timeout
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

    const result = await agent.invoke(
      {
        messages: [
          new HumanMessage(
            `Create a simple Node.js project with a hello.js file that prints "Hello from DeepAgents!".
            Then run it with node to verify it works.
            Finally, show me the output.`,
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
    console.log("✅ Sandbox stopped.");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
