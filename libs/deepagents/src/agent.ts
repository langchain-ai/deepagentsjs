import {
  createAgent,
  humanInTheLoopMiddleware,
  anthropicPromptCachingMiddleware,
  todoListMiddleware,
  summarizationMiddleware,
  SystemMessage,
  type AgentMiddleware,
} from "langchain";
import type {
  ClientTool,
  ServerTool,
  StructuredTool,
} from "@langchain/core/tools";
import { Runnable } from "@langchain/core/runnables";
import type { BaseStore } from "@langchain/langgraph-checkpoint";

import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  createMemoryMiddleware,
  createSkillsMiddleware,
  type SubAgent,
} from "./middleware/index.js";
import { StateBackend } from "./backends/index.js";
import { InteropZodObject } from "@langchain/core/utils/types";
import { CompiledSubAgent } from "./middleware/subagents.js";
import type {
  CreateDeepAgentParams,
  DeepAgent,
  DeepAgentTypeConfig,
  FlattenSubAgentMiddleware,
  InferStructuredResponse,
  SupportedResponseFormat,
} from "./types.js";

/**
 * required for type inference
 */
import type * as _messages from "@langchain/core/messages";
import type * as _Command from "@langchain/langgraph";

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
 * @returns ReactAgent instance ready for invocation with properly inferred state types
 *
 * @example
 * ```typescript
 * // Middleware with custom state
 * const ResearchMiddleware = createMiddleware({
 *   name: "ResearchMiddleware",
 *   stateSchema: z.object({ research: z.string().default("") }),
 * });
 *
 * const agent = createDeepAgent({
 *   middleware: [ResearchMiddleware],
 * });
 *
 * const result = await agent.invoke({ messages: [...] });
 * // result.research is properly typed as string
 * ```
 */
export function createDeepAgent<
  TResponse extends SupportedResponseFormat = SupportedResponseFormat,
  ContextSchema extends InteropZodObject = InteropZodObject,
  const TMiddleware extends readonly AgentMiddleware[] = readonly [],
  const TSubagents extends readonly (SubAgent | CompiledSubAgent)[] =
    readonly [],
  const TTools extends readonly (ClientTool | ServerTool)[] = readonly [],
