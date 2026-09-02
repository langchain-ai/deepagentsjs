import { z } from "zod/v4";

import {
  createMiddleware,
  createAgent,
  AgentMiddleware,
  tool,
  ToolMessage,
  humanInTheLoopMiddleware,
  SystemMessage,
  type ContentBlock,
  type BaseMessage,
  type InterruptOnConfig,
  type ReactAgent,
  type CreateAgentParams,
  StructuredTool,
  context,
} from "langchain";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { FilesystemPermission } from "../permissions/types.js";
import { getEffectiveMessages } from "./summarization.js";

export type { AgentMiddleware };

/**
 * Config key used by task-tool callers to request dynamic response format.
 *
 * When set in `config.configurable`, the task tool recompiles the target
 * subagent with this response format instead of using the pre-compiled graph.
 */
export const SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY =
  "__deepagents_subagent_response_format";

/**
 * Default system prompt for subagents.
 * Provides a minimal base prompt that can be extended by specific subagent configurations.
 */
export const DEFAULT_SUBAGENT_PROMPT =
  "In order to complete the objective that the user asks of you, you have access to a number of standard tools.";

// Carries the parent's post-middleware system message into a fork so it can replay it verbatim.
const PARENT_SYSTEM_MESSAGE_KEY = "_deepagentsParentSystemMessage";

// Set on a forked subagent's own initial state; lets the task tool refuse recursive delegation.
const FORKED_CONTEXT_KEY = "_deepagentsForkedContext";

const FORK_RECURSION_REFUSAL =
  "You are a subagent and cannot delegate to another subagent. Complete this task yourself instead of calling this tool again.";

/**
 * State keys excluded when passing state to subagents and when returning
 * updates from subagents. Summarization keys are excluded because their
 * cutoffIndex is only valid against the message list it was computed from.
 */
const EXCLUDED_STATE_KEYS = [
  "messages",
  "todos",
  "structuredResponse",
  "skillsMetadata",
  "memoryContents",
  "_summarizationEvent",
  "_summarizationSessionId",
  PARENT_SYSTEM_MESSAGE_KEY,
  FORKED_CONTEXT_KEY,
] as const;

/**
 * Default description for the general-purpose subagent.
 * This description is shown to the model when selecting which subagent to use.
 */
export const DEFAULT_GENERAL_PURPOSE_DESCRIPTION =
  "General-purpose agent for researching complex questions, searching for files and content, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. This agent has access to all tools as the main agent.";

function getTaskToolDescription(subagentDescriptions: string[]): string {
  return context`
    Launch an ephemeral subagent to handle a complex, multi-step task.

    Available agent types and the tools they have access to:
    ${subagentDescriptions.join("\n")}

    Specify subagent_type to select the agent. Usage notes:
    - Launch multiple agents concurrently when their tasks are independent, using a single message with multiple tool calls.
    - Each invocation is stateless by default: the agent sees only the prompt you give it and returns a single final report. Put full detail in the prompt and state exactly what it should return — unless an agent type below says it inherits your conversation instead.
    - The agent's report is not shown to the user; relay a summary yourself.
    - Tell the agent whether to create content, analyze, or only research, since it can't necessarily see the user's intent unless it inherits your conversation, as noted per agent type below.
    - If an agent's description says to use it proactively, do so without waiting to be asked.
    - When only general-purpose is available, use it for any complex, context-heavy task; it has the same capabilities as the main agent.
  `;
}

// Appended to a declarative forked subagent's line so the model knows it can skip restating context.
const FORKED_SUBAGENT_TOOL_NOTE =
  " (inherits your full conversation and system prompt — no need to restate context here)";

// A compiled fork's runnable bakes in its own system prompt (see CompiledSubAgent.mode),
// so it only inherits conversation history — never claim system-prompt inheritance for it.
const COMPILED_FORKED_SUBAGENT_TOOL_NOTE =
  " (inherits your conversation history — its system prompt is fixed in its own runnable)";

