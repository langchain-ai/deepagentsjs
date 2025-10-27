/* eslint-disable no-console */
/**
 * Basic Streaming Example for Deep Agents
 *
 * This example demonstrates the basic streaming capabilities of Deep Agents.
 * Shows how to stream state updates, LLM tokens, and track todos/files.
 */

import { createDeepAgent, StreamingPresets, processStream } from "../src/index.js";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import "dotenv/config";

// Simple search tool
const searchTool = tool(
  async ({ query }: { query: string }) => {
    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 500));
    return `Search results for "${query}": Found relevant information about ${query}.`;
  },
  {
    name: "search",
    description: "Search for information on the web",
    schema: z.object({
      query: z.string().describe("Search query"),
    }),
  }
);

// Create Deep Agent
const agent = createDeepAgent({
  tools: [searchTool],
  instructions: "You are a helpful research assistant. Use tools when needed and track your progress with todos.",

  
});

async function main() {
  console.log("=== Basic Streaming Example ===\n");
  
  // Example 1: Stream with updates mode
  console.log("1. Streaming Updates:\n");
  const stream1 = await agent.stream(
    {
      messages: [{ role: "user", content: "Search for information about LangGraph and create a todo list" }],
    },
    { streamMode: "updates" }
  );
  
  for await (const update of stream1) {
    for (const [node, values] of Object.entries(update)) {
      console.log(`Node: ${node}`);
      if (values.todos) {
        console.log(`Todos updated:`, values.todos);
      }
      if (values.messages && Array.isArray(values.messages) && values.messages.length > 0) {
        const lastMsg = values.messages[values.messages.length - 1];
        if (lastMsg && typeof lastMsg === 'object' && 'content' in lastMsg && lastMsg.content) {
          const content = String(lastMsg.content);
          console.log(`Message: ${content.substring(0, 100)}...`);
        }
      }
      console.log("---");
    }
  }
  
  console.log("\n2. Streaming Full State:\n");
  const stream2 = await agent.stream(
    {
      messages: [{ role: "user", content: "What did we just discuss?" }],
    },
    StreamingPresets.FULL_STATE
  );
  
  for await (const state of stream2) {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    console.log(`State has ${messages.length} messages`);
    if (state.todos && Array.isArray(state.todos)) {
      console.log(`Current todos:`, state.todos.map((t: any) => `${t.status}: ${t.content}`));
    }
  }
  
  console.log("\n3. Streaming with Token Streaming (requires @langchain/langgraph>=0.2.20):\n");
  try {
    const stream3 = await agent.stream(
      {
        messages: [{ role: "user", content: "Explain LangGraph briefly" }],
      },
      { streamMode: "messages" }
    );
    
    let tokenCount = 0;
    for await (const [message, _metadata] of stream3) {
      if (message.content) {
        process.stdout.write(message.content.toString());
        tokenCount++;
      }
    }
    console.log(`\n\nStreamed ${tokenCount} tokens`);
  } catch (_error) {
    console.log("Token streaming not available (requires @langchain/langgraph>=0.2.20)");
  }
  
  console.log("\n4. Multiple Stream Modes:\n");
  const stream4 = await agent.stream(
    {
      messages: [{ role: "user", content: "Create a todo for testing streaming" }],
    },
    { streamMode: ["updates", "debug"] }
  );
  
  for await (const chunk of stream4) {
    const [mode, data] = chunk;
    console.log(`[${mode}]:`, typeof data === 'object' ? Object.keys(data) : data);
  }
  
  console.log("\n5. Using processStream helper:\n");
  const stream5 = await agent.stream(
    {
      messages: [{ role: "user", content: "Write a summary to summary.md" }],
    },
    { streamMode: "updates" }
  );
  
  await processStream(stream5, {
    onTodosUpdate: (todos) => {
      console.log("✓ Todos updated:", todos.length, "items");
    },
    onFilesUpdate: (files) => {
      console.log("✓ Files updated:", Object.keys(files));
    },
    onComplete: (finalState) => {
      console.log("✓ Streaming complete!");
      const messages = Array.isArray(finalState.messages) ? finalState.messages : [];
      console.log("Final message count:", messages.length);
    },
  });
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { agent, searchTool };