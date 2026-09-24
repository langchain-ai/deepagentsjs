import "dotenv/config";
import { ChatAnthropic } from "@langchain/anthropic";
import { createDeepAgent } from "deepagents";
import { youcomSearch } from "./tools/youcom-search.js";

/**
 * Simple You.com search agent example
 *
 * This example demonstrates how to use the You.com search tool
 * with Deep Agents for web research capabilities.
 */

const searchInstructions = `You are a helpful research assistant with web search capabilities.

You have access to the You.com search tool which provides high-quality web search results.
Use it to find current information on topics the user asks about.

When providing search results:
1. Summarize the key findings
2. Include relevant quotes and facts
3. Cite sources with URLs when possible
4. Provide balanced, comprehensive information

The You.com search tool works with or without an API key:
- With YDC_API_KEY: Enhanced features and higher rate limits
- Without API key: Basic search functionality in keyless mode`;

// Create the agent with You.com search
export const youcomAgent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    temperature: 0,
  }),
  tools: [youcomSearch],
  systemPrompt: searchInstructions,
});

// Example usage (uncomment to test)
// async function main() {
//   const result = await youcomAgent.invoke({
//     messages: [new HumanMessage("What are the latest developments in AI agents?")],
//   });
//
//   console.log("Agent response:", result.messages[result.messages.length - 1].content);
// }
//
// if (import.meta.url === `file://${process.argv[1]}`) {
//   main().catch(console.error);
// }
