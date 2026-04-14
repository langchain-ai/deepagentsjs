import {
  createAgent,
  humanInTheLoopMiddleware,
  anthropicPromptCachingMiddleware,
  todoListMiddleware,
  SystemMessage,
  type AgentMiddleware,
  context,
} from "langchain";
import type {
  ClientTool,
  ServerTool,
  StructuredTool,
} from "@langchain/core/tools";

import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  createSummarizationMiddleware,
  createMemoryMiddleware,
  createSkillsMiddleware,
  FILESYSTEM_TOOL_NAMES,
  ASYNC_TASK_TOOL_NAMES,
  type SubAgent,
  createAsyncSubAgentMiddleware,
  isAsyncSubAgent,
} from "./middleware/index.js";
import { StateBackend } from "./backends/index.js";
import { ConfigurationError } from "./errors.js";
import { InteropZodObject } from "@langchain/core/utils/types";
import { createCacheBreakpointMiddleware } from "./middleware/cache.js";
import {
  GENERAL_PURPOSE_SUBAGENT,
  type CompiledSubAgent,
} from "./middleware/subagents.js";
import type { AsyncSubAgent } from "./middleware/async_subagents.js";
import type {
  AnySubAgent,
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
import type * as _langgraph from "@langchain/langgraph";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";

const BASE_AGENT_PROMPT = context`
  You are a Deep Agent, an AI assistant that helps users accomplish tasks using tools. You respond with text and tool calls. The user can see your responses and tool outputs in real time.

  ## Core Behavior

  - Be concise and direct. Don't over-explain unless asked.
  - NEVER add unnecessary preamble (\"Sure!\", \"Great question!\", \"I'll now...\").
  - Don't say \"I'll now do X\" — just do it.
  - If the request is ambiguous, ask questions before acting.
  - If asked how to approach something, explain first, then act.

  ## Professional Objectivity

  - Prioritize accuracy over validating the user's beliefs
  - Disagree respectfully when the user is incorrect
  - Avoid unnecessary superlatives, praise, or emotional validation

  ## Doing Tasks

  When the user asks you to do something:

  1. **Understand first** — read relevant files, check existing patterns. Quick but thorough — gather enough evidence to start, then iterate.
  2. **Act** — implement the solution. Work quickly but accurately.
  3. **Verify** — check your work against what was asked, not against your own output. Your first attempt is rarely correct — iterate.

  Keep working until the task is fully complete. Don't stop partway and explain what you would do — just do it. Only yield back to the user when the task is done or you're genuinely blocked.

  **When things go wrong:**
  - If something fails repeatedly, stop and analyze *why* — don't keep retrying the same approach.
  - If you're blocked, tell the user what's wrong and ask for guidance.

  ## Progress Updates

  For longer tasks, provide brief progress updates at reasonable intervals — a concise sentence recapping what you've done and what's next.
`;

const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...FILESYSTEM_TOOL_NAMES,
  ...ASYNC_TASK_TOOL_NAMES,
  "task",
  "write_todos",
]);

/**
 * Detect whether a model is an Anthropic model.
 * Used to gate Anthropic-specific prompt caching optimizations (cache_control breakpoints).
 */
export function isAnthropicModel(model: BaseLanguageModel | string): boolean {
  if (typeof model === "string") {
    if (model.includes(":")) return model.split(":")[0] === "anthropic";
    return model.startsWith("claude");
  }
  if (model.getName() === "ConfigurableModel") {
    return (model as any)._defaultConfig?.modelProvider === "anthropic";
  }
  return model.getName() === "ChatAnthropic";
}

