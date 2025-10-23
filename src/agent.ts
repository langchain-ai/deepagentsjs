/**
 * Main createDeepAgent function for Deep Agents
 *
 * Main entry point for creating deep agents with middleware-based architecture.
 * Matches Python's create_deep_agent function with full feature parity.
 */

import { createAgent } from "langchain";
import {
  humanInTheLoopMiddleware,
  anthropicPromptCachingMiddleware,
  todoListMiddleware,
  summarizationMiddleware,
  type AgentMiddleware,
  type ReactAgent,
  type InterruptOnConfig,
} from "langchain";
import type { StructuredTool } from "@langchain/core/tools";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";

import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  type SubAgent,
} from "./middleware/index.js";

/**
 * Configuration parameters for creating a Deep Agent
 * Matches Python's create_deep_agent parameters
 */
export interface CreateDeepAgentParams<StateSchema = any, ContextSchema = any> {
  /** The model to use (model name string or LanguageModelLike instance). Defaults to claude-sonnet-4-5-20250929 */
  model?: LanguageModelLike | string;
  /** Tools the agent should have access to */
  tools?: StructuredTool[];
  /** Custom system prompt for the agent. This will be combined with the base agent prompt */
  systemPrompt?: string;
  /** Custom middleware to apply after standard middleware */
  middleware?: AgentMiddleware[];
  /** List of subagent specifications for task delegation */
  subagents?: SubAgent[];
  /** Structured output response format for the agent */
  responseFormat?: any; // ResponseFormat type is complex, using any for now
  /** Optional schema for custom agent state */
  stateSchema?: StateSchema;
  /** Optional schema for context (not persisted between invocations) */
  contextSchema?: ContextSchema;
  /** Optional checkpointer for persisting agent state between runs */
  checkpointer?: BaseCheckpointSaver | boolean;
  /** Optional store for persisting longterm memories */
  store?: BaseStore;
  /** Whether to use longterm memory - requires a store to be provided */
  useLongtermMemory?: boolean;
  /** Optional interrupt configuration mapping tool names to interrupt configs */
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
  /** The name of the agent */
  name?: string;
}

/**
 * Base prompt that provides instructions about available tools
 * Ported from Python implementation to ensure consistent behavior
 */
const BASE_PROMPT = `In order to complete the objective that the user asks of you, you have access to a number of standard tools.`;

/**
 * Create a Deep Agent with middleware-based architecture.
 *
 * Matches Python's create_deep_agent function, using middleware for all features:
 * - Todo management (todoListMiddleware)
 * - Filesystem tools (createFilesystemMiddleware)
 * - Subagent delegation (createSubAgentMiddleware)
 * - Conversation summarization (summarizationMiddleware)
 * - Prompt caching (anthropicPromptCachingMiddleware)
 * - Tool call patching (createPatchToolCallsMiddleware)
 * - Human-in-the-loop (humanInTheLoopMiddleware) - optional
 *
 * @param params Configuration parameters for the agent
 * @returns ReactAgent instance ready for invocation
 */
export function createDeepAgent<StateSchema = any, ContextSchema = any>(
  params: CreateDeepAgentParams<
    StateSchema,
    ContextSchema
  > = {} as CreateDeepAgentParams<StateSchema, ContextSchema>
): ReactAgent<any, any, any, any> {
  const {
    model = "claude-sonnet-4-5-20250929", // Match Python default
    tools = [],
    systemPrompt,
    middleware: customMiddleware = [],
    subagents = [],
    responseFormat,
    stateSchema,
    contextSchema,
    checkpointer,
    store,
    useLongtermMemory = false,
    interruptOn,
    name,
  } = params;

  // Combine system prompt with base prompt like Python implementation
  const finalSystemPrompt = systemPrompt
    ? `${systemPrompt}\n\n${BASE_PROMPT}`
    : BASE_PROMPT;

  // Build default middleware stack for subagents
  // Subagents get: todo + fs + summarization + caching + patch
  const defaultSubagentMiddleware: AgentMiddleware[] = [
    todoListMiddleware(),
    createFilesystemMiddleware({
      longTermMemory: useLongtermMemory,
      store,
    }),
    summarizationMiddleware({
      model: model as any,
    }),
    anthropicPromptCachingMiddleware({
      unsupportedModelBehavior: "ignore",
    }),
    createPatchToolCallsMiddleware(),
  ];

  // Build main middleware stack matching Python's order:
  // 1. Todo list middleware
  // 2. Filesystem middleware
  // 3. Subagent middleware
  // 4. Summarization middleware
  // 5. Anthropic prompt caching middleware
  // 6. Patch tool calls middleware
  // 7. Human-in-the-loop middleware (if configured)
  // 8. Custom middleware
  const middleware: AgentMiddleware[] = [
    todoListMiddleware(),
    createFilesystemMiddleware({
      longTermMemory: useLongtermMemory,
      store,
    }),
    createSubAgentMiddleware({
      defaultModel: model,
      defaultTools: tools as any,
      defaultMiddleware: defaultSubagentMiddleware,
      defaultInterruptOn: interruptOn || null,
      subagents,
      generalPurposeAgent: true,
    }),
    summarizationMiddleware({
      model: model as any,
    }),
    anthropicPromptCachingMiddleware({
      unsupportedModelBehavior: "ignore",
    }),
    createPatchToolCallsMiddleware(),
  ];

  // Add human-in-the-loop middleware if interrupt config provided
  if (interruptOn) {
    middleware.push(
      humanInTheLoopMiddleware({
        interruptOn,
      })
    );
  }

  // Add custom middleware last (after all built-in middleware)
  middleware.push(...customMiddleware);

  // Create and return agent with all parameters
  // Note: Python sets recursion_limit to 1000 via .with_config()
  // In TypeScript, recursionLimit should be passed to invoke/stream methods via config parameter
  return createAgent({
    model,
    systemPrompt: finalSystemPrompt,
    tools: tools as any,
    middleware: middleware as any,
    responseFormat,
    stateSchema: stateSchema as any,
    contextSchema: contextSchema as any,
    checkpointer,
    store,
    name,
  } as any);
}
