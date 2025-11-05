import "dotenv/config";
import { z } from "zod";
import { tool } from "langchain";
import { TavilySearch } from "@langchain/tavily";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver, InMemoryStore } from "@langchain/langgraph-checkpoint";
import { v4 as uuidv4 } from "uuid";

import {
  createDeepAgent,
  CompositeBackend,
  StateBackend,
  StoreBackend,
} from "../../src/index.js";

const internetSearch = tool(
  async ({ query, maxResults = 5 }: { query: string; maxResults?: number }) => {
    const tavilySearch = new TavilySearch({
      maxResults,
      tavilyApiKey: process.env.TAVILY_API_KEY,
    });
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const tavilyResponse = await tavilySearch._call({ query });
    return tavilyResponse;
  },
  {
    name: "internet_search",
    description: "Run a web search",
    schema: z.object({
      query: z.string().describe("The search query"),
      maxResults: z
        .number()
        .optional()
        .default(5)
        .describe("Maximum number of results to return"),
    }),
  },
);

const systemPrompt = `You are a research assistant with both temporary and persistent storage.

## Storage Types

1. **Temporary files** (root directory): Stored in state, lost after conversation
   - Use for: scratch notes, intermediate work
   - Example: \`/research_notes.txt\`, \`/draft.md\`

2. **Persistent memory** (\`/memories/\` directory): Stored in database, kept forever
   - Use for: final reports, important findingss
   - Example: \`/memories/report_2025_ai_trends.md\`

## Workflow

1. Write your research question to \`/research_question.txt\` (temporary)
2. Gather information using the internet_search tool
3. Write your findings to \`/research_notes.txt\` (temporary) as you discover them
4. Once you have enough information, write a final summary to \`/summary.md\` (temporary)
5. **IMPORTANT**: Save the final report to \`/memories/report_TOPIC.md\` (persistent)

## Memory Guidelines

Always save completed reports to \`/memories/\` so they can be referenced in future conversations.
Use descriptive filenames like:
- \`/memories/report_ai_agents_2025.md\`
- \`/memories/findings_quantum_computing.md\`
- \`/memories/summary_market_analysis.md\``;

export const agent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    temperature: 0,
  }),
  tools: [internetSearch],
  systemPrompt,
  checkpointer: new MemorySaver(),
  store: new InMemoryStore(),
  backend: (config) =>
    new CompositeBackend(new StateBackend(config), {
      "/memories/": new StoreBackend(config),
    }),
});

async function main() {
  const threadId = uuidv4();

  await agent.invoke(
    {
      messages: [
        new HumanMessage("Research the latest trends in AI agents for 2025"),
      ],
    },
    {
      recursionLimit: 50,
      configurable: { thread_id: threadId },
    },
  );

  const threadId2 = uuidv4();
  await agent.invoke(
    {
      messages: [
        new HumanMessage(
          "Do you have any info on the latest trends in AI agents for 2025?",
        ),
      ],
    },
    {
      recursionLimit: 50,
      configurable: { thread_id: threadId2 },
    },
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
