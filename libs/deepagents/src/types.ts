import type {
  AgentMiddleware,
  InterruptOnConfig,
  ReactAgent,
  CreateAgentParams as _CreateAgentParams,
  AgentTypeConfig,
  InferMiddlewareStates,
  ResponseFormat,
  SystemMessage,
  ResponseFormatUndefined,
  ToolStrategy,
  ProviderStrategy,
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

// LangChain uses AnyAnnotationRoot internally but doesn't export it
// We use AnnotationRoot<any> as a compatible equivalent
type AnyAnnotationRoot = AnnotationRoot<any>;

// TODO: import TypedToolStrategy from "langchain" once exported from the top-level entry point
// (currently only available via "langchain/dist/agents/responses.js")
interface TypedToolStrategy<T = unknown> extends Array<ToolStrategy<any>> {
  _schemaType?: T;
}

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
 * Union of all response format types accepted by `createDeepAgent`.
 *
 * Matches the formats supported by LangChain's `createAgent`:
 * - `ToolStrategy<T>` — from `ToolStrategy.fromSchema(schema)`
 * - `ProviderStrategy<T>` — from `providerStrategy(schema)`
 * - `TypedToolStrategy<T>` — from `toolStrategy(schema)`
 * - `ResponseFormat` — the base union of the above single-strategy types
 */
export type SupportedResponseFormat = ResponseFormat | TypedToolStrategy<any>;

/**
 * Utility type to extract the parsed response type from a ResponseFormat strategy.
 *
 * Maps `ToolStrategy<T>`, `ProviderStrategy<T>`, and `TypedToolStrategy<T>` to `T`
 * (the parsed output type), so that `structuredResponse` is correctly typed as the
 * schema's inferred type rather than the strategy wrapper.
 *
 * When no `responseFormat` is provided (i.e. `T` defaults to the full
 * `SupportedResponseFormat` union), this resolves to `ResponseFormatUndefined` so
 * that `structuredResponse` is excluded from the agent's output state.
 *
 * @example
 * ```typescript
 * type T1 = InferStructuredResponse<ToolStrategy<{ city: string }>>; // { city: string }
 * type T2 = InferStructuredResponse<ProviderStrategy<{ answer: string }>>; // { answer: string }
 * type T3 = InferStructuredResponse<TypedToolStrategy<{ city: string }>>; // { city: string }
 * type T4 = InferStructuredResponse<SupportedResponseFormat>; // ResponseFormatUndefined (default/unset)
 * ```
 */
export type InferStructuredResponse<T extends SupportedResponseFormat> =
  SupportedResponseFormat extends T
    ? ResponseFormatUndefined
    : T extends TypedToolStrategy<infer U>
      ? U
      : T extends ToolStrategy<infer U>
        ? U
        : T extends ProviderStrategy<infer U>
          ? U
          : ResponseFormatUndefined;

/**
 * Type bag that extends AgentTypeConfig with subagent type information.
 *
 * This interface bundles all the generic type parameters used throughout the deep agent system
 * including subagent types for type-safe streaming and delegation.
 *
 * @typeParam TResponse - The structured response type when using `responseFormat`.
 * @typeParam TState - The custom state schema type.
 * @typeParam TContext - The context schema type.
 * @typeParam TMiddleware - The middleware array type.
 * @typeParam TTools - The combined tools type.
 * @typeParam TSubagents - The subagents array type for type-safe streaming.
 *
 * @example
 * ```typescript
 * const agent = createDeepAgent({
 *   middleware: [ResearchMiddleware],
 *   subagents: [
 *     { name: "researcher", description: "...", middleware: [CounterMiddleware] }
 *   ] as const,
 * });
 *
 * // Type inference for streaming
 * type Types = InferDeepAgentType<typeof agent, "Subagents">;
 * ```
 */
export interface DeepAgentTypeConfig<
  TResponse extends Record<string, any> | ResponseFormatUndefined =
    | Record<string, any>
    | ResponseFormatUndefined,
  TState extends AnyAnnotationRoot | InteropZodObject | undefined =
    | AnyAnnotationRoot
    | InteropZodObject
    | undefined,
  TContext extends AnyAnnotationRoot | InteropZodObject =
    | AnyAnnotationRoot
    | InteropZodObject,
  TMiddleware extends readonly AgentMiddleware[] = readonly AgentMiddleware[],
  TTools extends readonly (ClientTool | ServerTool)[] = readonly (
    | ClientTool
    | ServerTool
  )[],
  TSubagents extends readonly (SubAgent | CompiledSubAgent)[] = readonly (
    | SubAgent
    | CompiledSubAgent
  )[],
> extends AgentTypeConfig<TResponse, TState, TContext, TMiddleware, TTools> {
  /** The subagents array type for type-safe streaming */
  Subagents: TSubagents;
}

/**
 * Default type configuration for deep agents.
 * Used when no explicit type parameters are provided.
 */
export interface DefaultDeepAgentTypeConfig extends DeepAgentTypeConfig {
  Response: Record<string, any>;
  State: undefined;
  Context: AnyAnnotationRoot;
  Middleware: readonly AgentMiddleware[];
  Tools: readonly (ClientTool | ServerTool)[];
  Subagents: readonly (SubAgent | CompiledSubAgent)[];
}

/**
 * DeepAgent extends ReactAgent with additional subagent type information.
 *
 * This type wraps ReactAgent but includes the DeepAgentTypeConfig which
 * contains subagent types for type-safe streaming and delegation.
 *
 * @typeParam TTypes - The DeepAgentTypeConfig containing all type parameters
 *
 * @example
 * ```typescript
 * const agent: DeepAgent<DeepAgentTypeConfig<...>> = createDeepAgent({ ... });
 *
 * // Access subagent types for streaming
 * type Subagents = InferDeepAgentSubagents<typeof agent>;
 * ```
 */
export type DeepAgent<
  TTypes extends DeepAgentTypeConfig = DeepAgentTypeConfig,
> = ReactAgent<TTypes> & {
  /** Type brand for DeepAgent type inference */
  readonly "~deepAgentTypes": TTypes;
};

/**
 * Helper type to resolve a DeepAgentTypeConfig from either:
 * - A DeepAgentTypeConfig directly
 * - A DeepAgent instance (using `typeof agent`)
 *
 * @example
 * ```typescript
 * const agent = createDeepAgent({ ... });
 * type Types = ResolveDeepAgentTypeConfig<typeof agent>;
 * ```
 */
export type ResolveDeepAgentTypeConfig<T> = T extends {
  "~deepAgentTypes": infer Types;
}
  ? Types extends DeepAgentTypeConfig
    ? Types
    : never
  : T extends DeepAgentTypeConfig
    ? T
    : never;

/**
 * Helper type to extract any property from a DeepAgentTypeConfig or DeepAgent.
 *
 * @typeParam T - The DeepAgentTypeConfig or DeepAgent to extract from
 * @typeParam K - The property key to extract
 *
 * @example
 * ```typescript
 * const agent = createDeepAgent({ subagents: [...] });
 * type Subagents = InferDeepAgentType<typeof agent, "Subagents">;
 * ```
 */
export type InferDeepAgentType<
  T,
  K extends keyof DeepAgentTypeConfig,
> = ResolveDeepAgentTypeConfig<T>[K];

/**
 * Shorthand helper to extract the Subagents type from a DeepAgentTypeConfig or DeepAgent.
 *
 * @example
 * ```typescript
 * const agent = createDeepAgent({ subagents: [subagent1, subagent2] });
 * type Subagents = InferDeepAgentSubagents<typeof agent>;
 * ```
 */
export type InferDeepAgentSubagents<T> = InferDeepAgentType<T, "Subagents">;

/**
 * Helper type to extract CompiledSubAgent (subagents with `runnable`) from a DeepAgent.
 * Uses Extract to filter for subagents that have a `runnable` property.
 *
 * @example
 * ```typescript
 * const agent = createDeepAgent({ subagents: [subagent1, compiledSubagent] });
 * type CompiledSubagents = InferCompiledSubagents<typeof agent>;
 * // Result: the subagent type that has `runnable` property
 * ```
 */
export type InferCompiledSubagents<T> = Extract<
  InferDeepAgentSubagents<T>[number],
  { runnable: unknown }
>;

/**
 * Helper type to extract SubAgent (subagents with `middleware`) from a DeepAgent.
 * Uses Extract to filter for subagents that have a `middleware` property but no `runnable`.
 *
 * @example
 * ```typescript
 * const agent = createDeepAgent({ subagents: [subagent1, compiledSubagent] });
 * type RegularSubagents = InferRegularSubagents<typeof agent>;
 * // Result: the subagent type that has `middleware` property
 * ```
 */
export type InferRegularSubagents<T> = Exclude<
  InferDeepAgentSubagents<T>[number],
  { runnable: unknown }
>;

/**
 * Helper type to extract a subagent by name from a DeepAgent.
 *
 * @typeParam T - The DeepAgent to extract from
 * @typeParam TName - The name of the subagent to extract
 *
 * @example
 * ```typescript
 * const agent = createDeepAgent({
 *   subagents: [
 *     { name: "researcher", description: "...", middleware: [ResearchMiddleware] }
 *   ] as const,
 * });
 *
 * type ResearcherAgent = InferSubagentByName<typeof agent, "researcher">;
 * ```
 */
export type InferSubagentByName<T, TName extends string> =
  InferDeepAgentSubagents<T> extends readonly (infer SA)[]
    ? SA extends { name: TName }
      ? SA
      : never
    : never;

/**
 * Helper type to extract the ReactAgent type from a subagent definition.
 * This is useful for type-safe streaming of subagent events.
 *
 * @typeParam TSubagent - The subagent definition
 *
 * @example
 * ```typescript
 * type SubagentMiddleware = ExtractSubAgentMiddleware<typeof subagent>;
 * type SubagentState = InferMiddlewareStates<SubagentMiddleware>;
 * ```
 */
export type InferSubagentReactAgentType<
  TSubagent extends SubAgent | CompiledSubAgent,
> = TSubagent extends CompiledSubAgent
  ? TSubagent["runnable"]
  : TSubagent extends SubAgent
    ? ReactAgent<
        AgentTypeConfig<
          ResponseFormatUndefined,
          undefined,
          AnyAnnotationRoot,
          ExtractSubAgentMiddleware<TSubagent>,
          readonly []
        >
      >
    : never;

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
  TResponse extends SupportedResponseFormat = SupportedResponseFormat,
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
  /**
   * Optional list of memory file paths (AGENTS.md files) to load
   * (e.g., ["~/.deepagents/AGENTS.md", "./.deepagents/AGENTS.md"]).
   * Display names are automatically derived from paths.
   * Memory is loaded at agent startup and added into the system prompt.
   */
  memory?: string[];
  /**
   * Optional list of skill source paths (e.g., `["/skills/user/", "/skills/project/"]`).
   *
   * Paths use POSIX conventions (forward slashes) and are relative to the backend's root.
   * Later sources override earlier ones for skills with the same name (last one wins).
   *
   * @example
   * ```typescript
   * // With FilesystemBackend - skills loaded from disk
   * const agent = await createDeepAgent({
   *   backend: new FilesystemBackend({ rootDir: "/home/user/.deepagents" }),
   *   skills: ["/skills/"],
   * });
   *
   * // With StateBackend - skills provided in state
   * const agent = await createDeepAgent({
   *   skills: ["/skills/"],
   * });
   * const result = await agent.invoke({
   *   messages: [...],
   *   files: {
   *     "/skills/my-skill/SKILL.md": {
   *       content: ["---", "name: my-skill", "description: ...", "---", "# My Skill"],
   *       created_at: new Date().toISOString(),
   *       modified_at: new Date().toISOString(),
   *     },
   *   },
   * });
   * ```
   */
  skills?: string[];
}
