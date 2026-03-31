/**
 * Supervisor — Async Subagent Example
 *
 * An interactive REPL that demonstrates the five async subagent operations
 * against the Hono server in server.ts.
 *
 * The supervisor delegates research tasks to the server-hosted researcher
 * via Agent Protocol. Tasks run in the background — the supervisor returns
 * a task ID immediately and lets you check in when you're ready.
 *
 * Run (after starting server.ts in another terminal):
 *   ANTHROPIC_API_KEY=... tsx examples/async-subagent-server/supervisor.ts
 *
 * Try these prompts:
 *   > research the latest developments in quantum computing
 *   > check status of <task-id>
 *   > update <task-id> to focus on commercial applications only
 *   > cancel <task-id>
 *   > list all tasks
 */
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });
import * as readline from "readline";
import { createDeepAgent, type AsyncSubAgent } from "deepagents";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { v4 as uuidv4 } from "uuid";

const RESEARCHER_URL = process.env.RESEARCHER_URL || "http://localhost:2024";

// ── Agent setup ───────────────────────────────────────────────────────────────

const asyncSubAgents: AsyncSubAgent[] = [
  {
    name: "researcher",
    description:
      "A research agent that investigates any topic using web search. " +
      "Runs in the background and returns a detailed summary.",
    graphId: "researcher",
    url: RESEARCHER_URL,
  },
];

const checkpointer = new MemorySaver();
const threadId = uuidv4();

const supervisor = createDeepAgent({
  checkpointer,
  systemPrompt:
    "You are a research supervisor coordinating a background researcher agent.\n\n" +
    "For general questions, answer directly — do NOT launch a researcher.\n\n" +
    'Only launch the researcher when the user says "research", "investigate", "look into", or "find out".\n\n' +
    "START: When the user asks to research something:\n" +
    '  1. Call start_async_task with agentName "researcher" and the topic.\n' +
    "  2. Report the taskId and stop. Do NOT immediately check status.\n\n" +
    "CHECK: When the user asks for status or results:\n" +
    "  1. Call check_async_task with the exact taskId.\n" +
    "  2. Report what the tool returns. If still running, say so and stop.\n\n" +
    "UPDATE: When the user asks to change what the researcher is working on:\n" +
    "  1. Call update_async_task with the taskId and new instructions.\n" +
    "  2. Confirm the update.\n\n" +
    "CANCEL: When the user asks to cancel a task:\n" +
    "  1. Call cancel_async_task with the exact taskId.\n" +
    "  2. Confirm the cancellation.\n\n" +
    "LIST: When the user asks to list tasks or check all statuses:\n" +
    "  1. Call list_async_tasks.\n" +
    "  2. Present the live statuses.\n\n" +
    "Rules:\n" +
    "- Never report a stale status from memory. Always call a tool.\n" +
    "- Never poll in a loop. One tool call per user request.\n" +
    "- Always show the full taskId — never truncate it.",
  subagents: asyncSubAgents,
});

// ── REPL ──────────────────────────────────────────────────────────────────────

async function chat(userInput: string): Promise<void> {
  const result = await supervisor.invoke(
    { messages: [new HumanMessage(userInput)] },
    { configurable: { thread_id: threadId } },
  );

  const last = result.messages[result.messages.length - 1];
  const content = last?.content;
  console.log(
    "\n" +
      (typeof content === "string" ? content : JSON.stringify(content, null, 2)) +
      "\n",
  );
}

async function main() {
  console.log(`Supervisor connected to researcher at ${RESEARCHER_URL}`);
  console.log(`Type a message and press Enter. Ctrl+C to exit.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    try {
      await chat(input);
    } catch (e) {
      console.error("Error:", e);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nGoodbye.");
    process.exit(0);
  });
}

main();
