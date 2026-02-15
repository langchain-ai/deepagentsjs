/* eslint-disable no-console */
/**
 * Streaming Example: Tool Calls
 *
 * Demonstrates how to stream tool call events from subagent execution
 * using the "messages" stream mode. Shows tool call names, arguments,
 * and results as they happen in real time.
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/streaming/tool-calls.ts
 */
import { createDeepAgent } from "deepagents";
import { tool, AIMessageChunk, ToolMessage } from "langchain";
import { z } from "zod";

/**
 * A simple search tool for the subagent to use.
 */
const searchWeb = tool(
  async ({ query }: { query: string }) => {
    return (
      `Search results for "${query}": Recent studies show significant ` +
      `progress in quantum error correction, with Google achieving ` +
      `below-threshold error rates. IBM has released its 1000+ qubit processor.`
    );
  },
  {
    name: "search_web",
    description: "Search the web for current information on a topic",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  },
);

const agent = createDeepAgent({
  systemPrompt:
    "You are a research coordinator. Always delegate research tasks " +
    "to your researcher subagent using the task tool. " +
    "Summarize the results in one sentence.",
  subagents: [
    {
      name: "researcher",
      description: "Researches topics using web search",
      systemPrompt:
        "You are a researcher. Always use the search_web tool to find " +
        "information before answering. Keep your response brief.",
      tools: [searchWeb],
    },
  ],
});

for await (const [namespace, chunk] of await agent.stream(
  {
    messages: [
      {
        role: "user",
        content: "Research recent quantum computing advances",
      },
    ],
  },
  { streamMode: "messages", subgraphs: true },
)) {
  const [message] = chunk;

  // Identify source: "main" or the subagent namespace segment
  const isSubagent = namespace.some((s: string) => s.startsWith("tools:"));
  const source = isSubagent
    ? namespace.find((s: string) => s.startsWith("tools:"))!
    : "main";

  // Tool call chunks (streaming tool invocations)
  if (AIMessageChunk.isInstance(message) && message.tool_call_chunks?.length) {
    for (const tc of message.tool_call_chunks) {
      if (tc.name) {
        console.log(`\n[${source}] Tool call: ${tc.name}`);
      }
      // Args stream in chunks — write them incrementally
      if (tc.args) {
        process.stdout.write(tc.args);
      }
    }
  }

  // Tool results
  if (ToolMessage.isInstance(message)) {
    console.log(
      `\n[${source}] Tool result [${message.name}]: ${message.text?.slice(0, 150)}`,
    );
  }

  // Regular AI content (skip tool call messages)
  if (
    AIMessageChunk.isInstance(message) &&
    message.text &&
    !message.tool_call_chunks?.length
  ) {
    process.stdout.write(message.text);
  }
}

process.stdout.write("\n");

/**
 * Output:
 * I'll delegate this research task to my researcher subagent.
 * [main] Tool call: task
 * {"subagent_type": "researcher", "description": "Research recent advances in quantum computing. Focus on breakthroughs from the past 1-2 years including:\n- Major technological achievements (e.g., error correction, qubit improvements, quantum advantage demonstrations)\n- Key companies and research institutions making progress\n- Practical applications being developed\n- Important milestones reached\n\nProvide a comprehensive summary of the most significant recent developments in quantum computing."}I'll research recent advances in quantum computing for you, focusing on breakthroughs from the past 1-2 years.
 * [tools:f0ba5566-5a4a-5435-9afb-484771b89475] Tool call: search_web
 * {"query": "quantum computing breakthroughs 2023 2024 error correction"}
 * [tools:f0ba5566-5a4a-5435-9afb-484771b89475] Tool call: search_web
 * {"query": "quantum advantage demonstrations 2024 Google IBM"}
 * [tools:f0ba5566-5a4a-5435-9afb-484771b89475] Tool call: search_web
 * {"query": "quantum computing practical applications 2024"}
 * [tools:f0ba5566-5a4a-5435-9afb-484771b89475] Tool call: search_web
 * {"query": "quantum computing milestones 2023 2024 companies research"}
 * ...
 */
