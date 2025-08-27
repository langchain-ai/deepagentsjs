/**
 * Main createDeepAgent function for Deep Agents
 *
 * Main entry point for creating deep agents with TypeScript types for all parameters:
 * tools, instructions, model, subagents, and stateSchema. Combines built-in tools with
 * provided tools, creates task tool using createTaskTool(), and returns createReactAgent
 * with proper configuration. Ensures exact parameter matching and behavior with Python version.
 */

// import "@langchain/anthropic/zod";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createTaskTool } from "./subAgent.js";
import { getDefaultModel } from "./model.js";
import { writeTodos, readFile, writeFile, editFile, ls } from "./tools.js";
import { InteropZodObject } from "@langchain/core/utils/types";
import type {
  PostModelHook,
  AnyAnnotationRoot,
  CreateDeepAgentParams,
} from "./types.js";
import type { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { DeepAgentState } from "./state.js";
import { createInterruptHook } from "./interrupt.js";

/**
 * Base prompt that provides instructions about available tools
 * Ported from Python implementation to ensure consistent behavior
 */
const BASE_PROMPT = `You have access to a number of standard tools

## \`write_todos\`

You have access to the \`write_todos\` tools to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.
These tools are also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable.

It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.
## \`task\`

- When doing web search, prefer to use the \`task\` tool in order to reduce context usage.`;

/**
 * Built-in tools that are always available in Deep Agents
 */
const BUILTIN_TOOLS: StructuredTool[] = [
  writeTodos,
  readFile,
  writeFile,
  editFile,
  ls,
];

/**
 * Create a Deep Agent with TypeScript types for all parameters.
 * Combines built-in tools with provided tools, creates task tool using createTaskTool(),
 * and returns createReactAgent with proper configuration.
 * Ensures exact parameter matching and behavior with Python version.
 *
 */
export function createDeepAgent<
  StateSchema extends z.ZodObject<any, any, any, any, any>,
  ContextSchema extends
    | AnyAnnotationRoot
    | InteropZodObject = AnyAnnotationRoot,
>(params: CreateDeepAgentParams<StateSchema, ContextSchema> = {}) {
  const {
    tools = [],
    instructions,
    model = getDefaultModel(),
    subagents = [],
    postModelHook,
    contextSchema,
    interruptConfig = {},
    builtinTools,
  } = params;

  const stateSchema = params.stateSchema
    ? DeepAgentState.extend(params.stateSchema.shape)
    : DeepAgentState;

  // Filter built-in tools if builtinTools parameter is provided
  const selectedBuiltinTools = builtinTools
    ? BUILTIN_TOOLS.filter((tool) =>
        builtinTools.some((bt) => bt === tool.name),
      )
    : BUILTIN_TOOLS;

  // Combine built-in tools with provided tools
  const allTools: StructuredTool[] = [...selectedBuiltinTools, ...tools];
  // Create task tool using createTaskTool() if subagents are provided
  if (subagents.length > 0) {
    // Create tools map for task tool creation
    const toolsMap: Record<string, StructuredTool> = {};
    for (const tool of allTools) {
      if (tool.name) {
        toolsMap[tool.name] = tool;
      }
    }

    const taskTool = createTaskTool({
      subagents,
      tools: toolsMap,
      model,
      stateSchema,
    });
    allTools.push(taskTool);
  }

  // Combine instructions with base prompt like Python implementation
  const finalInstructions = instructions
    ? instructions + BASE_PROMPT
    : BASE_PROMPT;

  // Should never be the case that both are specified
  if (postModelHook && Object.keys(interruptConfig).length > 0) {
    throw new Error(
      "Cannot specify both postModelHook and interruptConfig together. " +
        "Use either interruptConfig for tool interrupts or postModelHook for custom post-processing.",
    );
  }

  let selectedPostModelHook: PostModelHook | undefined;
  if (postModelHook !== undefined) {
    selectedPostModelHook = postModelHook;
  } else if (Object.keys(interruptConfig).length > 0) {
    selectedPostModelHook = createInterruptHook(interruptConfig);
  } else {
    selectedPostModelHook = undefined;
  }

  // Return createReactAgent with proper configuration
  return createReactAgent<
    typeof stateSchema,
    Record<string, any>,
    ContextSchema
  >({
    llm: model,
    tools: allTools,
    stateSchema,
    messageModifier: finalInstructions,
    contextSchema,
    postModelHook: selectedPostModelHook,
  });
}