/** Render one subagent's listing line for the task tool description. */
function describeSubagentForTool(
  name: string,
  description: string,
  forked: boolean,
  compiled = false,
): string {
  const suffix = forked
    ? compiled
      ? COMPILED_FORKED_SUBAGENT_TOOL_NOTE
      : FORKED_SUBAGENT_TOOL_NOTE
    : "";
  return `- ${name}: ${description}${suffix}`;
}

// Marks the replayed delegation as already-happened, so the fork doesn't mistake it as a fresh request.
const FORK_TASK_PREAMBLE =
  "[The messages above are a prior conversation you are continuing as the " +
  "subagent that was just invoked. Any mention in them of delegating to a " +
  "subagent already happened — you are that subagent, not the one being " +
  "asked to delegate further. If you try to delegate to another subagent " +
  "yourself, it will be refused — complete this task directly. Use the " +
  "specific facts, figures, and identifiers already established in that " +
  "conversation when completing the task below — do not answer " +
  "generically when exact details are already available above. Your " +
  "actual task is below.]\n\n";

/**
 * Type definitions for pre-compiled agents.
 *
 * @typeParam TRunnable - The type of the runnable (ReactAgent or Runnable).
 *   When using `createAgent` or `createDeepAgent`, this preserves the middleware
 *   types for type inference. Uses `ReactAgent<any>` to accept agents with any
 *   type configuration (including DeepAgent instances).
 */
export interface CompiledSubAgent<
  TRunnable extends ReactAgent<any> | Runnable = ReactAgent<any> | Runnable,
> {
  /** The name of the agent */
  name: string;
  /** The description of the agent */
  description: string;
  /** The agent instance */
  runnable: TRunnable;

  /**
   * Context mode. `"fork"` inherits the parent's conversation history
   * (but not its system prompt — that's baked into the runnable).
   * `"handoff"` (default) is fully isolated.
   */
  mode?: "handoff" | "fork";
}

/**
 * Fields shared by both {@link SubAgent} and {@link ForkedSubAgent}.
 *
 * @internal
 */
interface SubAgentBase {
  /** Identifier used to select this subagent in the task tool */
  name: string;

  /** Description shown to the model for subagent selection */
  description: string;

  /**
   * The system prompt for the agent. Optional on {@link SubAgent} (falls
   * back to an empty prompt if omitted); forbidden on {@link ForkedSubAgent},
   * which always inherits the parent's instead.
   */
  systemPrompt?: string | SystemMessage;

  /**
   * Context mode. `"handoff"` (default) is fully isolated. `"fork"` inherits
   * the parent's conversation history and system prompt.
   */
  mode?: "handoff" | "fork";

  /** The tools to use for the agent (tool instances, not names). Defaults to defaultTools */
  tools?: StructuredTool[];

  /** The model for the agent. Defaults to defaultModel */
  model?: LanguageModelLike | string;

  /** Additional middleware to append after default_middleware */
  middleware?: readonly AgentMiddleware[];

  /** Human-in-the-loop configuration for specific tools. Requires a checkpointer. */
  interruptOn?: Record<string, boolean | InterruptOnConfig>;

  /**
   * Skill source paths for SkillsMiddleware.
   *
   * List of paths to skill directories (e.g., `["/skills/user/", "/skills/project/"]`).
   * When specified, the subagent will have its own SkillsMiddleware that loads skills
   * from these paths. This allows subagents to have different skill sets than the main agent.
   *
   * Note: Custom subagents do NOT inherit skills from the main agent by default.
   * Only the general-purpose subagent inherits the main agent's skills.
   *
   * @example
   * ```typescript
   * const researcher: SubAgent = {
   *   name: "researcher",
   *   description: "Research assistant",
   *   systemPrompt: "You are a researcher.",
   *   skills: ["/skills/research/", "/skills/web-search/"],
   * };
   * ```
   */
  skills?: string[];

  /**
   * Structured output response format for the subagent.
   *
   * When specified, the subagent will produce a `structuredResponse` conforming to the
   * given schema. The structured response is JSON-serialized and returned as the
   * ToolMessage content to the parent agent, replacing the default last-message extraction.
   *
   * Accepts any format supported by `createAgent`: Zod schemas, JSON schema objects,
   * `toolStrategy(schema)`, `providerStrategy(schema)`, etc.
   *
   * @example
   * ```typescript
   * import { z } from "zod"
   *
   * const analyzer: SubAgent = {
   *   name: "analyzer",
   *   description: "Analyzes data and returns structured findings",
   *   systemPrompt: "Analyze the data and return your findings.",
   *   responseFormat: z.object({
   *     findings: z.string(),
   *     confidence: z.number(),
   *   }),
   * };
   * ```
   */
  responseFormat?: CreateAgentParams["responseFormat"];

