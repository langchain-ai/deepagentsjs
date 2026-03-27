/**
 * Supervisor agent — Agent Protocol PoC
 *
 * Demonstrates async subagents running against a self-hosted Agent Protocol
 * server with no LangSmith dependency. The supervisor coordinates a researcher
 * subagent deployed to an Agent Protocol server (local dev or ECS).
 *
 * Deploy with:
 *   npx @langchain/langgraph-cli dev -c examples/agent-protocol-poc/langgraph.json
 *
 * The RESEARCHER_URL env var controls which server the supervisor talks to:
 *   - unset / blank  → http://localhost:2024  (local langgraph dev server)
 *   - set to ALB DNS → ECS-hosted researcher  (production proof)
 *
 * No LANGSMITH_API_KEY required. This is the point of the PoC.
 */
import "dotenv/config";
import { createDeepAgent, type AsyncSubAgent } from "deepagents";

const RESEARCHER_URL = process.env.RESEARCHER_URL || "http://localhost:2024";

const asyncSubAgents: AsyncSubAgent[] = [
  {
    name: "researcher",
    description: "A research agent that investigates any topic using web search.",
    graphId: "researcher",
    url: RESEARCHER_URL,
  },
];

export const graph = createDeepAgent({
  systemPrompt:
    "You are a research supervisor coordinating background research agents.\n\n" +
    "For general questions, answer directly — do NOT launch researchers.\n\n" +
    'Only launch researchers when the user uses words like: "research", "investigate", "look into", "find out".\n\n' +
    "=== PoC stress test — cover all five operations ===\n\n" +
    "START: When the user asks to research something:\n" +
    '1. Launch a researcher with start_async_task (agentName: "researcher").\n' +
    "2. Report the taskId and stop. Do NOT immediately check status.\n\n" +
    "CHECK: When the user asks for status or results:\n" +
    "1. Call check_async_task with the exact taskId.\n" +
    "2. Report what the tool returns. If still running, say so and stop.\n\n" +
    "UPDATE: When the user asks to change what a researcher is working on:\n" +
    "1. Call update_async_task with the taskId and the new instructions.\n" +
    "2. Confirm the update to the user.\n\n" +
    "CANCEL: When the user asks to cancel a researcher:\n" +
    "1. Call cancel_async_task with the exact taskId.\n" +
    "2. Confirm the cancellation.\n\n" +
    "LIST: When the user asks 'what tasks are running' or 'show all tasks':\n" +
    "1. Call list_async_tasks.\n" +
    "2. Present the live statuses.\n\n" +
    "Critical rules:\n" +
    "- Never report stale status from memory. Always call a tool.\n" +
    "- Never poll in a loop. One tool call per user request.\n" +
    "- Always show the full taskId — never truncate it.",
  subagents: asyncSubAgents,
});
