/* eslint-disable no-console */
/**
 * Advanced Streaming Example for Deep Agents with Sub-Agents
 * 
 * This example demonstrates advanced streaming patterns:
 * - Streaming from sub-agents
 * - Real-time token streaming
 * - Progress tracking with todos
 * - File operations streaming
 */

import {
  createDeepAgent,
  type SubAgent,
  processStream,
  TokenAccumulator,
} from "../src/index.js";

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import "dotenv/config";

// Simulated research tool
const researchTool = tool(
  async ({ topic }: { topic: string }) => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return `Research findings on ${topic}: This is a complex topic with multiple aspects to consider.`;
  },
  {
    name: "research",
    description: "Conduct research on a specific topic",
    schema: z.object({
      topic: z.string().describe("Topic to research"),
    }),
  }
);

// Define sub-agents
const researchSubAgent: SubAgent = {
  name: "researcher",
  description: "Specialized agent for conducting in-depth research",
  prompt: "You are a research specialist. Conduct thorough research and provide detailed findings.",
  tools: ["research", "write_file"],
};

const writerSubAgent: SubAgent = {
  name: "writer",
  description: "Specialized agent for writing reports",
  prompt: "You are a professional writer. Create well-structured, clear reports.",
  tools: ["read_file", "write_file", "edit_file"],
};

// Create Deep Agent with sub-agents
const agent = createDeepAgent({
  tools: [researchTool],
  instructions: `You are a research coordinator. You manage research projects by:
1. Creating todo lists to track progress
2. Delegating research to the researcher sub-agent
3. Having the writer sub-agent create reports
4. Using files to store intermediate and final results`,
  
  subagents: [researchSubAgent, writerSubAgent],
});

async function demonstrateTokenStreaming() {
  console.log("=== 1. Token Streaming (Real-time LLM Output) ===\n");
  
  const accumulator = new TokenAccumulator();
  
  try {
    const stream = await agent.stream(
      {
        messages: [
          {
            role: "user",
            content: "Explain what LangGraph is in 2-3 sentences",
          },
        ],
      },
      { streamMode: "messages" }
    );
    
    for await (const [message, _metadata] of stream) {
      if (message && typeof message === 'object' && 'content' in message && message.content) {
        const token = String(message.content);
        accumulator.add(token);
        process.stdout.write(token);
      }
    }
    
    console.log(`\n\nTotal tokens streamed: ${accumulator.count()}`);
    console.log(`Full text length: ${accumulator.getText().length} characters\n`);
  } catch (_error) {
    console.log("Token streaming requires @langchain/langgraph>=0.2.20\n");
  }
}

async function demonstrateProgressTracking() {
  console.log("=== 2. Progress Tracking with Todos ===\n");
  
  const stream = await agent.stream(
    {
      messages: [
        {
          role: "user",
          content: "Research LangGraph and create a report. Track your progress with todos.",
        },
      ],
    },
    { streamMode: "updates" }
  );
  
  let step = 0;
  await processStream(stream, {
    onTodosUpdate: (todos) => {
      step++;
      console.log(`\n[Step ${step}] Todos Updated:`);
      todos.forEach((todo: any, idx: number) => {
        const icon = todo.status === 'completed' ? '✓' : 
                     todo.status === 'in_progress' ? '⋯' : '○';
        console.log(`  ${icon} ${todo.content} [${todo.status}]`);
      });
    },
    onFilesUpdate: (files) => {
      console.log(`\n[Step ${step}] Files Updated:`);
      Object.keys(files).forEach(filepath => {
        const content = files[filepath];
        const preview = content.substring(0, 60).replace(/\n/g, ' ');
        console.log(`  📄 ${filepath}: ${preview}...`);
      });
    },
  });
  
  console.log("\n✓ Research and report complete!\n");
}

