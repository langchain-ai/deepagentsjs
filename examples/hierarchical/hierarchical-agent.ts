/* eslint-disable no-console */
/**
 * Hierarchical Deep Agent Example
 *
 * Demonstrates multi-level agent hierarchies where a deep agent acts as a
 * subagent of another deep agent. This pattern enables:
 *
 * - **Agent-as-subagent**: A full `createDeepAgent` can be used as a
 *   `CompiledSubAgent` in a parent agent
 * - **Multi-level nesting**: Sub-agents can themselves have sub-agents,
 *   creating arbitrarily deep hierarchies
 * - **LLM-driven orchestration**: The parent agent's LLM planner decides
 *   when to invoke a sub-agent vs. using a tool directly
 *
 * Architecture:
 * ```
 * Main Agent (orchestrator)
 *   ├── Tool: get_weather
 *   └── Sub Agent: research-specialist (DeepAgent)
 *       ├── Tool: get_news
 *       ├── Tool: analyze_data
 *       └── Sub Agent: fact-checker (simple SubAgent)
 *           └── Tool: verify_claim
 * ```
 *
 * @see https://github.com/anthropics/deepagentsjs/issues/206
 */
import { tool } from "langchain";
import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";

import {
  createDeepAgent,
  type CompiledSubAgent,
  type SubAgent,
} from "deepagents";

// ─── Tools ──────────────────────────────────────────────────────────────────
const getWeather = tool(
  (input) => `The weather in ${input.location} is sunny and 72°F.`,
  {
    name: "get_weather",
    description: "Get the current weather for a location",
    schema: z.object({
      location: z.string().describe("The city or location to get weather for"),
    }),
  },
);

const getNews = tool(
  (input) =>
    `Latest news for "${input.topic}":\n` +
    `1. Major breakthrough in ${input.topic} announced today\n` +
    `2. Experts weigh in on the future of ${input.topic}\n` +
    `3. New study reveals surprising findings about ${input.topic}`,
  {
    name: "get_news",
    description: "Search for the latest news articles on a topic",
    schema: z.object({
      topic: z.string().describe("The topic to search news for"),
    }),
  },
);

const analyzeData = tool(
  (input) =>
    `Analysis of "${input.data}":\n` +
    `The data shows a positive trend with key insights:\n` +
    `- Primary finding: significant growth in the area\n` +
    `- Secondary finding: emerging patterns suggest continued development\n` +
    `- Recommendation: further investigation warranted`,
  {
    name: "analyze_data",
    description: "Analyze provided data and return insights",
    schema: z.object({
      data: z.string().describe("The data or topic to analyze"),
    }),
  },
);

const verifyClaim = tool(
  (input) =>
    `Verification of "${input.claim}":\n` +
    `Status: ${input.claim.length > 20 ? "Partially verified" : "Verified"}\n` +
    `Confidence: High\n` +
    `Sources: 3 independent sources confirmed`,
  {
    name: "verify_claim",
    description: "Verify a factual claim against known sources",
    schema: z.object({
      claim: z.string().describe("The claim to verify"),
    }),
  },
);

// ─── Level 2 Sub-Agent: Fact Checker (simple SubAgent within the research agent) ─
const factCheckerSubAgent: SubAgent = {
  name: "fact-checker",
  description:
    "A fact-checking agent that can verify claims. " +
    "Use this when you need to validate specific facts or statements.",
  systemPrompt:
    "You are a fact-checking specialist. Use the verify_claim tool to check " +
    "the accuracy of any claims or statements you receive. Always verify before " +
    "drawing conclusions.",
  tools: [verifyClaim],
};

// ─── Level 1 Sub-Agent: Research Specialist (itself a DeepAgent) ─────────────
/**
 * This deep agent acts as a sub-agent of the main agent.
 * It has its own tools, sub-agents, and full agent capabilities including
 * filesystem, todo management, and summarization.
 */
const researchDeepAgent = createDeepAgent({
  systemPrompt:
    "You are a research specialist. Your role is to gather news, analyze data, " +
    "and produce well-researched findings.\n\n" +
    "When asked to research a topic:\n" +
    "1. Use the get_news tool to gather the latest information\n" +
    "2. Use the analyze_data tool to analyze the findings\n" +
    "3. If you need to verify specific claims, delegate to the fact-checker sub-agent\n" +
    "4. Write a concise summary of your research findings",
  tools: [getNews, analyzeData],
  subagents: [factCheckerSubAgent],
});

// ─── Level 0: Main Orchestrator Agent ────────────────────────────────────────

/**
 * The main agent orchestrates between its own tools and sub-agents.
 * The LLM decides whether to:
 * - Use get_weather directly for weather queries
 * - Delegate to the research-specialist deep agent for research tasks
 */
export const mainAgent = createDeepAgent({
  systemPrompt:
    "You are a helpful assistant that coordinates different capabilities.\n\n" +
    "- For weather queries, use the get_weather tool directly\n" +
    "- For research, analysis, or news queries, delegate to the research-specialist " +
    "sub-agent which has specialized tools for these tasks\n\n" +
    "Always choose the most appropriate tool or sub-agent for each task.",
  tools: [getWeather],
  subagents: [
    {
      name: "research-specialist",
      description:
        "A specialized research agent with its own tools and sub-agents. " +
        "It can search for news, analyze data, and verify facts. " +
        "Use this for any research, analysis, or investigation tasks.",
      runnable: researchDeepAgent,
    } satisfies CompiledSubAgent,
  ],
});

// ─── Run ─────────────────────────────────────────────────────────────────────
console.log("=== Hierarchical Deep Agent Example ===\n");

// Test 1: Direct tool use (weather) — main agent handles this itself
console.log("--- Query 1: Direct tool use (weather) ---");
const result1 = await mainAgent.invoke({
  messages: [new HumanMessage("What's the weather in San Francisco?")],
});
const lastMsg1 = result1.messages[result1.messages.length - 1];
console.log(
  "Response:",
  typeof lastMsg1.content === "string"
    ? `${lastMsg1.content.slice(0, 200)}...`
    : lastMsg1.content,
);

// Test 2: Delegate to research sub-agent (DeepAgent)
console.log("\n--- Query 2: Delegate to research sub-agent ---");
const result2 = await mainAgent.invoke({
  messages: [
    new HumanMessage(
      "Research the latest developments in renewable energy and provide an analysis.",
    ),
  ],
});
const lastMsg2 = result2.messages[result2.messages.length - 1];
console.log(
  "Response:",
  typeof lastMsg2.content === "string"
    ? `${lastMsg2.content.slice(0, 200)}...`
    : lastMsg2.content,
);

console.log("\n=== Done ===");