>(
  params: CreateDeepAgentParams<
    TResponse,
    ContextSchema,
    TMiddleware,
    TSubagents,
    TTools
  > = {} as CreateDeepAgentParams<
    TResponse,
    ContextSchema,
    TMiddleware,
    TSubagents,
    TTools
  >,
) {
  const {
    model = "claude-sonnet-4-5-20250929",
    tools = [],
    systemPrompt,
    middleware: customMiddleware = [],
    subagents = [],
    responseFormat,
    contextSchema,
    checkpointer,
    store,
    backend,
    interruptOn,
    name,
    memory,
    skills,
  } = params;

  /**
   * Combine system prompt with base prompt like Python implementation
   */
  const finalSystemPrompt = systemPrompt
    ? typeof systemPrompt === "string"
      ? `${systemPrompt}\n\n${BASE_PROMPT}`
      : new SystemMessage({
          content: [
            {
              type: "text",
              text: BASE_PROMPT,
            },
            ...(typeof systemPrompt.content === "string"
              ? [{ type: "text", text: systemPrompt.content }]
              : systemPrompt.content),
          ],
        })
    : BASE_PROMPT;

  /**
   * Create backend configuration for filesystem middleware
   * If no backend is provided, use a factory that creates a StateBackend
   */
  const filesystemBackend = backend
    ? backend
    : (config: { state: unknown; store?: BaseStore }) =>
        new StateBackend(config);

  /**
   * Skills middleware (created conditionally for runtime use)
   */
  const skillsMiddlewareArray =
    skills != null && skills.length > 0
      ? [
          createSkillsMiddleware({
            backend: filesystemBackend,
            sources: skills,
          }),
        ]
      : [];

  /**
   * Memory middleware (created conditionally for runtime use)
   */
  const memoryMiddlewareArray =
    memory != null && memory.length > 0
      ? [
          createMemoryMiddleware({
            backend: filesystemBackend,
            sources: memory,
          }),
        ]
      : [];

  /**
   * Process subagents to add SkillsMiddleware for those with their own skills.
   *
   * Custom subagents do NOT inherit skills from the main agent by default.
   * Only the general-purpose subagent inherits the main agent's skills (via defaultMiddleware).
   * If a custom subagent needs skills, it must specify its own `skills` array.
   */
  const processedSubagents = subagents.map((subagent) => {
    /**
     * CompiledSubAgent - use as-is (already has its own middleware baked in)
     */
    if (Runnable.isRunnable(subagent)) {
      return subagent;
    }

    /**
     * SubAgent without skills - use as-is
     */
    if (!("skills" in subagent) || subagent.skills?.length === 0) {
      return subagent;
    }

    /**
     * SubAgent with skills - add SkillsMiddleware BEFORE user's middleware
     * Order: base middleware (via defaultMiddleware) → skills → user's middleware
     * This matches Python's ordering in create_deep_agent
     */
    const subagentSkillsMiddleware = createSkillsMiddleware({
      backend: filesystemBackend,
      sources: subagent.skills ?? [],
    });

    return {
      ...subagent,
      middleware: [
        subagentSkillsMiddleware,
        ...(subagent.middleware || []),
      ] as readonly AgentMiddleware[],
    };
  });

  /**
   * Middleware for custom subagents (does NOT include skills from main agent).
   * Custom subagents must define their own `skills` property to get skills.
   */
  const subagentMiddleware = [
    todoListMiddleware(),
    createFilesystemMiddleware({
      backend: filesystemBackend,
    }),
    summarizationMiddleware({
      model,
      trigger: { tokens: 170_000 },
      keep: { messages: 6 },
    }),
    anthropicPromptCachingMiddleware({
      unsupportedModelBehavior: "ignore",
    }),
    createPatchToolCallsMiddleware(),
  ];

  /**
   * Built-in middleware array - core middleware with known types
   * This tuple is typed without conditional spreads to preserve TypeScript's tuple inference.
   * Optional middleware (skills, memory, HITL) are handled at runtime but typed explicitly.
   */
  const builtInMiddleware = [
    /**
     * Provides todo list management capabilities for tracking tasks
     */
    todoListMiddleware(),
    /**
     * Enables filesystem operations and optional long-term memory storage
     */
    createFilesystemMiddleware({ backend: filesystemBackend }),
    /**
     * Enables delegation to specialized subagents for complex tasks
     */
    createSubAgentMiddleware({
      defaultModel: model,
      defaultTools: tools as StructuredTool[],
      /**
       * Custom subagents must define their own `skills` property to get skills.
       */
      defaultMiddleware: subagentMiddleware,
      /**
       * Middleware for the general-purpose subagent (inherits skills from main agent).
       */
      generalPurposeMiddleware: [
        ...subagentMiddleware,
        ...skillsMiddlewareArray,
      ],
      defaultInterruptOn: interruptOn,
      subagents: processedSubagents,
      generalPurposeAgent: true,
    }),
    /**
     * Automatically summarizes conversation history when token limits are approached
     */
    summarizationMiddleware({
      model,
      trigger: { tokens: 170_000 },
      keep: { messages: 6 },
    }),
    /**
     * Enables Anthropic prompt caching for improved performance and reduced costs
     */
    anthropicPromptCachingMiddleware({
      unsupportedModelBehavior: "ignore",
    }),
    /**
     * Patches tool calls to ensure compatibility across different model providers
     */
    createPatchToolCallsMiddleware(),
  ] as const;

  /**
   * Runtime middleware array: combine built-in + optional middleware
   * Note: The type is handled separately via AllMiddleware type alias
   */
  const runtimeMiddleware: AgentMiddleware[] = [
    ...builtInMiddleware,
    ...skillsMiddlewareArray,
    ...memoryMiddlewareArray,
    ...(interruptOn ? [humanInTheLoopMiddleware({ interruptOn })] : []),
    ...(customMiddleware as unknown as AgentMiddleware[]),
  ];

  const agent = createAgent({
    model,
    systemPrompt: finalSystemPrompt,
    tools: tools as StructuredTool[],
    middleware: runtimeMiddleware,
    ...(responseFormat != null && { responseFormat }),
    contextSchema,
    checkpointer,
    store,
    name,
  }).withConfig({ recursionLimit: 10_000 });

  /**
   * Combine custom middleware with flattened subagent middleware for complete type inference
   * This ensures InferMiddlewareStates captures state from both sources
   */
  type AllMiddleware = readonly [
    ...typeof builtInMiddleware,
    ...TMiddleware,
    ...FlattenSubAgentMiddleware<TSubagents>,
  ];

  /**
   * Return as DeepAgent with proper DeepAgentTypeConfig
   * - Response: InferStructuredResponse<TResponse> (unwraps ToolStrategy<T>/ProviderStrategy<T> → T)
   * - State: undefined (state comes from middleware)
   * - Context: ContextSchema
   * - Middleware: AllMiddleware (built-in + custom + subagent middleware for state inference)
   * - Tools: TTools
   * - Subagents: TSubagents (for type-safe streaming)
   */
  return agent as unknown as DeepAgent<
    DeepAgentTypeConfig<
      InferStructuredResponse<TResponse>,
      undefined,
      ContextSchema,
      AllMiddleware,
      TTools,
      TSubagents
    >
  >;
}