/**
 * Create a Deep Agent.
 *
 * This is the main entry point for building a production-style agent with
 * deepagents. It gives you a strong default runtime (filesystem, tasks,
 * subagents, summarization) and lets you opt into skills, memory,
 * human-in-the-loop interrupts, async subagents, and custom middleware.
 *
 * The runtime is intentionally opinionated: defaults work out of the box, and
 * when you customize behavior, the middleware ordering stays deterministic.
 *
 * @param params Configuration parameters for the agent
 * @returns Deep Agent instance with inferred state/response types
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
  const TSubagents extends readonly AnySubAgent[] = readonly [],
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
    model = "anthropic:claude-sonnet-4-6",
    tools = [],
    systemPrompt,
    middleware: customMiddleware = [],
    subagents = [],
    responseFormat,
    contextSchema,
    checkpointer,
    store,
    backend = (config) => new StateBackend(config),
    interruptOn,
    name,
    memory,
    skills,
  } = params;

  const collidingTools = tools
    .map((t) => t.name)
    .filter((n) => typeof n === "string" && BUILTIN_TOOL_NAMES.has(n));

  if (collidingTools.length > 0) {
    throw new ConfigurationError(
      `Tool name(s) [${collidingTools.join(", ")}] conflict with built-in tools. ` +
        `Rename your custom tools to avoid this.`,
      "TOOL_NAME_COLLISION",
    );
  }

  const anthropicModel = isAnthropicModel(model);
  const cacheMiddleware = anthropicModel
    ? [
        anthropicPromptCachingMiddleware({
          unsupportedModelBehavior: "ignore",
          minMessagesToCache: 1,
        }),
        createCacheBreakpointMiddleware(),
      ]
    : [];

  /**
   * Process subagents to add SkillsMiddleware for those with their own skills.
   *
   * Custom subagents do NOT inherit skills from the main agent by default.
   * Only the general-purpose subagent inherits the main agent's skills.
   * If a custom subagent needs skills, it must specify its own `skills` array.
   */
  const normalizeSubagentSpec = (input: SubAgent): SubAgent => {
    // Middleware for custom subagents (does NOT include skills from main agent).
    // Uses createSummarizationMiddleware (deepagents version) with backend support
    // and auto-computed defaults from model profile.
    const subagentMiddleware = [
      // Provides todo list management capabilities for tracking tasks.
      todoListMiddleware(),
      // Enables filesystem operations and optional long-term memory storage.
      createFilesystemMiddleware({ backend }),
      // Automatically summarizes conversation history when token limits are approached.
      // Uses createSummarizationMiddleware (deepagents version) with backend support
      // and auto-computed defaults from model profile.
      createSummarizationMiddleware({ backend }),
      // Patches tool calls to ensure compatibility across different model providers.
      createPatchToolCallsMiddleware(),
      // Loads subagent-specific skills when configured.
      ...(input.skills != null && input.skills.length > 0
        ? [createSkillsMiddleware({ backend, sources: input.skills })]
        : []),
      // Appends custom middleware from the subagent spec.
      ...(input.middleware ?? []),
      // Adds Anthropic cache controls when supported by the model.
      ...cacheMiddleware,
    ];
    return {
      ...input,
      tools: input.tools ?? [],
      middleware: subagentMiddleware,
    };
  };

  const allSubagents = subagents as readonly AnySubAgent[];

  // Split the unified subagents array into sync and async subagents.
  // AsyncSubAgents are identified by the presence of a `graphId` field.
  const asyncSubAgents = allSubagents.filter((item): item is AsyncSubAgent =>
    isAsyncSubAgent(item),
  );

  // Process sync subagents:
  // - CompiledSubAgent: use as-is (already has its own middleware baked in)
  // - SubAgent: apply the default deep-agent subagent middleware stack
  const inlineSubagents = allSubagents
    .filter(
      (item): item is SubAgent | CompiledSubAgent => !isAsyncSubAgent(item),
    )
    .map((item) => ("runnable" in item ? item : normalizeSubagentSpec(item)));

  if (
    !inlineSubagents.some(
      (item) => item.name === GENERAL_PURPOSE_SUBAGENT["name"],
    )
  ) {
    const generalPurposeSpec = normalizeSubagentSpec({
      ...GENERAL_PURPOSE_SUBAGENT,
      model,
      skills,
      tools: tools as StructuredTool[],
    });
    inlineSubagents.unshift(generalPurposeSpec);
  }

  const skillsMiddleware =
    skills != null && skills.length > 0
      ? [createSkillsMiddleware({ backend, sources: skills })]
      : [];

  // Built-in middleware array - core middleware with known types.
  // This tuple is typed without conditional spreads to preserve tuple inference.
  // Optional middleware (skills, memory, HITL, async) are appended at runtime.
  const builtInMiddleware = [
    // Provides todo list management capabilities for tracking tasks.
    todoListMiddleware(),
    // Enables filesystem operations and optional long-term memory storage.
    createFilesystemMiddleware({ backend }),
    // Enables delegation to specialized subagents for complex tasks.
    createSubAgentMiddleware({
      defaultModel: model,
      defaultTools: tools as StructuredTool[],
      defaultInterruptOn: interruptOn,
      subagents: inlineSubagents,
      generalPurposeAgent: false,
    }),
    // Automatically summarizes conversation history when token limits are approached.
    // Uses createSummarizationMiddleware (deepagents version) with backend support
    // for conversation history offloading and auto-computed defaults from model profile.
    createSummarizationMiddleware({ backend }),
    // Patches tool calls to ensure compatibility across different model providers.
    createPatchToolCallsMiddleware(),
  ] as const;

  const [
    todoMiddleware,
    fsMiddleware,
    subagentMiddleware,
    summarizationMiddleware,
    patchToolCallsMiddleware,
  ] = builtInMiddleware;

  // Runtime middleware array: combine built-in + optional middleware.
  // Note: The full type is handled separately via AllMiddleware.
  const middleware = [
    // Built-in middleware with deterministic ordering.
    todoMiddleware,
    // Optional root-level skills.
    ...skillsMiddleware,
    fsMiddleware,
    subagentMiddleware,
    summarizationMiddleware,
    patchToolCallsMiddleware,
    // Optional async subagent bridge.
    ...(asyncSubAgents.length > 0
      ? [createAsyncSubAgentMiddleware({ asyncSubAgents })]
      : []),
    // User-provided middleware.
    ...customMiddleware,
    // Optional Anthropic cache controls.
    ...cacheMiddleware,
    // Optional memory support.
    ...(memory && memory.length > 0
      ? [
          createMemoryMiddleware({
            backend,
            sources: memory,
            addCacheControl: anthropicModel,
          }),
        ]
      : []),
    // Optional human-in-the-loop tool interrupts.
    ...(interruptOn ? [humanInTheLoopMiddleware({ interruptOn })] : []),
  ];

  // Combine system prompt parameter with BASE_AGENT_PROMPT
  const finalSystemPrompt =
    typeof systemPrompt === "string"
      ? new SystemMessage({
          contentBlocks: [
            { type: "text", text: systemPrompt },
            { type: "text", text: BASE_AGENT_PROMPT },
          ],
        })
      : SystemMessage.isInstance(systemPrompt)
        ? new SystemMessage({
            contentBlocks: [
              ...systemPrompt.contentBlocks,
              { type: "text", text: BASE_AGENT_PROMPT },
            ],
          })
        : new SystemMessage({
            contentBlocks: [{ type: "text", text: BASE_AGENT_PROMPT }],
          });

  const agent = createAgent({
    model,
    systemPrompt: finalSystemPrompt,
    tools: tools as StructuredTool[],
    middleware,
    ...(responseFormat !== null && { responseFormat }),
    contextSchema,
    checkpointer,
    store,
    name,
  }).withConfig({
    recursionLimit: 10_000,
    metadata: {
      ls_integration: "deepagents",
      lc_agent_name: name,
    },
  });

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
