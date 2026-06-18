/**
 * Vercel Sandbox Example
 *
 * This example demonstrates Deep Agents using Vercel Sandbox to execute
 * commands and manipulate files in an isolated cloud environment.
 *
 * ## Prerequisites
 *
 * For local development, link a Vercel project and pull its environment:
 *
 * ```bash
 * vercel link
 * vercel env pull
 * ```
 *
 * Outside Vercel, you can instead set `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`,
 * and `VERCEL_TEAM_ID`.
 *
 * ## Running the Example
 *
 * ```bash
 * npx tsx examples/sandbox/vercel-sandbox.ts
 * ```
 */

import "dotenv/config";

import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { VercelSandbox } from "@langchain/vercel-sandbox";
import { createDeepAgent } from "deepagents";

const systemPrompt = `You are a coding assistant with access to an isolated Vercel Sandbox.

Use the execute and filesystem tools to create, inspect, and run code. Verify
commands by checking their output and exit codes.`;

async function main() {
  console.log("Creating Vercel Sandbox...");

  const sandbox = await VercelSandbox.create({
    runtime: "node24",
  });

  try {
    const agent = createDeepAgent({
      model: new ChatAnthropic({
        model: "claude-haiku-4-5",
        temperature: 0,
      }),
      systemPrompt,
      backend: sandbox,
    });

    const result = await agent.invoke({
      messages: [
        new HumanMessage(
          `Create a TypeScript file called hello.ts that prints "Hello from Deep Agents!".
Run it, then report the command output.`,
        ),
      ],
    });

    const lastAIMessage = result.messages.findLast(AIMessage.isInstance);
    if (lastAIMessage) {
      console.log(lastAIMessage.content);
    }
  } finally {
    await sandbox.close();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