async function demonstrateMultiModeStreaming() {
  console.log("=== 3. Multi-Mode Streaming (Updates + Debug) ===\n");
  
  const stream = await agent.stream(
    {
      messages: [
        {
          role: "user",
          content: "Create a quick summary file about streaming",
        },
      ],
    },
    { streamMode: ["updates", "debug"] }
  );
  
  let updateCount = 0;
  let debugCount = 0;
  
  for await (const chunk of stream) {
    const [mode, data] = chunk;
    
    if (mode === 'updates') {
      updateCount++;
      console.log(`[UPDATE #${updateCount}] Node:`, Object.keys(data)[0]);
    } else if (mode === 'debug') {
      debugCount++;
      if (data.type === 'task') {
        console.log(`[DEBUG #${debugCount}] Task started: ${data.payload?.name}`);
      } else if (data.type === 'task_result') {
        console.log(`[DEBUG #${debugCount}] Task completed: ${data.payload?.name}`);
      }
    }
  }
  
  console.log(`\nTotal: ${updateCount} updates, ${debugCount} debug events\n`);
}

async function demonstrateSubAgentStreaming() {
  console.log("=== 4. Streaming from Sub-Agents ===\n");
  
  const stream = await agent.stream(
    {
      messages: [
        {
          role: "user",
          content: "Use the researcher to investigate streaming, then have the writer create a brief report in report.md",
        },
      ],
    },
    { streamMode: "values" }
  );
  
  let nodeExecutionCount = 0;
  
  for await (const state of stream) {
    nodeExecutionCount++;
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const lastMessage = messages[messages.length - 1];
    
    if (lastMessage && typeof lastMessage === 'object' && 'content' in lastMessage) {
      const content = String(lastMessage.content || '');
      
      // Check if this is a sub-agent execution
      if (content.includes('researcher') || content.includes('writer')) {
        console.log(`[Node #${nodeExecutionCount}] Sub-agent activity detected`);
      } else if (content.length > 0) {
        const preview = content.substring(0, 80).replace(/\n/g, ' ');
        console.log(`[Node #${nodeExecutionCount}] ${preview}...`);
      }
    }
    
    // Show current state
    const fileCount = state.files ? Object.keys(state.files).length : 0;
    const todoCount = state.todos && Array.isArray(state.todos) ? state.todos.length : 0;
    console.log(`  State: ${messages.length} messages, ${fileCount} files, ${todoCount} todos`);
  }
  
  console.log(`\n✓ Sub-agent workflow complete after ${nodeExecutionCount} nodes\n`);
}

async function demonstrateCustomStreamHandler() {
  console.log("=== 5. Custom Stream Handler ===\n");
  
  class ProgressBar {
    private total: number;
    private current: number = 0;
    
    constructor(total: number) {
      this.total = total;
    }
    
    update(step: string) {
      this.current++;
      const percent = Math.round((this.current / this.total) * 100);
      const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
      console.log(`[${bar}] ${percent}% - ${step}`);
    }
  }
  
  const progress = new ProgressBar(5);
  
  const stream = await agent.stream(
    {
      messages: [
        {
          role: "user",
          content: "Create a todo list with 3 items for a streaming demo",
        },
      ],
    },
    { streamMode: "updates" }
  );
  
  await processStream(stream, {
    onChunk: async (chunk) => {
      if (chunk.type === 'updates' && chunk.data) {
        const data = chunk.data as any;
        if (data.todos) {
          progress.update('Todos created');
        } else if (data.messages) {
          progress.update('Message received');
        }
      }
    },
    onComplete: () => {
      progress.update('Complete!');
    },
  });
  
  console.log("\n");
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Deep Agents - Advanced Streaming Examples             ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  
  await demonstrateTokenStreaming();
  await demonstrateProgressTracking();
  await demonstrateMultiModeStreaming();
  await demonstrateSubAgentStreaming();
  await demonstrateCustomStreamHandler();
  
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   All streaming examples completed successfully!         ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { agent, researchTool, researchSubAgent, writerSubAgent };