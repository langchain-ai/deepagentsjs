/**
 * A2A PoC supervisor
 *
 * A DeepAgents supervisor that uses an A2A-backed researcher instead of
 * a LangSmith-backed one. The researcher runs as a standalone Python A2A
 * server (see researcher/__main__.py).
 *
 * Start the Python server first:
 *   cd examples/a2a-poc && python -m researcher
 *
 * Then deploy this supervisor:
 *   npx @langchain/langgraph-cli dev -c examples/a2a-poc/langgraph.json
 */
import "dotenv/config";
import { createDeepAgent, type AsyncSubAgent } from "deepagents";

const A2A_SERVER_URL = process.env.A2A_SERVER_URL ?? "http://localhost:10000";

const asyncSubAgents: AsyncSubAgent[] = [
  {
    name: "researcher",
    description: "A research agent that investigates any topic and produces a summary.",
    graphId: "researcher", // unused for A2A — kept for interface compatibility
    url: A2A_SERVER_URL,
    backend: "a2a",
  },
];

export const graph = createDeepAgent({
  systemPrompt:
    "You are a research supervisor that coordinates background research agents.\n\n" +
    "For general questions, answer directly. Only launch researchers when the user " +
    'explicitly asks to "research", "investigate", or "deep dive" into a topic.\n\n' +
    "When launching research:\n" +
    "1. Start the researcher with a clear, focused prompt.\n" +
    "2. Tell the user the task ID and that you'll check back when it's done.\n" +
    "3. When asked for results, call check_async_task with the exact task ID.\n" +
    "4. For status across multiple tasks, call list_async_tasks.",
  subagents: asyncSubAgents,
});
