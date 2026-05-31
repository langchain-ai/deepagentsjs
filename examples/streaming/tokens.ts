/**
 * Streaming Example: LLM Tokens
 *
 * Demonstrates how to stream individual LLM tokens from both the main agent
 * and subagents using the "messages" stream mode. Each token is labeled with
 * its source (main agent or subagent namespace).
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/streaming/tokens.ts
 */
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent({
  systemPrompt:
    "You are a helpful research assistant. Always delegate research " +
    "tasks to your researcher subagent using the task tool. " +
    "Keep your final response to one sentence.",
  subagents: [
    {
      name: "researcher",
      description: "Researches a topic in depth",
      systemPrompt:
        "You are a thorough researcher. Keep your response brief (2-3 sentences).",
    },
  ],
});

let currentSource = "";

for await (const [namespace, chunk] of await agent.stream(
  {
    messages: [
      {
        role: "user",
        content: "Research quantum computing advances",
      },
    ],
  },
  { streamMode: "messages", subgraphs: true },
)) {
  const [message] = chunk;

  // Check if this event came from a subagent (namespace contains "tools:")
  const isSubagent = namespace.some((s: string) => s.startsWith("tools:"));

  if (isSubagent) {
    // Token from a subagent
    const subagentNs = namespace.find((s: string) => s.startsWith("tools:"))!;
    if (subagentNs !== currentSource) {
      process.stdout.write(`\n\n--- [subagent: ${subagentNs}] ---\n`);
      currentSource = subagentNs;
    }
    if (message.text) {
      process.stdout.write(message.text);
    }
  } else {
    // Token from the main agent
    if ("main" !== currentSource) {
      process.stdout.write(`\n\n--- [main agent] ---\n`);
      currentSource = "main";
    }
    if (message.text) {
      process.stdout.write(message.text);
    }
  }
}

process.stdout.write("\n");

/**
 * Output:
 * --- [main agent] ---
 * I'll delegate this research task to my researcher subagent.
 *
 * --- [subagent: tools:3fef7527-e7e9-5f70-b81d-be8c7051a3b7] ---
 * I appreciate your interest in quantum computing advances, but I need to clarify an important limitation: I don't have access to the internet or real-time information databases. I cannot research current events, recent breakthroughs, or developments from the past 2-3 years.
 *
 * I can only access and analyze files in the current filesystem. If you have documents, research papers, articles, or reports about quantum computing saved locally, I'd be happy to read through them and compile a comprehensive report based on those materials.
 *
 * Would you like me to:
 * 1. Check if there are any quantum computing-related documents in the current filesystem?
 * 2. Or, if you can provide or upload relevant materials, I can analyze and synthesize them into the comprehensive report you're requesting?
 *
 * --- [main agent] ---
 * The researcher cannot access real-time information but can analyze quantum computing documents if you have any saved locally in the filesystem.
 */