  /**
   * Filesystem permission rules for this subagent.
   *
   * When specified, these rules **replace** the parent agent's permissions
   * for all tool calls made by this subagent. When omitted, the subagent
   * inherits the parent agent's permissions.
   *
   * Subagent permissions are a full replacement, not a merge.
   *
   * @example
   * ```ts
   * // Parent denies /restricted/**; this subagent can read it.
   * const reader: SubAgent = {
   *   name: "reader",
   *   permissions: [
   *     { operations: ["read"], paths: ["/restricted/**"] },
   *   ],
   * };
   * ```
   */
  permissions?: FilesystemPermission[];
}

/**
 * Specification for a subagent that can be dynamically created.
 *
 * When using `createDeepAgent`, subagents automatically receive a default middleware
 * stack (filesystemMiddleware, summarizationMiddleware, etc.) before any custom
 * `middleware` specified in this spec. Add `todoListMiddleware` explicitly to opt in.
 *
 * Always fully isolated — this subagent only ever sees the task description,
 * never the parent's conversation. Use {@link ForkedSubAgent} to inherit the
 * parent's history and system prompt instead.
 *
 * @example
 * ```typescript
 * const researcher: SubAgent = {
 *   name: "researcher",
 *   description: "Research assistant for complex topics",
 *   systemPrompt: "You are a research assistant.",
 *   tools: [webSearchTool],
 *   skills: ["/skills/research/"],
 * };
 * ```
 */
export interface SubAgent extends SubAgentBase {
  /** The system prompt to use for the agent */
  systemPrompt?: string | SystemMessage;

  /**
   * Context mode. `"handoff"` (default) is fully isolated. `"fork"` inherits
   * the parent's conversation history and system prompt.
   */
  mode?: "handoff";
}

/**
 * Specification for a subagent that inherits the parent's conversation
 * instead of starting from just the task description.
 *
 * Always forks: it inherits the parent's full message history and its exact
 * system prompt (there's no own prompt to fall back to). Mirrored middleware
 * is only added when its model matches the parent's, since that's the only
 * case with a cache benefit to protect. Deliberately has no `systemPrompt`
 * of its own: since its system slot always carries the parent's prompt,
 * there's nothing of its own to put there. If you need a subagent with a
 * distinguishing system prompt, use {@link SubAgent} without forking instead.
 *
 * @example
 * ```typescript
 * const researcher: ForkedSubAgent = {
 *   name: "researcher",
 *   description: "Continues the current investigation with full context",
 *   mode: "fork",
 *   tools: [webSearchTool],
 * };
 * ```
 *
 * @experimental Forking subagents is experimental and subject to change
 */
export interface ForkedSubAgent extends SubAgentBase {
  /** A ForkedSubAgent never has its own system prompt — always the parent's. */
  systemPrompt?: undefined;

  /** A ForkedSubAgent cannot declare its own skills — the inherited system message would discard them. */
  skills?: undefined;

  /**
   * Always `"fork"`. Required (not defaulted) so this can't structurally
   * collapse into a plain `SubAgent` — see `isForkedSubAgent` below.
   */
  mode: "fork";
}

export function isForkedSubAgent(value: unknown): value is ForkedSubAgent {
  if (typeof value !== "object" || value == null) return false;
  if (!("mode" in value)) return false;
  if (value.mode !== "fork") return false;
  return true;
}

