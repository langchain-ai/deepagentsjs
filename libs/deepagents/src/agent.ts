import {
  createAgent,
  humanInTheLoopMiddleware,
  anthropicPromptCachingMiddleware,
  todoListMiddleware,
  SystemMessage,
  type AgentMiddleware,
  context,
} from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
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
  type SubAgent,
  createAsyncSubAgentMiddleware,
  isAsyncSubAgent,
} from "./middleware/index.js";
import { StateBackend } from "./backends/index.js";
import { ConfigurationError } from "./errors.js";
import { InteropZodObject } from "@langchain/core/utils/types";
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
import type * as _Command from "@langchain/langgraph";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { createCacheBreakpointMiddleware } from "./middleware/cache.js";
import { iife } from "./utils.js";

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
    model = new ChatAnthropic("claude-sonnet-4-6"),
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

  const normalizeSubagentSpec = (input: SubAgent): SubAgent => {
    const effectiveInterruptOn = input.interruptOn ?? interruptOn;
    const subagentMiddleware = [
      todoListMiddleware(),
      createFilesystemMiddleware({ backend }),
      createSummarizationMiddleware({ backend, model }),
      createPatchToolCallsMiddleware(),
      ...(input.skills != null && input.skills.length > 0
        ? [createSkillsMiddleware({ backend, sources: input.skills })]
        : []),
      ...(input.middleware ?? []),
      ...cacheMiddleware,
      ...(effectiveInterruptOn
        ? [humanInTheLoopMiddleware({ interruptOn: effectiveInterruptOn })]
        : []),
    ];
    return {
      ...input,
      tools: input.tools ?? [],
      middleware: subagentMiddleware,
    };
  };

  const allSubagents = subagents as readonly AnySubAgent[];

  const asyncSubAgents = allSubagents.filter((item): item is AsyncSubAgent =>
    isAsyncSubAgent(item),
  );

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

  const builtInMiddleware = [
    todoListMiddleware(),
    createFilesystemMiddleware({ backend }),
    createSubAgentMiddleware({
      defaultModel: model,
      defaultTools: tools as StructuredTool[],
      defaultInterruptOn: interruptOn,
      subagents: inlineSubagents,
      generalPurposeAgent: false,
    }),
    createSummarizationMiddleware({ model, backend }),
    createPatchToolCallsMiddleware(),
  ] as const;

  const [
    todoMiddleware,
    fsMiddleware,
    subagentMiddleware,
    summarizationMiddleware,
    patchToolCallsMiddleware,
  ] = builtInMiddleware;

  const middleware = [
    todoMiddleware,
    ...skillsMiddleware,
    fsMiddleware,
    subagentMiddleware,
    summarizationMiddleware,
    patchToolCallsMiddleware,
    ...(asyncSubAgents.length > 0
      ? [createAsyncSubAgentMiddleware({ asyncSubAgents })]
      : []),
    ...customMiddleware,
    ...cacheMiddleware,
    ...(memory && memory.length > 0
      ? [
          createMemoryMiddleware({
            backend,
            sources: memory,
            addCacheControl: anthropicModel,
          }),
        ]
      : []),
    ...(interruptOn ? [humanInTheLoopMiddleware({ interruptOn })] : []),
  ];

  // Combine system prompt parameter with BASE_AGENT_PROMPT
  const finalSystemPrompt = iife(() => {
    if (typeof systemPrompt === "string") {
      return new SystemMessage({
        contentBlocks: [
          { type: "text", text: systemPrompt },
          { type: "text", text: BASE_AGENT_PROMPT },
        ],
      });
    }
    if (SystemMessage.isInstance(systemPrompt)) {
      return new SystemMessage({
        contentBlocks: [
          ...systemPrompt.contentBlocks,
          { type: "text", text: BASE_AGENT_PROMPT },
        ],
      });
    }
    return new SystemMessage({
      contentBlocks: [{ type: "text", text: BASE_AGENT_PROMPT }],
    });
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
