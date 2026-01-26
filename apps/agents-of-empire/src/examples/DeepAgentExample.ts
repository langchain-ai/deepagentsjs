/**
 * Deep Agent Integration Example
 *
 * This file demonstrates how to create a real Deep Agent and integrate it
 * with the Agents of Empire game.
 */

import "dotenv/config";
import { tool } from "langchain";
import { z } from "zod";
import { createDeepAgent, type SubAgent } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";

// ============================================================================
// Define Tools
// ============================================================================

const searchTool = tool(
  async ({ query }: { query: string }) => {
    console.log("Searching for:", query);
    // Simulate search
    return `Results for "${query}": Found 5 relevant documents.`;
  },
  {
    name: "search",
    description: "Search for information",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  }
);

const writeFileTool = tool(
  async ({ path, content }: { path: string; content: string }) => {
    console.log("Writing file:", path);
    return `Successfully wrote ${content.length} bytes to ${path}`;
  },
  {
    name: "write_file",
    description: "Write content to a file",
    schema: z.object({
      path: z.string().describe("The file path"),
      content: z.string().describe("The file content"),
    }),
  }
);

// ============================================================================
// Define Subagents
// ============================================================================

const researcherSubAgent: SubAgent = {
  name: "researcher",
  description: "Expert at gathering and analyzing information",
  systemPrompt: "You are a dedicated researcher. Find and analyze information thoroughly.",
  tools: [searchTool],
};

const coderSubAgent: SubAgent = {
  name: "coder",
  description: "Expert at writing and debugging code",
  systemPrompt: "You are a skilled programmer. Write clean, efficient code.",
  tools: [writeFileTool],
};

// ============================================================================
// Create the Deep Agent
// ============================================================================

const agent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    temperature: 0,
  }),
  tools: [searchTool, writeFileTool],
  systemPrompt: `You are a strategic commander in the Agents of Empire game.

Your role is to:
1. Analyze objectives given by the player
2. Delegate tasks to your specialized subagents
3. Coordinate efforts to complete goals
4. Report back with results

When given a task:
- Break it down into subtasks
- Use the researcher subagent for information gathering
- Use the coder subagent for implementation tasks
- Provide clear status updates`,
  subagents: [researcherSubAgent, coderSubAgent],
});

// ============================================================================
// Game Integration
// ============================================================================

/**
 * Example: Spawn an agent in the game and connect it to a Deep Agent
 */
export async function spawnDeepAgentInGame(game: any) {
  const bridge = game.getBridge();

  // Spawn visual agent
  const agentId = await bridge.spawnDeepAgent({
    name: "Commander Alpha",
  });

  // Register for streaming events
  bridge.registerAgent(agentId, agent);

  // Give the agent a task
  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content: "Research the latest TypeScript features and write a summary document.",
      },
    ],
  });

  console.log("Agent completed task:", result);

  return { agentId, result };
}

// ============================================================================
// Manual Event Simulation (for testing without full game)
// ============================================================================

/**
 * Simulates the game events that would be generated during agent execution
 */
export async function simulateGameEvents() {
  console.log("=== Agents of Empire - Deep Agent Demo ===\n");

  // Manually emit events to visualize what would happen in-game
  const events = [
    { type: "agent:created", message: "Commander Alpha has spawned!" },
    { type: "agent:thinking", message: "Commander Alpha is analyzing the task..." },
    { type: "subagent:spawned", message: "Researcher subagent has been deployed!" },
    { type: "tool:call:start", message: "Researcher is searching for information..." },
    { type: "tool:call:complete", message: "Search completed successfully!" },
    { type: "subagent:spawned", message: "Coder subagent has been deployed!" },
    { type: "tool:call:start", message: "Coder is writing the document..." },
    { type: "file:written", message: "Document 'typescript_features.md' has been created!" },
    { type: "goal:completed", message: "Task completed successfully!" },
  ];

  for (const event of events) {
    console.log(`[${event.type}] ${event.message}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log("\n=== Demo Complete ===");
}

// Run the demo if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  simulateGameEvents().catch(console.error);
}

export { agent };
