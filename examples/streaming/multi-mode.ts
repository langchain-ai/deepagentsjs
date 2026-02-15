/* eslint-disable no-console */
/**
 * Streaming Example: Multiple Stream Modes
 *
 * Demonstrates how to combine multiple stream modes ("updates", "messages",
 * "custom") to get a complete picture of agent execution in a single stream.
 *
 * When using multiple modes with subgraphs, each stream item is a 3-tuple:
 *   [namespace, mode, data]
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/streaming/multi-mode.ts
 */
import { createDeepAgent } from "deepagents";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

/**
 * A tool that emits custom progress events via config.writer.
 */
const analyzeData = tool(
  async ({ topic }: { topic: string }, config: ToolRuntime) => {
    config.writer?.({ status: "starting", topic, progress: 0 });
    await new Promise((r) => setTimeout(r, 300));
    config.writer?.({ status: "analyzing", progress: 50 });
    await new Promise((r) => setTimeout(r, 300));
    config.writer?.({ status: "complete", progress: 100 });
    return `Analysis of "${topic}": Strong positive trend identified.`;
  },
  {
    name: "analyze_data",
    description:
      "Run a data analysis on a given topic. " +
      "You MUST call this tool for any analysis request.",
    schema: z.object({
      topic: z.string().describe("The topic to analyze"),
    }),
  },
);

const agent = createDeepAgent({
  systemPrompt:
    "You are a coordinator. For any analysis request, you MUST delegate " +
    "to the analyst subagent using the task tool. Never answer directly. " +
    "In the task description, tell the subagent to call the analyze_data tool. " +
    "After receiving the result, summarize it in one sentence.",
  subagents: [
    {
      name: "analyst",
      description: "Performs data analysis with real-time progress tracking",
      systemPrompt:
        "You are a data analyst. When asked to analyze something, " +
        "you MUST immediately call the analyze_data tool with the topic. " +
        "Do NOT search the filesystem, list directories, or use any other tools. " +
        "Only use analyze_data. After it completes, report the result briefly.",
      tools: [analyzeData],
    },
  ],
});

// Skip internal middleware steps — only show meaningful node names
const INTERESTING_NODES = new Set(["model_request", "tools"]);

let lastSource = "";
let midLine = false; // true when we've written tokens without a trailing newline

for await (const [namespace, mode, data] of await agent.stream(
  {
    messages: [
      {
        role: "user",
        content: "Analyze the impact of remote work on team productivity",
      },
    ],
  },
  { streamMode: ["updates", "messages", "custom"], subgraphs: true },
)) {
  const isSubagent = namespace.some((s: string) => s.startsWith("tools:"));
  const source = isSubagent ? "subagent" : "main";

  if (mode === "updates") {
    for (const nodeName of Object.keys(data)) {
      if (!INTERESTING_NODES.has(nodeName)) continue;
      if (midLine) {
        process.stdout.write("\n");
        midLine = false;
      }
      console.log(`[${source}] step: ${nodeName}`);
    }
  } else if (mode === "messages") {
    const [message] = data;
    if (message.text) {
      // Print a header when the source changes
      if (source !== lastSource) {
        if (midLine) {
          process.stdout.write("\n");
        }
        process.stdout.write(`\n[${source}] `);
        lastSource = source;
      }
      process.stdout.write(message.text);
      midLine = true;
    }
  } else if (mode === "custom") {
    if (midLine) {
      process.stdout.write("\n");
      midLine = false;
    }
    console.log(`[${source}] custom event:`, data);
  }
}

process.stdout.write("\n");

/**
 * Output:
 * [main] I'll delegate this analysis to the analyst subagent for you.
 * [main] step: model_request
 *
 * [subagent] I'll analyze the impact of remote work on team productivity for you using the analyze_data tool.
 * [subagent] step: model_request
 * [subagent] custom event: {
 *   status: "starting",
 *   topic: "impact of remote work on team productivity",
 *   progress: 0,
 * }
 * [subagent] custom event: {
 *   status: "analyzing",
 *   progress: 50,
 * }
 * [subagent] custom event: {
 *   status: "complete",
 *   progress: 100,
 * }
 * Analysis of "impact of remote work on team productivity": Strong positive trend identified.
 * [subagent] step: tools
 * # Comprehensive Report: Impact of Remote Work on Team Productivity
 *
 * Based on the analysis conducted, here is...
 */
