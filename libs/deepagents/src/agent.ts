import {
  createAgent,
  humanInTheLoopMiddleware,
  anthropicPromptCachingMiddleware,
  bedrockPromptCachingMiddleware,
  todoListMiddleware,
  SystemMessage,
  type AgentMiddleware,
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
  type FsToolName,
  type SubAgent,
  createAsyncSubAgentMiddleware,
  isAsyncSubAgent,
} from "./middleware/index.js";
import { StateBackend } from "./backends/state.js";
import { ConfigurationError } from "./errors.js";
import type { SystemPromptConfig } from "./compat.js";
import { InteropZodObject } from "@langchain/core/utils/types";
import { createCacheBreakpointMiddleware } from "./middleware/cache.js";
import { createToolExclusionMiddleware } from "./middleware/tool_exclusion.js";
import { mergeMiddlewareStack } from "./middleware/utils.js";
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
import type { AnyStateSchema, StreamTransformer } from "@langchain/langgraph";
import {
  resolveHarnessProfile,
  applyProfilePrompt,
  resolveMiddleware,
} from "./profiles/index.js";
import {
  isAnthropicModel,
  getModelProvider,
  getModelIdentifier,
  isBedrockConverseModel,
} from "./utils.js";

type SystemPromptPart = string | SystemMessage;

function normalizeSystemPrompt(
  systemPrompt: SystemPromptPart | SystemPromptConfig | undefined,
): SystemPromptConfig {
  if (systemPrompt === undefined) return {};
  if (
    typeof systemPrompt === "string" ||
    SystemMessage.isInstance(systemPrompt)
  ) {
    return { prefix: systemPrompt };
  }
  return systemPrompt;
}

function assemblePromptParts(
  parts: readonly (SystemPromptPart | null | undefined)[],
): string | SystemMessage {
  const nonEmptyParts = parts.filter(
    (part): part is SystemPromptPart =>
      part != null && (typeof part !== "string" || part.length > 0),
  );
  if (nonEmptyParts.length === 0) return "";
  if (nonEmptyParts.every((part) => typeof part === "string")) {
    return nonEmptyParts.join("\n\n");
  }

  const contentBlocks: SystemMessage["contentBlocks"] = [];
  for (const [index, part] of nonEmptyParts.entries()) {
    if (index > 0) contentBlocks.push({ type: "text", text: "\n\n" });
    if (SystemMessage.isInstance(part))
      contentBlocks.push(...part.contentBlocks);
    else contentBlocks.push({ type: "text", text: part });
  }
  return new SystemMessage({ contentBlocks });
}

