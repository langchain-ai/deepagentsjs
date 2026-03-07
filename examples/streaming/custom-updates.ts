/* eslint-disable no-console */
/**
 * Streaming Example: Custom Updates
 *
 * Demonstrates how to emit and capture custom progress events from
 * inside subagent tools using config.writer and the "custom" stream mode.
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/streaming/custom-updates.ts
 */
import { createDeepAgent } from "deepagents";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

/**
 * A tool that emits custom progress events via config.writer.
 * The writer sends data to the "custom" stream mode.
 */
const analyzeData = tool(
  async ({ topic }: { topic: string }, config: ToolRuntime) => {
    const writer = config.writer;

    writer?.({ status: "starting", topic, progress: 0 });
    await new Promise((r) => setTimeout(r, 500));

    writer?.({ status: "analyzing", progress: 50 });
    await new Promise((r) => setTimeout(r, 500));

    writer?.({ status: "complete", progress: 100 });
    return `Analysis of "${topic}": Customer sentiment is 85% positive, driven by product quality and support response times.`;
  },
  {
    name: "analyze_data",
    description:
      "Run a data analysis on a given topic. " +
      "This tool performs the actual analysis and emits progress updates. " +
      "You MUST call this tool for any analysis request.",
    schema: z.object({
      topic: z.string().describe("The topic or subject to analyze"),
    }),
  },
);

const agent = createDeepAgent({
  systemPrompt:
    "You are a coordinator. For any analysis request, you MUST delegate " +
    "to the analyst subagent using the task tool. Never try to answer directly. " +
    "After receiving the result, summarize it in one sentence.",
  subagents: [
    {
      name: "analyst",
      description: "Performs data analysis with real-time progress tracking",
      systemPrompt:
        "You are a data analyst. You MUST call the analyze_data tool " +
        "for every analysis request. Do not use any other tools. " +
        "After the analysis completes, report the result.",
      tools: [analyzeData],
    },
  ],
});

for await (const [namespace, chunk] of await agent.stream(
  {
    messages: [
      {
        role: "user",
        content: "Analyze customer satisfaction trends",
      },
    ],
  },
  { streamMode: "custom", subgraphs: true },
)) {
  const isSubagent = namespace.some((s: string) => s.startsWith("tools:"));
  if (isSubagent) {
    const subagentNs = namespace.find((s: string) => s.startsWith("tools:"))!;
    console.log(`[${subagentNs}]`, chunk);
  } else {
    console.log("[main]", chunk);
  }
}

/**
 * Output:
 * [tools:f3cf31ac-4a7d-57b5-8809-24c1ac2dea40] {
 *   status: "starting",
 *   topic: "customer satisfaction trends",
 *   progress: 0,
 * }
 * [tools:f3cf31ac-4a7d-57b5-8809-24c1ac2dea40] {
 *   status: "analyzing",
 *   progress: 50,
 * }
 * [tools:f3cf31ac-4a7d-57b5-8809-24c1ac2dea40] {
 *   status: "complete",
 *   progress: 100,
 * }
 */
