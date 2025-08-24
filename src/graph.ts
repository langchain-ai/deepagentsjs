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
import { localLsTool, localReadFileTool, localWriteFileTool, localGlobTool, localGrepTool, strReplaceBasedEditTool } from "./local_tools.js";
import type { CreateDeepAgentParams } from "./types.js";
import type { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { DeepAgentState } from "./state.js";

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
 * Built-in tools that are always available in Deep Agents (mock filesystem)
 */
const BUILTIN_TOOLS: StructuredTool[] = [
  writeTodos,
  readFile,
  writeFile,
  editFile,
  ls,
];

/**
 * Local filesystem tools
 */
const LOCAL_BUILTIN_TOOLS: StructuredTool[] = [
  writeTodos,
  localReadFileTool,
  localWriteFileTool,
  strReplaceBasedEditTool,
  localLsTool,
  localGlobTool,
  localGrepTool,
];


/**
 * Create a Deep Agent with TypeScript types for all parameters.
 * Combines built-in tools with provided tools, creates task tool using createTaskTool(),
 * and returns createReactAgent with proper configuration.
 * Ensures exact parameter matching and behavior with Python version.
 */
export function createDeepAgent<
  StateSchema extends z.ZodObject<any, any, any, any, any>,
>(params: CreateDeepAgentParams<StateSchema> = {}) {
  const {
    tools = [],
    instructions,
    model = getDefaultModel(),
    subagents = [],
    isLocalFileSystem = false,
    postModelHook,
  } = params;

  const stateSchema = params.stateSchema
    ? DeepAgentState.extend(params.stateSchema.shape)
    : DeepAgentState;

  // Choose tools based on filesystem type
  const builtinTools = isLocalFileSystem ? LOCAL_BUILTIN_TOOLS : BUILTIN_TOOLS;
  
  // Combine built-in tools with provided tools
  const allTools: StructuredTool[] = [...builtinTools, ...tools];
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

  // Return createReactAgent with proper configuration
  return createReactAgent({
    llm: model,
    tools: allTools,
    stateSchema,
    messageModifier: finalInstructions,
    postModelHook,
  });
}
