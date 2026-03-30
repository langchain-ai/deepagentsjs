/**
 * Researcher subagent — deployed to LangGraph Platform
 *
 * A research agent with web search that notifies its parent supervisor
 * when it finishes via the completion notifier middleware.
 *
 * Deployed alongside the supervisor via:
 *   npx @langchain/langgraph-cli dev -c examples/async-subagents/parallel-research/langgraph.json
 */
import "dotenv/config";
import { tool } from "langchain";
import { z } from "zod";
import {
  createDeepAgent,
  createCompletionCallbackMiddleware,
} from "deepagents";

const LANGGRAPH_URL = process.env.LANGGRAPH_URL ?? "http://localhost:2024";

// ─── Web search tool (Tavily with stub fallback) ─────────────────────────────

let searchImpl: (query: string) => Promise<string>;

if (process.env.TAVILY_API_KEY) {
  searchImpl = async (query: string) => {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: 5,
      }),
    });
    const data = (await res.json()) as {
      results?: { title: string; content: string; url: string }[];
    };
    if (!data.results?.length) return `No results found for "${query}"`;
    return data.results
      .map(
        (r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.content}\n   Source: ${r.url}`,
      )
      .join("\n\n");
  };
} else {
  searchImpl = async (query: string) => {
    return [
      `Search results for "${query}":`,
      `1. Key finding: Recent developments show significant progress in ${query}`,
      `2. Expert analysis: Industry leaders are investing heavily in ${query}`,
      `3. Market data: The ${query} sector is projected to grow 25% annually`,
      `4. Trend report: Consumer adoption of ${query} has accelerated`,
      `5. Research paper: New breakthroughs in ${query} published this quarter`,
    ].join("\n");
  };
}

const webSearch = tool(
  async (input: { query: string }) => searchImpl(input.query),
  {
    name: "web_search",
    description:
      "Search the web for information. Use this to find current data, news, and analysis.",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  },
);

// ─── Completion callback ──────────────────────────────────────────────────────

const notifier = createCompletionCallbackMiddleware({
  callbackGraphId: "supervisor",
  url: LANGGRAPH_URL,
});

// ─── Researcher agent ─────────────────────────────────────────────────────────

export const graph = createDeepAgent({
  systemPrompt:
    "You are a thorough research agent. Your job is to investigate a topic using web search, " +
    "analyze the findings, and produce a well-structured research summary.\n\n" +
    "Guidelines:\n" +
    "- Make multiple searches to cover the topic comprehensively\n" +
    "- Synthesize findings into a clear, structured report\n" +
    "- Include key facts, data points, and notable developments\n" +
    "- Cite your sources where possible\n" +
    "- Keep your final report concise but thorough (300-500 words)\n\n" +
    "If you receive a new instruction mid-conversation, immediately follow it without asking for " +
    "clarification. Discard any prior work and start fresh on the new task.",
  tools: [webSearch],
  middleware: [notifier],
});
