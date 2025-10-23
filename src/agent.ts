/**
 * Main createDeepAgent function for Deep Agents
 *
 * Main entry point for creating deep agents with TypeScript types for all parameters:
 * tools, instructions, model, subagents, and stateSchema. Combines built-in tools with
 * provided tools, creates task tool using createTaskTool(), and returns createReactAgent
 * with proper configuration. Ensures exact parameter matching and behavior with Python version.
 */

import { createAgent, summarizationMiddleware } from "langchain";
import {
  humanInTheLoopMiddleware,
  anthropicPromptCachingMiddleware,
  ResponseFormatUndefined,
  todoListMiddleware,
  AgentMiddleware,
  ReactAgent,
} from "langchain";

import type { CreateDeepAgentParams } from "./types.js";
import { subAgentMiddleware } from "./middleware/subAgent.js";
import { fsMiddleware } from "./middleware/fs.js";
import { patchToolCallsMiddleware } from "./middleware/patchToolCalls.js";
import { BaseLanguageModel } from "@langchain/core/language_models/base";

/**
 * This needs to be exported to types can be inferred properly
 */
export type { ResponseFormatUndefined, AgentMiddleware, ReactAgent };

/**
 * Base prompt that provides instructions about available tools
 */
const BASE_PROMPT = `You have access to a number of standard tools

## \`write_todos\`

You have access to the \`write_todos\` tools to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.
These tools are also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable.

It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.
## \`task\`

- When doing web search, prefer to use the \`task\` tool in order to reduce context usage.`;

/**
 * Create a Deep Agent with TypeScript types for all parameters.
 * Combines built-in tools with provided tools, creates task tool using createTaskTool(),
 * and returns createReactAgent with proper configuration.
 * Ensures exact parameter matching and behavior with Python version.
 */
export function createDeepAgent(
  params: CreateDeepAgentParams = {} as CreateDeepAgentParams
): ReactAgent {
  const {
    subagents = [],
    tools = [],
    model,
    interruptConfig = {},
    instructions,
  } = params;

  // Combine instructions with base prompt like Python implementation
  const finalInstructions = instructions
    ? instructions + BASE_PROMPT
    : BASE_PROMPT;

  const deepAgentMiddleware = [
    todoListMiddleware,
    fsMiddleware,
    subAgentMiddleware({
      defaultModel: model,
      defaultTools: tools,
      subagents,
      defaultInterruptOn: interruptConfig,
    }),
    summarizationMiddleware({
      model: model as BaseLanguageModel,
      maxTokensBeforeSummary: 170_000,
      messagesToKeep: 6,
    }),
    anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    humanInTheLoopMiddleware({ interruptOn: interruptConfig }),
    patchToolCallsMiddleware,
  ] as const;

  return createAgent({
    model,
    systemPrompt: finalInstructions,
    tools,
    middleware: deepAgentMiddleware,
  });
}
