/* eslint-disable no-console */
/**
 * Memory Agent Example
 *
 * This example demonstrates how to use the `memory` parameter in createDeepAgent
 * to load persistent context from AGENTS.md files.
 *
 * AGENTS.md files follow the agents.md specification (https://agents.md/) and provide
 * project-specific context that is always loaded at agent startup.
 *
 * To run this example:
 *   npx tsx examples/memory/memory-agent.ts
 *
 * Prerequisites:
 *   - Set ANTHROPIC_API_KEY environment variable
 */

import "dotenv/config";
import { HumanMessage } from "@langchain/core/messages";
import * as path from "node:path";

import { createDeepAgent, FilesystemBackend } from "deepagents";

// Path to this example directory (where AGENTS.md is located)
const exampleDir = path.dirname(new URL(import.meta.url).pathname);

async function main() {
  console.log("🧠 Memory Agent Example\n");
  console.log(
    "This example demonstrates how the agent loads context from AGENTS.md files.\n",
  );

  // Create a FilesystemBackend that can read the AGENTS.md file
  const backend = new FilesystemBackend({
    rootDir: exampleDir,
  });

  // Create the agent with memory sources
  // The `memory` parameter accepts an array of paths to AGENTS.md files
  // These are loaded at startup and injected into the system prompt
  const agent = createDeepAgent({
    model: "claude-haiku-4-5-20251001",
    systemPrompt: `You are a helpful coding assistant.
When asked about project context, code style, or build commands,
refer to the memory that was loaded from AGENTS.md files.`,
    backend,
    // Memory sources - paths to AGENTS.md files to load
    // These files are loaded in order and their content is combined
    memory: [
      // Load the AGENTS.md file from this example directory
      path.join(exampleDir, "AGENTS.md"),
    ],
  });

  console.log("📁 Memory source:", path.join(exampleDir, "AGENTS.md"));
  console.log("\n" + "─".repeat(60) + "\n");

  // Ask the agent about the project context from memory
  console.log(
    "💬 Asking: What are the code style guidelines for this project?\n",
  );

  const result = await agent.invoke(
    {
      messages: [
        new HumanMessage(
          "What are the code style guidelines for this project? Also, what build commands are available?",
        ),
      ],
    },
    { recursionLimit: 10 },
  );

  // Get the last AI message
  const messages = result.messages;
  const lastMessage = messages[messages.length - 1];

  console.log("🤖 Agent response:\n");
  console.log(lastMessage.content);
  console.log("\n" + "─".repeat(60));

  console.log("\n💡 Tips:");
  console.log("   - Memory is loaded once at agent startup");
  console.log("   - Multiple AGENTS.md files can be combined in order");
  console.log(
    "   - Use memory for project context, code style, and architecture notes",
  );
  console.log("   - Unlike skills, memory is always available (not on-demand)");
}

main().catch(console.error);