/**
 * Base specification for the general-purpose subagent.
 *
 * This constant provides the default configuration for the general-purpose subagent
 * that is automatically included when `generalPurposeAgent: true` (the default).
 *
 * The general-purpose subagent:
 * - Has access to all tools from the main agent
 * - Inherits skills from the main agent (when skills are configured)
 * - Uses the same model as the main agent (by default)
 * - Is ideal for delegating complex, multi-step tasks
 *
 * You can spread this constant and override specific properties when creating
 * custom subagents that should behave similarly to the general-purpose agent:
 *
 * @example
 * ```typescript
 * import { GENERAL_PURPOSE_SUBAGENT, createDeepAgent } from "@anthropic/deepagents";
 *
 * // Use as-is (automatically included with generalPurposeAgent: true)
 * const agent = createDeepAgent({ model: "claude-sonnet-4-5-20250929" });
 *
 * // Or create a custom variant with different tools
 * const customGP: SubAgent = {
 *   ...GENERAL_PURPOSE_SUBAGENT,
 *   name: "research-gp",
 *   tools: [webSearchTool, readFileTool],
 * };
 *
 * const agent = createDeepAgent({
 *   model: "claude-sonnet-4-5-20250929",
 *   subagents: [customGP],
 *   // Disable the default general-purpose agent since we're providing our own
 *   // (handled automatically when using createSubAgentMiddleware directly)
 * });
 * ```
 */
export const GENERAL_PURPOSE_SUBAGENT = {
  name: "general-purpose",
  description: DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
  systemPrompt: DEFAULT_SUBAGENT_PROMPT,
  mode: "handoff",
} as const;

/**
 * Filter state to exclude certain keys when passing to subagents
 */
export function filterStateForSubagent(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!EXCLUDED_STATE_KEYS.includes(key as never)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Invalid tool message block types
 */
const INVALID_TOOL_MESSAGE_BLOCK_TYPES = [
  "tool_use",
  "thinking",
  "redacted_thinking",
];

/**
 * Create Command with filtered state update from subagent result
 */
function returnCommandWithStateUpdate(
  result: Record<string, unknown>,
  toolCallId: string,
): Command {
  const stateUpdate = filterStateForSubagent(result);

  let content: string | ContentBlock[];

  if (result.structuredResponse != null) {
    content = JSON.stringify(result.structuredResponse);
  } else {
    // Walk back to the last message with non-empty text and forward only that
    // text as a string. Anthropic sometimes emits a trailing empty `end_turn`
    // AIMessage after a final tool call, which would otherwise be forwarded as
    // an empty ToolMessage.
    // Also check ToolMessage — when a sub-agent tool has returnDirect: true,
    // the sub-agent graph terminates immediately after the ToolNode, so the
    // last meaningful message is a ToolMessage, not an AIMessage.
    const messages = (result.messages as BaseMessage[]) ?? [];
    content = "Task completed";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message) continue;
      let text = "";
      if (AIMessage.isInstance(message)) {
        text =
          typeof message.content === "string"
            ? message.content.trim()
            : (message.text?.trim() ?? "");
      } else if (ToolMessage.isInstance(message)) {
        text =
          typeof message.content === "string" ? message.content.trim() : "";
      } else {
        continue;
      }
      if (text) {
        content = text;
        break;
      }
    }
  }

  return new Command({
    update: {
      ...stateUpdate,
      messages: [
        new ToolMessage({
          content,
          tool_call_id: toolCallId,
          name: "task",
        }),
      ],
    },
  });
}

/** Drop the trailing in-flight AIMessage with unresolved tool_calls. */
function stripInFlightAIMessage(messages: BaseMessage[]): BaseMessage[] {
  const last = messages.at(-1);
  const hasPendingToolCalls =
    AIMessage.isInstance(last) && (last.tool_calls?.length ?? 0) > 0;
  return hasPendingToolCalls ? messages.slice(0, -1) : messages;
}

const ParentSystemMessageStateSchema = z.object({
  [PARENT_SYSTEM_MESSAGE_KEY]: z.instanceof(SystemMessage).optional(),
});

// Captures the parent's fully-resolved system message into state so a fork can replay it verbatim.
export function createParentSystemMessageMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: "parentSystemMessageMiddleware",
    stateSchema: ParentSystemMessageStateSchema,
    wrapModelCall: async (request, handler) => {
      await handler(request);
      return new Command({
        update: { [PARENT_SYSTEM_MESSAGE_KEY]: request.systemMessage },
      });
    },
  });
}

