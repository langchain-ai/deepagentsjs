/* eslint-disable no-console */
/**
 * Streaming Example: Basic Subgraph Streaming
 *
 * Demonstrates how to enable subgraph streaming to receive events from
 * both the main agent and subagent execution. This is the simplest
 * streaming setup for deep agents.
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/streaming/basic.ts
 */
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent({
  systemPrompt: "You are a helpful research assistant",
  subagents: [
    {
      name: "researcher",
      description: "Researches a topic in depth",
      systemPrompt: "You are a thorough researcher.",
    },
  ],
});

for await (const [namespace, chunk] of await agent.stream(
  {
    messages: [
      { role: "user", content: "Research quantum computing advances" },
    ],
  },
  {
    streamMode: "updates",
    subgraphs: true,
  },
)) {
  if (namespace.length > 0) {
    // Subagent event — namespace identifies the source
    console.log(`[subagent: ${namespace.join("|")}]`);
  } else {
    // Main agent event
    console.log("[main agent]");
  }
  console.log(chunk);
}
