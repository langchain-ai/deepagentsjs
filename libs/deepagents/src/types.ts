import type {
  AgentMiddleware,
  InterruptOnConfig,
  ReactAgent as _ReactAgent,
  CreateAgentParams as _CreateAgentParams,
  AgentTypeConfig as _AgentTypeConfig,
  InferMiddlewareStates,
  ResponseFormat,
  SystemMessage,
} from "langchain";
import type {
  ClientTool,
  ServerTool,
  StructuredTool,
} from "@langchain/core/tools";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";

import type { SubAgent } from "./middleware/index.js";
import type { BackendProtocol } from "./backends/index.js";
import type { InteropZodObject } from "@langchain/core/utils/types";
import type { AnnotationRoot } from "@langchain/langgraph";
import type { CompiledSubAgent } from "./middleware/subagents.js";

/**
 * Helper type to extract middleware from a SubAgent definition
 * Handles both mutable and readonly middleware arrays
 */
export type ExtractSubAgentMiddleware<T> = T extends { middleware?: infer M }
  ? M extends readonly AgentMiddleware[]
    ? M
    : M extends AgentMiddleware[]
      ? M
      : readonly []
  : readonly [];

/**
 * Helper type to flatten and merge middleware from all subagents
 */
export type FlattenSubAgentMiddleware<
  T extends readonly (SubAgent | CompiledSubAgent)[],
> = T extends readonly []
  ? readonly []
  : T extends readonly [infer First, ...infer Rest]
    ? Rest extends readonly (SubAgent | CompiledSubAgent)[]
      ? readonly [
          ...ExtractSubAgentMiddleware<First>,
          ...FlattenSubAgentMiddleware<Rest>,
        ]
      : ExtractSubAgentMiddleware<First>
    : readonly [];

/**
 * Helper type to merge states from subagent middleware
 */
export type InferSubAgentMiddlewareStates<
  T extends readonly (SubAgent | CompiledSubAgent)[],
> = InferMiddlewareStates<FlattenSubAgentMiddleware<T>>;

/**
 * Combined state type including custom middleware and subagent middleware states
 */
export type MergedDeepAgentState<
  TMiddleware extends readonly AgentMiddleware[],
  TSubagents extends readonly (SubAgent | CompiledSubAgent)[],
> = InferMiddlewareStates<TMiddleware> &
  InferSubAgentMiddlewareStates<TSubagents>;

/**
 * Configuration parameters for creating a Deep Agent
 * Matches Python's create_deep_agent parameters
 *
 * @typeParam TResponse - The structured response type when using responseFormat
 * @typeParam ContextSchema - The context schema type
 * @typeParam TMiddleware - The middleware array type for proper type inference
 * @typeParam TSubagents - The subagents array type for extracting subagent middleware states
 * @typeParam TTools - The tools array type
 */
export interface CreateDeepAgentParams<
  TResponse extends ResponseFormat = ResponseFormat,
  ContextSchema extends AnnotationRoot<any> | InteropZodObject =
    AnnotationRoot<any>,
  TMiddleware extends readonly AgentMiddleware[] = readonly AgentMiddleware[],
  TSubagents extends readonly (SubAgent | CompiledSubAgent)[] = readonly (
    | SubAgent
    | CompiledSubAgent
  )[],
  TTools extends readonly (ClientTool | ServerTool)[] = readonly (
    | ClientTool
    | ServerTool
  )[],
> {
  /** The model to use (model name string or LanguageModelLike instance). Defaults to claude-sonnet-4-5-20250929 */
  model?: BaseLanguageModel | string;
  /** Tools the agent should have access to */
  tools?: TTools | StructuredTool[];
  /** Custom system prompt for the agent. This will be combined with the base agent prompt */
  systemPrompt?: string | SystemMessage;
  /** Custom middleware to apply after standard middleware */
  middleware?: TMiddleware;
  /** List of subagent specifications for task delegation */
  subagents?: TSubagents;
  /** Structured output response format for the agent (Zod schema or other format) */
  responseFormat?: TResponse;
  /** Optional schema for context (not persisted between invocations) */
  contextSchema?: ContextSchema;
  /** Optional checkpointer for persisting agent state between runs */
  checkpointer?: BaseCheckpointSaver | boolean;
  /** Optional store for persisting longterm memories */
  store?: BaseStore;
  /**
   * Optional backend for filesystem operations.
   * Can be either a backend instance or a factory function that creates one.
   * The factory receives a config object with state and store.
   */
  backend?:
    | BackendProtocol
    | ((config: { state: unknown; store?: BaseStore }) => BackendProtocol);
  /** Optional interrupt configuration mapping tool names to interrupt configs */
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
  /** The name of the agent */
  name?: string;
}