// Replays the parent's captured system message verbatim, required for Anthropic's cache to hit.
function createForkSystemMessageMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: "forkSystemMessageMiddleware",
    stateSchema: ParentSystemMessageStateSchema,
    wrapModelCall: async (request, handler) => {
      const parentMessage = request.state[PARENT_SYSTEM_MESSAGE_KEY];
      if (parentMessage != null) {
        return handler({ ...request, systemMessage: parentMessage });
      }
      return handler(request);
    },
  });
}

const ForkedContextStateSchema = z.object({
  [FORKED_CONTEXT_KEY]: z.boolean().optional(),
});

// Gives a fork a real (but recursion-refusing) `task` tool; must be a separate object from the parent's, and the flag must be set via `beforeAgent` — `getCurrentTaskInput()` won't see it if only seeded on the initial invoke() input.
function createForkTaskToolMiddleware(
  taskTool: StructuredTool,
): AgentMiddleware {
  return createMiddleware({
    name: "forkTaskToolMiddleware",
    stateSchema: ForkedContextStateSchema,
    tools: [taskTool],
    beforeAgent: () => ({ [FORKED_CONTEXT_KEY]: true }),
  });
}

/**
 * Create a runnable agent from a declarative `SubAgent` spec.
 *
 * This is the shared entrypoint for compiling a `SubAgent` into a
 * `ReactAgent`. Pre-compiled `CompiledSubAgent` runnables bypass this
 * function entirely.
 *
 * The spec must have `model` and `tools` set — the caller is responsible
 * for coalescing any defaults before calling this function.
 *
 * @param spec - Declarative subagent specification. Must specify `model` and `tools`.
 * @returns A compiled `ReactAgent` ready for task-tool invocation.
 */
export function createSubAgent(
  spec: SubAgent,
  options?: {
    responseFormat?: CreateAgentParams["responseFormat"];
  },
): ReactAgent {
  if (!spec.model) {
    throw new Error(`SubAgent '${spec.name}' must specify 'model'`);
  }
  if (!spec.tools) {
    throw new Error(`SubAgent '${spec.name}' must specify 'tools'`);
  }

  const middleware: AgentMiddleware[] = [...(spec.middleware ?? [])];

  if (spec.interruptOn) {
    middleware.push(
      humanInTheLoopMiddleware({ interruptOn: spec.interruptOn }),
    );
  }

  const selectedResponseFormat = options?.responseFormat ?? spec.responseFormat;

  return createAgent({
    model: spec.model,
    systemPrompt: spec.systemPrompt,
    tools: spec.tools,
    middleware,
    name: spec.name,
    ...(selectedResponseFormat != null && {
      responseFormat: selectedResponseFormat,
    }),
  });
}

/**
 * Create subagent instances from specifications.
 *
 * Returns compiled agents, raw specs keyed by name (for on-demand
 * recompilation with dynamic response formats), descriptions, and the set
 * of names that should fork the parent's conversation.
 */