const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...FILESYSTEM_TOOL_NAMES,
  ...ASYNC_TASK_TOOL_NAMES,
  "task",
  "write_todos",
]);

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
 * // Custom state from middleware and/or the agent stateSchema param — both are merged
 * const ResearchMiddleware = createMiddleware({
 *   name: "ResearchMiddleware",
 *   stateSchema: z.object({ research: z.string().default("") }),
 * });
 *
 * const agent = createDeepAgent({
 *   middleware: [ResearchMiddleware],
 *   stateSchema: z.object({ author: z.string().default("Me") }),
 * });
 *
 * const result = await agent.invoke({ messages: [...] });
 * // result.research and result.author are properly typed as strings
 * ```
 */
export function createDeepAgent<
  TResponse extends SupportedResponseFormat = SupportedResponseFormat,
  ContextSchema extends InteropZodObject = InteropZodObject,
  const TMiddleware extends readonly AgentMiddleware[] = readonly [],
  const TSubagents extends readonly AnySubAgent[] = readonly [],
  const TTools extends readonly (ClientTool | ServerTool)[] = readonly [],
  const TStreamTransformers extends ReadonlyArray<
    () => StreamTransformer<any>
  > = readonly [],
  TStateSchema extends AnyStateSchema | InteropZodObject | undefined =
    undefined,
>(
  params: CreateDeepAgentParams<
    TResponse,
    ContextSchema,
    TMiddleware,
    TSubagents,
    TTools,
    TStreamTransformers,
    TStateSchema
  > = {} as CreateDeepAgentParams<
    TResponse,
    ContextSchema,
    TMiddleware,
    TSubagents,
    TTools,
    TStreamTransformers,
    TStateSchema
  >,
) {
  const {
    model = "anthropic:claude-sonnet-4-6",
    tools = [],
    systemPrompt,
    stateSchema,
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
    permissions = [],
    streamTransformers = [],
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

  const harnessProfile =
    typeof model === "string"
      ? resolveHarnessProfile({ spec: model })
      : resolveHarnessProfile({
          providerHint: getModelProvider(model),
          identifierHint: getModelIdentifier(model),
        });

  const filesystemTools = FILESYSTEM_TOOL_NAMES.filter(
    (toolName) => !harnessProfile.excludedTools.has(toolName),
  );
  const profileFilesystemTools: readonly FsToolName[] | undefined =
    filesystemTools.length === FILESYSTEM_TOOL_NAMES.length ||
    !filesystemTools.includes("read_file")
      ? undefined
      : filesystemTools;

  const toolOverrides = harnessProfile.toolDescriptionOverrides;
  const effectiveTools: StructuredTool[] =
    Object.keys(toolOverrides).length > 0
      ? (tools as StructuredTool[]).map((t) =>
          t.name in toolOverrides
            ? Object.assign(Object.create(Object.getPrototypeOf(t)), t, {
                description: toolOverrides[t.name],
              })
            : t,
        )
      : (tools as StructuredTool[]);

  const anthropicModel = isAnthropicModel(model);
  const bedrockModel = isBedrockConverseModel(model);
  let cacheMiddleware: AgentMiddleware[] = [];

  if (anthropicModel) {
    cacheMiddleware = [
      ...cacheMiddleware,
      anthropicPromptCachingMiddleware({
        unsupportedModelBehavior: "ignore",
        minMessagesToCache: 1,
      }),
      createCacheBreakpointMiddleware(),
    ];
  }

  if (bedrockModel) {
    cacheMiddleware = [
      ...cacheMiddleware,
      bedrockPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    ];
  }

  /**
   * Process subagents to add SkillsMiddleware for those with their own skills.
   *
   * Custom subagents do NOT inherit skills from the main agent by default.
   * Only the general-purpose subagent inherits the main agent's skills.
   * If a custom subagent needs skills, it must specify its own `skills` array.
   */
  const createSubagentDefaultMiddleware = (
    input: SubAgent,
  ): AgentMiddleware[] => {
    const effectivePermissions = input.permissions ?? permissions;

    // Middleware for custom subagents (does NOT include skills from main agent).
    // Uses createSummarizationMiddleware (deepagents version) with backend support
    // and auto-computed defaults from model profile.
    return [
      // Provides todo list management capabilities for tracking tasks.
      todoListMiddleware({ systemPrompt: "\u200B" }),
      // Enables filesystem operations and optional long-term memory storage.
      createFilesystemMiddleware({
        backend,
        permissions: effectivePermissions,
        tools: profileFilesystemTools,
      }),
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
    ];
  };

  const normalizeSubagentSpec = (input: SubAgent): SubAgent => {
    const subagentDefaultMiddleware = createSubagentDefaultMiddleware(input);
    let subagentMiddleware = mergeMiddlewareStack(
      subagentDefaultMiddleware,
      input.middleware ?? [],
      cacheMiddleware,
    );

    if (harnessProfile.excludedMiddleware.size > 0) {
      subagentMiddleware = subagentMiddleware.filter(
        (middleware) => !harnessProfile.excludedMiddleware.has(middleware.name),
      );
    }

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

  const gpConfig = harnessProfile.generalPurposeSubagent;
  const gpDisabled = gpConfig?.enabled === false;

  if (
    !gpDisabled &&
    !inlineSubagents.some(
      (item) => item.name === GENERAL_PURPOSE_SUBAGENT["name"],
    )
  ) {
    const gpSystemPrompt =
      gpConfig?.systemPrompt ??
      applyProfilePrompt(harnessProfile, GENERAL_PURPOSE_SUBAGENT.systemPrompt);

    const generalPurposeSpec = normalizeSubagentSpec({
      ...GENERAL_PURPOSE_SUBAGENT,
      description:
        gpConfig?.description ?? GENERAL_PURPOSE_SUBAGENT.description,
      systemPrompt: gpSystemPrompt,
      model,
      skills,
      tools: effectiveTools,
    });
    generalPurposeSpec.middleware = mergeMiddlewareStack(
      generalPurposeSpec.middleware ?? [],
      customMiddleware,
      [],
      { appendNew: false },
    );
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
    todoListMiddleware({ systemPrompt: "\u200B" }),
    // Enables filesystem operations and optional long-term memory storage.
    createFilesystemMiddleware({
      backend,
      permissions,
      tools: profileFilesystemTools,
    }),
    // Enables delegation to specialized subagents for complex tasks.
    createSubAgentMiddleware({
      defaultModel: model,
      defaultTools: effectiveTools,
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

  // Runtime middleware array: combine core middleware, custom overrides, and tail middleware.
  const coreMiddleware: AgentMiddleware[] = [
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
  ];
  const tailMiddleware: AgentMiddleware[] = [
    // Profile middleware runs before cache middleware so it participates in prompt caching.
    ...resolveMiddleware(harnessProfile.extraMiddleware),
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

  let middleware: AgentMiddleware[] = mergeMiddlewareStack(
    coreMiddleware,
    customMiddleware,
    tailMiddleware,
  );

  // Apply profile middleware exclusions after custom replacement so exclusions win.
  if (harnessProfile.excludedMiddleware.size > 0) {
    const excluded = harnessProfile.excludedMiddleware;
    middleware = middleware.filter((entry) => !excluded.has(entry.name));
  }

  // Apply profile tool exclusions via a filtering middleware that runs
  // after all tool-injecting middleware.
  if (harnessProfile.excludedTools.size > 0) {
    middleware.push(
      createToolExclusionMiddleware(harnessProfile.excludedTools),
    );
  }

  // Compatibility assembly: prefix -> profile base -> suffix -> profile suffix.
  const promptConfig = normalizeSystemPrompt(systemPrompt);
  const activeBasePrompt =
    promptConfig.base !== undefined
      ? promptConfig.base
      : harnessProfile.baseSystemPrompt;
  const finalSystemPrompt = assemblePromptParts([
    promptConfig.prefix,
    activeBasePrompt,
    promptConfig.suffix,
    harnessProfile.systemPromptSuffix,
  ]);

  const agent = createAgent({
    model,
    ...(finalSystemPrompt !== "" && { systemPrompt: finalSystemPrompt }),
    stateSchema,
    tools: effectiveTools,
    middleware,
    ...(responseFormat !== null && { responseFormat }),
    contextSchema,
    checkpointer,
    store,
    name,
    streamTransformers,
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
   * - State: User-provided stateSchema, merged with middleware-derived state downstream
   * - Context: ContextSchema
   * - Middleware: AllMiddleware (built-in + custom + subagent middleware for state inference)
   * - Tools: TTools
   * - Subagents: TSubagents (for type-safe streaming)
   * - StreamTransformers: TStreamTransformers
   */
  return agent as unknown as DeepAgent<
    DeepAgentTypeConfig<
      InferStructuredResponse<TResponse>,
      TStateSchema,
      ContextSchema,
      AllMiddleware,
      TTools,
      TSubagents,
      TStreamTransformers
    >
  >;
}
