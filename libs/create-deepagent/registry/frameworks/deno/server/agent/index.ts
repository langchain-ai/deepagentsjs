import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";

import { stripReasoningReplay } from "./middleware.ts";
import { calculator, searchWeb } from "./tools.ts";

const coordinatorModel = new ChatOpenAI({
  model: "gpt-5.4-mini",
  reasoning: { effort: "low", summary: "auto" },
});

const subagentModel = new ChatOpenAI({ model: "gpt-5.4-mini" });

/**
 * In-memory checkpointer — the single source of truth for threads.
 *
 * Exported so the server can enumerate threads (via `checkpointer.storage`) and
 * delete them (`checkpointer.deleteThread`). It is process-local and volatile:
 * restarting the server clears every thread.
 */
export const checkpointer = new MemorySaver();

export const agent = createDeepAgent({
  model: coordinatorModel,
  middleware: [stripReasoningReplay],
  checkpointer,
  subagents: [
    {
      name: "researcher",
      description:
        "Researches a topic using the search_web tool and reports concise findings.",
      tools: [searchWeb],
      model: subagentModel,
      systemPrompt:
        "You are the researcher subagent. Use the search_web tool to look up " +
        "the requested topic, then summarize the findings in two or three " +
        "sentences. Always call search_web at least once before answering.",
    },
    {
      name: "math-whiz",
      description:
        "Performs calculations using the calculator tool and explains the result.",
      tools: [calculator],
      model: subagentModel,
      systemPrompt:
        "You are the math-whiz subagent. Use the calculator tool to evaluate " +
        "the requested expression, then state the result clearly. Always call " +
        "the calculator tool before answering.",
    },
  ],
  systemPrompt:
    "You are a helpful coordinator. When a request involves looking something " +
    "up, delegate it to the `researcher` subagent. When it involves math, " +
    "delegate it to the `math-whiz` subagent. You may run both subagents for a " +
    "single request. After the subagents respond, combine their results into a " +
    "short, clearly labeled final answer.",
});

export type Agent = typeof agent;