function getSubagents(options: {
  defaultModel: LanguageModelLike | string;
  defaultTools: StructuredTool[];
  defaultMiddleware: AgentMiddleware[] | null;
  generalPurposeMiddleware: AgentMiddleware[] | null;
  defaultInterruptOn: Record<string, boolean | InterruptOnConfig> | null;
  subagents: (SubAgent | CompiledSubAgent | ForkedSubAgent)[];
  generalPurposeAgent: boolean;
  parentSystemPrompt?: string | SystemMessage | null;
  /** The exact tool instance forked subagents mirror — see `createTaskTool`. */
  mirroredTaskTool: StructuredTool;
}): {
  agents: Record<string, ReactAgent | Runnable>;
  specsByName: Record<string, SubAgent | CompiledSubAgent>;
  descriptions: string[];
  forkModeNames: Set<string>;
} {
  const {
    defaultModel,
    defaultTools,
    defaultMiddleware,
    generalPurposeMiddleware: gpMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
    parentSystemPrompt = null,
    mirroredTaskTool,
  } = options;

  const defaultSubagentMiddleware = defaultMiddleware || [];
  const generalPurposeMiddlewareBase =
    gpMiddleware || defaultSubagentMiddleware;
  const agents: Record<string, ReactAgent | Runnable> = {};
  const specsByName: Record<string, SubAgent | CompiledSubAgent> = {};
  const subagentDescriptions: string[] = [];
  const forkModeNames = new Set<string>();

  if (generalPurposeAgent) {
    const generalPurposeMiddleware = [...generalPurposeMiddlewareBase];
    if (defaultInterruptOn) {
      generalPurposeMiddleware.push(
        humanInTheLoopMiddleware({ interruptOn: defaultInterruptOn }),
      );
    }

    const gpSpec: SubAgent = {
      name: "general-purpose",
      description: DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
      model: defaultModel,
      systemPrompt: DEFAULT_SUBAGENT_PROMPT,
      tools: defaultTools as any,
      middleware: generalPurposeMiddleware,
    };

    agents["general-purpose"] = createSubAgent(gpSpec);
    specsByName["general-purpose"] = gpSpec;
    subagentDescriptions.push(
      describeSubagentForTool(
        "general-purpose",
        DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
        false,
      ),
    );
  }

  for (const agentParams of subagents) {
    const rawMode = agentParams.mode;
    if (rawMode != null && rawMode !== "handoff" && rawMode !== "fork") {
      throw new Error(
        `SubAgent '${agentParams.name}' has invalid mode '${rawMode}' — must be "handoff" or "fork".`,
      );
    }

    const forked = isForkedSubAgent(agentParams);
    const compiled = "runnable" in agentParams;

    subagentDescriptions.push(
      describeSubagentForTool(
        agentParams.name,
        agentParams.description,
        forked,
        compiled,
      ),
    );

    if ("runnable" in agentParams) {
      agents[agentParams.name] = agentParams.runnable;
      specsByName[agentParams.name] = agentParams;
      if (forked) forkModeNames.add(agentParams.name);
    } else if (forked) {
      // Cast around the `skills?: undefined` type guard to check it at runtime too.
      const rawSkills = (agentParams as { skills?: unknown }).skills;
      if (Array.isArray(rawSkills) && rawSkills.length > 0) {
        throw new Error(
          `ForkedSubAgent '${agentParams.name}' cannot set skills; the parent's system message would discard it.`,
        );
      }
      // The static systemPrompt is just a construction-time baseline; forkSystemMessageMiddleware overrides it every call.
      const resolvedSpec: SubAgent = {
        ...agentParams,
        systemPrompt: parentSystemPrompt ?? "",
        mode: undefined,
        model: agentParams.model ?? defaultModel,
        tools: agentParams.tools ?? defaultTools,
        middleware: [
          ...defaultSubagentMiddleware,
          ...(agentParams.middleware ?? []),
          createForkSystemMessageMiddleware(),
          createForkTaskToolMiddleware(mirroredTaskTool),
        ],
        interruptOn: agentParams.interruptOn ?? defaultInterruptOn ?? undefined,
      };
      agents[agentParams.name] = createSubAgent(resolvedSpec);
      specsByName[agentParams.name] = resolvedSpec;
      forkModeNames.add(agentParams.name);
    } else {
      // Plain SubAgent — never forks, keeps its own prompt untouched.
      const resolvedSpec: SubAgent = {
        ...agentParams,
        mode: "handoff",
        model: agentParams.model ?? defaultModel,
        tools: agentParams.tools ?? defaultTools,
        middleware: [
          ...defaultSubagentMiddleware,
          ...(agentParams.middleware ?? []),
        ],
        interruptOn: agentParams.interruptOn ?? defaultInterruptOn ?? undefined,
      };
      agents[agentParams.name] = createSubAgent(resolvedSpec);
      specsByName[agentParams.name] = resolvedSpec;
    }
  }

  return {
    agents,
    specsByName,
    descriptions: subagentDescriptions,
    forkModeNames,
  };
}

/**
 * Create the task tool for invoking subagents
 */
