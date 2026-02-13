/* eslint-disable no-console */
/**
 * Streaming Example: Filter by Subagent Type
 *
 * Demonstrates how to route streaming events to different handlers
 * based on whether they come from the main agent or a subagent.
 * Uses the "messages" stream mode with subgraphs to identify the
 * source of each token.
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/streaming/filter-by-type.ts
 */
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent({
  systemPrompt:
    "You are a project coordinator. Always delegate research tasks " +
    "to your researcher subagent using the task tool. " +
    "Keep your final response to one sentence.",
  subagents: [
    {
      name: "researcher",
      description: "Researches topics thoroughly",
      systemPrompt:
        "You are a thorough researcher. Provide a concise summary " +
        "in 2-3 sentences.",
    },
    {
      name: "writer",
      description: "Writes polished content based on research",
      systemPrompt:
        "You are a skilled writer. Write clear, engaging content. " +
        "Keep your response concise.",
    },
  ],
});

/**
 * Extract text from a message, handling both the .text getter and
 * raw .content blocks (array of {type:"text", text:"..."} objects).
 */
function getMessageText(message: any): string {
  // The .text getter concatenates content blocks into a string
  if (message.text) return message.text;
  // Fallback: extract directly from content blocks
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("");
  }
  if (typeof message.content === "string" && message.content) {
    return message.content;
  }
  return "";
}

const buffers = new Map<string, string>(); // key → accumulated text

function appendToken(key: string, text: string) {
  buffers.set(key, (buffers.get(key) ?? "") + text);
}

for await (const [namespace, chunk] of await agent.stream(
  {
    messages: [
      {
        role: "user",
        content: "Research and write a brief report on AI safety",
      },
    ],
  },
  { streamMode: "messages", subgraphs: true },
)) {
  const [message] = chunk;
  const text = getMessageText(message);
  if (!text) continue;

  const isSubagent = namespace.some((s: string) => s.startsWith("tools:"));

  if (!isSubagent) {
    appendToken("main", text);
  } else {
    // Route to a buffer keyed by the subagent's namespace
    const subagentNs = namespace.find((s: string) => s.startsWith("tools:"))!;
    appendToken(subagentNs, text);
  }
}

for (const [key, text] of buffers) {
  const label = key === "main" ? "main agent" : `subagent (${key})`;
  console.log(`─── ${label} ───`);
  console.log(text.trim());
  console.log();
}

/**
 * Output:
 * ─── main agent ───
 * I'll delegate this research and writing task to my subagents. ...
 *
 * ─── subagent (tools:658d9588-2c4e-5bc3-8567-913b052be43e) ───
 * I'll write a comprehensive report on AI safety for you. ...
 *
 * ─── subagent (tools:bfdc3028-8b44-5892-9464-ddf83d562034) ───
 * I'll conduct comprehensive research on AI safety by exploring the available resources. ...
 *
 * ─── subagent (tools:62cd9284-9927-5961-92f4-e62874ce9338) ───
 * ...
 */
