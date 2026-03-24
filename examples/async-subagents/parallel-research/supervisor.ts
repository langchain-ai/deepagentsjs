/**
 * Supervisor agent — orchestrates parallel research subagents
 *
 * Launches 3 async researcher subagents in parallel, each investigating
 * a different angle of the user's research question.
 *
 * Deploy with:
 *   npx @langchain/langgraph-cli dev -c examples/async-subagents/parallel-research/langgraph.json
 */
import "dotenv/config";
import { createDeepAgent, type AsyncSubAgent } from "deepagents";

const LANGGRAPH_URL = process.env.LANGGRAPH_URL ?? "http://localhost:2024";

const asyncSubAgents: AsyncSubAgent[] = [
  {
    name: "researcher",
    description:
      "A general-purpose research agent that can investigate any topic.",
    graphId: "researcher",
    url: LANGGRAPH_URL,
  },
];

export const graph = createDeepAgent({
  systemPrompt:
    "You are a research supervisor that can coordinate parallel background research agents.\n\n" +
    "For general questions and conversation, just answer directly from your knowledge — do NOT launch researchers.\n\n" +
    'Only launch researchers when the user uses explicit trigger words like: "research", "investigate", "deep dive", "look into", "find out", "analyze".\n' +
    "If the user is simply asking a question — even about a complex topic — answer it directly.\n" +
    "When in doubt, answer directly. Never launch a researcher unless the user clearly wants background research.\n\n" +
    "When the user explicitly requests research:\n" +
    "1. Decide how many researchers to launch and what angle each should take.\n" +
    "   Use your judgment — some questions need one researcher, others benefit from several in parallel.\n" +
    '2. Launch each researcher using start_async_task with agentName: "researcher".\n' +
    "   Give each a tailored description prompt focused on their specific angle.\n" +
    "3. Tell the user which researchers are working and that you'll share findings as each one finishes.\n" +
    "   Never report task statuses from memory — always call list_async_tasks to get live statuses.\n\n" +
    "When the user asks for results for a specific task (message contains 'task_id: <id>'):\n" +
    "1. Always call check_async_task with that exact task_id — never answer from memory or prior results.\n" +
    "2. Present only what the tool returns. If the task was updated, the tool will return the latest result.\n\n" +
    "When the user asks to cancel a task (message contains 'Cancel task_id: <id>'):\n" +
    "1. Use cancel_async_task with that exact task_id.\n" +
    "2. Confirm the cancellation to the user.\n\n" +
    "When the user asks for status or results generally, or after any update:\n" +
    "1. Always call list_async_tasks first to get live statuses — never guess from memory.\n" +
    "2. Use check_async_task for any completed ones and present their findings.\n" +
    "3. If some are still running, let the user know.",
  subagents: asyncSubAgents,
});