function createTaskTool(options: {
  defaultModel: LanguageModelLike | string;
  defaultTools: StructuredTool[];
  defaultMiddleware: AgentMiddleware[] | null;
  generalPurposeMiddleware: AgentMiddleware[] | null;
  defaultInterruptOn: Record<string, boolean | InterruptOnConfig> | null;
  subagents: (SubAgent | CompiledSubAgent | ForkedSubAgent)[];
  generalPurposeAgent: boolean;
  taskDescription: string | null;
  parentSystemPrompt?: string | SystemMessage | null;
}) {
  const {
    defaultModel,
    defaultTools,
    defaultMiddleware,
    generalPurposeMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
    taskDescription,
    parentSystemPrompt = null,
  } = options;

  // Computed from raw specs so the mirrored task tool below shares this exact description string.
  const subagentNames = [
    ...(generalPurposeAgent ? ["general-purpose"] : []),
    ...subagents.map((spec) => spec.name),
  ];
  const subagentDescriptions = [
    ...(generalPurposeAgent
      ? [
          describeSubagentForTool(
            "general-purpose",
            DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
            false,
          ),
        ]
      : []),
    ...subagents.map((spec) =>
      describeSubagentForTool(
        spec.name,
        spec.description,
        isForkedSubAgent(spec),
        "runnable" in spec,
      ),
    ),
  ];

  const finalTaskDescription = taskDescription
    ? taskDescription
    : getTaskToolDescription(subagentDescriptions);

  // Populated below by getSubagents(); runTask only reads these once actually invoked.
  let subagentGraphs: Record<string, ReactAgent | Runnable> = {};
  let specsByName: Record<string, SubAgent | CompiledSubAgent> = {};
  let forkModeNames: Set<string> = new Set();

  function selectSubagent(
    subagentType: string,
    config: Record<string, any>,
  ): Runnable {
    const spec = specsByName[subagentType];

    const responseFormat =
      config.configurable?.[SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY];
    if (responseFormat != null && "runnable" in spec) {
      throw new Error(
        `responseSchema cannot be used with compiled subagent "${spec.name}"; ` +
          "dynamic schemas require a declarative SubAgent spec.",
      );
    }
    if ("runnable" in spec || responseFormat == null) {
      return subagentGraphs[subagentType] as Runnable;
    }

    return createSubAgent(spec, { responseFormat }) as unknown as Runnable;
  }

  async function runTask(
    input: { description: string; subagent_type: string },
    config: Record<string, any>,
  ): Promise<Command | string> {
    const { description, subagent_type } = input;

    const currentState = getCurrentTaskInput<Record<string, unknown>>();
    if (currentState[FORKED_CONTEXT_KEY]) {
      return FORK_RECURSION_REFUSAL;
    }

    if (!(subagent_type in subagentGraphs)) {
      const allowedTypes = Object.keys(subagentGraphs)
        .map((k) => `\`${k}\``)
        .join(", ");
      throw new Error(
        `Error: invoked agent of type ${subagent_type}, the only allowed types are ${allowedTypes}`,
      );
    }

    const shouldFork = forkModeNames.has(subagent_type);

    const subagent = selectSubagent(subagent_type, config);

    const subagentState = filterStateForSubagent(currentState);

    if (shouldFork) {
      const trimmed = stripInFlightAIMessage(
        (currentState.messages as BaseMessage[]) ?? [],
      );
      const effective = getEffectiveMessages(trimmed, currentState);
      subagentState.messages = [
        ...effective,
        new HumanMessage({ content: FORK_TASK_PREAMBLE + description }),
      ];
      const spec = specsByName[subagent_type];
      const parentSystemMessage = currentState[PARENT_SYSTEM_MESSAGE_KEY];
      if (parentSystemMessage != null && !("runnable" in spec)) {
        subagentState[PARENT_SYSTEM_MESSAGE_KEY] = parentSystemMessage;
      }
    } else {
      subagentState.messages = [new HumanMessage({ content: description })];
    }
    subagentState._summarizationSessionId = `session_${crypto.randomUUID().substring(0, 8)}`;

    const subagentConfig = {
      ...config,
      metadata: {
        ...config.metadata,
        lc_agent_name: subagent_type,
      },
      configurable: {
        ...config.configurable,
        ls_agent_type: "subagent",
      },
    };
    const result = (await subagent.invoke(
      subagentState,
      subagentConfig,
    )) as Record<string, unknown>;

    if (!config.toolCall?.id) {
      if (result.structuredResponse != null) {
        return JSON.stringify(result.structuredResponse);
      }
      const messages = result.messages as BaseMessage[];
      const lastMessage = messages?.[messages.length - 1];
      let content: string | ContentBlock[] =
        lastMessage?.content || "Task completed";
      if (Array.isArray(content)) {
        content = content.filter(
          (block) => !INVALID_TOOL_MESSAGE_BLOCK_TYPES.includes(block.type),
        );
        if (content.length === 0) {
          return "Task completed";
        }
        return content
          .map((block) =>
            "text" in block ? block.text : JSON.stringify(block),
          )
          .join("\n");
      }
      return content;
    }

    return returnCommandWithStateUpdate(result, config.toolCall.id);
  }

  const taskToolSchema = z.object({
    description: z
      .string()
      .describe("The task to execute with the selected agent"),
    subagent_type: z
      .string()
      .describe(
        `Name of the agent to use. Available: ${subagentNames.join(", ")}`,
      ),
  });

  const taskTool = tool(runTask, {
    name: "task",
    description: finalTaskDescription,
    schema: taskToolSchema,
  });

  // A separate wrapper around the same name/description/schema/function, not the same object — see createForkTaskToolMiddleware.
  const mirroredTaskTool = tool(runTask, {
    name: "task",
    description: finalTaskDescription,
    schema: taskToolSchema,
  });

  const {
    agents,
    specsByName: resolvedSpecsByName,
    forkModeNames: resolvedForkModeNames,
  } = getSubagents({
    defaultModel,
    defaultTools,
    defaultMiddleware,
    generalPurposeMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
    parentSystemPrompt,
    mirroredTaskTool,
  });

  subagentGraphs = agents;
  specsByName = resolvedSpecsByName;
  forkModeNames = resolvedForkModeNames;

  return taskTool;
}

