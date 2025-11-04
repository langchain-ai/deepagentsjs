import "dotenv/config";
import { z } from "zod";
import { tool } from "langchain";
import { TavilySearch } from "@langchain/tavily";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver, InMemoryStore } from "@langchain/langgraph-checkpoint";

import { createDeepAgent, StoreBackend } from "../../src/index.js";
import { v4 as uuidv4 } from "uuid";

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

const systemPrompt = `You are a research assistant with persistent cross-conversation storage.

Your files persist across all conversations and threads using the store.

## Workflow

1. Write your research question to \`research_question.txt\`
2. Gather information using the internet_search tool
3. Write your findings to \`research_notes.txt\` as you discover them
4. Once you have enough information, write a final summary to \`summary.md\`

## Important

All files you create are shared across ALL conversations. This means you can reference
previous research in new conversations.`;

export const agent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    temperature: 0,
  }),
  tools: [internetSearch],
  systemPrompt,
  checkpointer: new MemorySaver(),
  store: new InMemoryStore(),
  backend: (config) => new StoreBackend(config),
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

  console.log("Research Complete!");
  console.log(
    "\nNote: Files are stored in the persistent store and accessible across all threads",
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
