/* eslint-disable no-console */
/**
 * Streaming Example: Subagent Progress
 *
 * Demonstrates how to track subagent execution progress using the "updates"
 * stream mode. Each step completion from both the main agent and subagents
 * is reported as a streaming event.
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/streaming/progress.ts
 */
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent({
  systemPrompt:
    "You are a project coordinator. Always delegate research tasks " +
    "to your researcher subagent using the task tool. Keep your final response to one sentence.",
  subagents: [
    {
      name: "researcher",
      description: "Researches topics thoroughly",
      systemPrompt:
        "You are a thorough researcher. Research the given topic " +
        "and provide a concise summary in 2-3 sentences.",
    },
  ],
});

for await (const [namespace, chunk] of await agent.stream(
  {
    messages: [
      { role: "user", content: "Write a short summary about AI safety" },
    ],
  },
  { streamMode: "updates", subgraphs: true },
)) {
  // Main agent updates (empty namespace)
  if (namespace.length === 0) {
    for (const [nodeName, data] of Object.entries(chunk)) {
      if (nodeName === "tools") {
        // Subagent results returned to main agent
        for (const msg of (data as any).messages ?? []) {
          if (msg.type === "tool") {
            console.log(`\nSubagent complete: ${msg.name}`);
            console.log(`  Result: ${String(msg.content).slice(0, 200)}...`);
          }
        }
      } else {
        console.log(`[main agent] step: ${nodeName}`);
      }
    }
  }
  // Subagent updates (non-empty namespace)
  else {
    for (const [nodeName] of Object.entries(chunk)) {
      console.log(`  [${namespace[0]}] step: ${nodeName}`);
    }
  }
}

/**
 * Output:
 * [main agent] step: patchToolCallsMiddleware.before_agent
 * [main agent] step: SummarizationMiddleware.before_model
 * [main agent] step: model_request
 * [main agent] step: todoListMiddleware.after_model
 *   [tools:3a048147-0e03-5e90-8b0e-f7fbfa3fdd77] step: patchToolCallsMiddleware.before_agent
 *   [tools:3a048147-0e03-5e90-8b0e-f7fbfa3fdd77] step: SummarizationMiddleware.before_model
 *   [tools:3a048147-0e03-5e90-8b0e-f7fbfa3fdd77] step: model_request
 *   [tools:3a048147-0e03-5e90-8b0e-f7fbfa3fdd77] step: todoListMiddleware.after_model
 *   [tools:3a048147-0e03-5e90-8b0e-f7fbfa3fdd77] step: tools
 *   [tools:3a048147-0e03-5e90-8b0e-f7fbfa3fdd77] step: SummarizationMiddleware.before_model
 *   [tools:3a048147-0e03-5e90-8b0e-f7fbfa3fdd77] step: model_request
 *   [tools:3a048147-0e03-5e90-8b0e-f7fbfa3fdd77] step: todoListMiddleware.after_model
 *
 * Subagent complete: task
 *   Result: Since there are no local files available to research from, I'll provide you with a comprehensive summary based on established knowledge of AI safety:
 *
 * ## AI Safety: A Comprehensive Summary
 *
 * **AI safet...
 * [main agent] step: SummarizationMiddleware.before_model
 * [main agent] step: model_request
 * [main agent] step: todoListMiddleware.after_model
 */