/**
 * Options for creating subagent middleware
 */
export interface SubAgentMiddlewareOptions {
  /** The model to use for subagents */
  defaultModel: LanguageModelLike | string;
  /** The tools to use for the default general-purpose subagent */
  defaultTools?: StructuredTool[];
  /** Default middleware to apply to custom subagents (WITHOUT skills from main agent) */
  defaultMiddleware?: AgentMiddleware[] | null;
  /**
   * Middleware specifically for the general-purpose subagent (includes skills from main agent).
   * If not provided, falls back to defaultMiddleware.
   */
  generalPurposeMiddleware?: AgentMiddleware[] | null;
  /** The tool configs for the default general-purpose subagent */
  defaultInterruptOn?: Record<string, boolean | InterruptOnConfig> | null;
  /** A list of additional subagents to provide to the agent */
  subagents?: (SubAgent | CompiledSubAgent | ForkedSubAgent)[];
  /** Full system prompt override */
  systemPrompt?: string | null;
  /** Whether to include the general-purpose agent */
  generalPurposeAgent?: boolean;
  /** Custom description for the task tool */
  taskDescription?: string | null;
  /** Inherited by `ForkedSubAgent`s and `mode: "fork"` compiled subagents */
  parentSystemPrompt?: string | SystemMessage | null;
}

/**
 * Create subagent middleware with task tool
 */
export function createSubAgentMiddleware(options: SubAgentMiddlewareOptions) {
  const {
    defaultModel,
    defaultTools = [],
    defaultMiddleware = null,
    generalPurposeMiddleware = null,
    defaultInterruptOn = null,
    subagents = [],
    systemPrompt = null,
    generalPurposeAgent = true,
    taskDescription = null,
    parentSystemPrompt = null,
  } = options;

  const taskTool = createTaskTool({
    defaultModel,
    defaultTools,
    defaultMiddleware,
    generalPurposeMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
    taskDescription,
    parentSystemPrompt,
  });

  return createMiddleware({
    name: "subAgentMiddleware",
    tools: [taskTool],
    wrapModelCall: async (request, handler) => {
      if (systemPrompt !== null) {
        return handler({
          ...request,
          systemMessage: request.systemMessage.concat(
            new SystemMessage({ content: systemPrompt }),
          ),
        });
      }
      return handler(request);
    },
  });
}
