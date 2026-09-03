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
import { appendToSystemMessage } from "./utils.js";

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

// Marks a fork's own state so the task tool can refuse recursive delegation.
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
  FORKED_CONTEXT_KEY,
] as const;

/**
 * State keys excluded when inheriting state into a declarative fork.
 * Narrower than `EXCLUDED_STATE_KEYS`: a fork's mirrored middleware needs
 * the parent's private channels (skills metadata, memory contents, etc.)
 * to rebuild an equivalent prompt.
 */
const FORK_EXCLUDED_STATE_KEYS = [
  "structuredResponse",
  "_summarizationEvent",
  "_summarizationSessionId",
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

const FORKED_SUBAGENT_TOOL_NOTE =
  " (inherits your full conversation and system prompt — no need to restate context here)";

// A compiled fork's runnable owns its own system prompt (see CompiledSubAgent.mode).
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
   * `"isolated"` (default) only sees the delegated task.
   */
  mode?: "isolated" | "fork";
}

/**
 * Specification for a declarative subagent.
 *
 * When using `createDeepAgent`, subagents automatically receive a default middleware
 * stack (filesystemMiddleware, summarizationMiddleware, etc.) before any custom
 * `middleware` specified in this spec. Add `todoListMiddleware` explicitly to opt in.
 *
 * By default the subagent is isolated — it only ever sees the delegated task
 * description, never the parent's conversation. Setting `mode: "fork"` makes
 * it continue the parent's conversation instead.
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
 *
 * @experimental `mode: "fork"` is experimental and subject to change.
 */
export interface SubAgent {
  /** Identifier used to select this subagent in the task tool */
  name: string;

  /** Description shown to the model for subagent selection */
  description: string;

  /**
   * The system prompt for the agent. Falls back to an empty prompt if
   * omitted. Under `mode: "fork"`, this is appended to the parent's
   * inherited prompt rather than replacing it.
   */
  systemPrompt?: string | SystemMessage;

  /**
   * Context mode. `"isolated"` (default) only sees the delegated task.
   * `"fork"` inherits the parent's conversation history and mirrors the
   * parent's prompt-producing middleware (skills, memory, custom middleware)
   * so it rebuilds an equivalent system prompt — the tradeoff is cache
   * misses if this subagent's own `model` differs from the parent's. Cannot
   * declare `skills` under `mode: "fork"`; the parent's skills are inherited
   * instead.
   */
  mode?: "isolated" | "fork";

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
 * A {@link SubAgent} with `mode: "fork"`.
 *
 * @deprecated Kept as a named type for backward compatibility with code that imported
 * `ForkedSubAgent` before it merged into `SubAgent` — not a distinct shape
 * with its own constraints (a fork can now declare its own `systemPrompt`,
 * same as any `SubAgent`). Prefer `SubAgent` with `mode: "fork"` in new code.
 */
export interface ForkedSubAgent extends SubAgent {
  mode: "fork";
}

/**
 * Whether a declarative subagent spec has `mode: "fork"` set.
 *
 * A plain boolean, not a type predicate: `SubAgent` covers both `"fork"` and
 * `"isolated"`, so there's no distinct type left to narrow to.
 */
export function isForkedSubAgent(value: unknown): boolean {
  if (typeof value !== "object" || value == null) return false;
  if (!("mode" in value)) return false;
  return value.mode === "fork";
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
  mode: "isolated",
} as const;

function filterState(
  state: Record<string, unknown>,
  excludedKeys: readonly string[],
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!excludedKeys.includes(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Filter state to exclude certain keys when passing to subagents
 */
export function filterStateForSubagent(
  state: Record<string, unknown>,
): Record<string, unknown> {
  return filterState(state, EXCLUDED_STATE_KEYS);
}

/**
 * Filter state to exclude only the keys a declarative fork must not resume
 * (structured response, summarization event/session) — see
 * `FORK_EXCLUDED_STATE_KEYS`.
 */
export function filterStateForFork(
  state: Record<string, unknown>,
): Record<string, unknown> {
  return filterState(state, FORK_EXCLUDED_STATE_KEYS);
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
    // Walk back to the last AIMessage with non-empty text and forward only that
    // text as a string. Anthropic sometimes emits a trailing empty `end_turn`
    // AIMessage after a final tool call, which would otherwise be forwarded as
    // an empty ToolMessage.
    const messages = (result.messages as BaseMessage[]) ?? [];
    content = "Task completed";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || !AIMessage.isInstance(message)) continue;
      const text =
        typeof message.content === "string"
          ? message.content.trim()
          : (message.text?.trim() ?? "");
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

const ForkedContextStateSchema = z.object({
  [FORKED_CONTEXT_KEY]: z.boolean().optional(),
});

// Flag must be set via beforeAgent, not the initial invoke() input —
// getCurrentTaskInput() won't see it otherwise.
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
 * Resolve a fork's system prompt: the parent's inherited prompt, with the
 * fork's own systemPrompt (if any) appended as an addendum rather than
 * replacing it.
 */
function resolveForkSystemPrompt(
  parentSystemPrompt: string | SystemMessage | null,
  forkAddendum: string | SystemMessage | undefined,
): string | SystemMessage {
  if (!forkAddendum) return parentSystemPrompt ?? "";
  const addendumText =
    typeof forkAddendum === "string" ? forkAddendum : forkAddendum.text;
  if (SystemMessage.isInstance(parentSystemPrompt)) {
    return appendToSystemMessage(parentSystemPrompt, addendumText);
  }
  return parentSystemPrompt
    ? `${parentSystemPrompt}\n\n${addendumText}`
    : addendumText;
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
  subagents: (SubAgent | CompiledSubAgent)[];
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

  // Prevent a duplicate name from silently resolving to the last spec.
  const seenNames = new Set<string>(
    generalPurposeAgent ? ["general-purpose"] : [],
  );
  for (const agentParams of subagents) {
    if (seenNames.has(agentParams.name)) {
      throw new Error(
        `Duplicate subagent name '${agentParams.name}'; each subagent must have a unique name.`,
      );
    }
    seenNames.add(agentParams.name);
  }

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
    // Widened to string: a plain-JS/`as any` caller can still pass the
    // legacy "handoff" value, which no longer appears in the type itself.
    const rawMode = agentParams.mode as string | undefined;
    if (
      rawMode != null &&
      rawMode !== "isolated" &&
      rawMode !== "fork" &&
      rawMode !== "handoff" // legacy alias for "isolated"
    ) {
      throw new Error(
        `SubAgent '${agentParams.name}' has invalid mode '${rawMode}' — must be "isolated" or "fork".`,
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
      continue;
    }

    const subagentMiddleware = [
      ...defaultSubagentMiddleware,
      ...(agentParams.middleware ?? []),
    ];

    if (forked) {
      // Re-check at runtime — the type guard doesn't stop a plain-JS/`as any` caller.
      const rawSkills = (agentParams as { skills?: unknown }).skills;
      if (Array.isArray(rawSkills) && rawSkills.length > 0) {
        throw new Error(
          `SubAgent '${agentParams.name}' cannot set skills under mode: "fork"; the parent's skills are inherited instead.`,
        );
      }
      // The fork's own systemPrompt (if any) is an addendum appended to the
      // parent's inherited prompt, not a replacement — mirrors createDeepAgent's
      // main-loop merge logic for a declarative fork's own spec.
      const resolvedSystemPrompt = resolveForkSystemPrompt(
        parentSystemPrompt,
        agentParams.systemPrompt,
      );
      // Splice after Filesystem (always present) to match the parent's tool
      // order for prompt-cache parity.
      const fsIndex = subagentMiddleware.findIndex(
        (m) => m.name === "FilesystemMiddleware",
      );
      subagentMiddleware.splice(
        fsIndex + 1,
        0,
        createForkTaskToolMiddleware(mirroredTaskTool),
      );
      const resolvedSpec: SubAgent = {
        ...agentParams,
        systemPrompt: resolvedSystemPrompt,
        mode: undefined,
        model: agentParams.model ?? defaultModel,
        tools: agentParams.tools ?? defaultTools,
        middleware: subagentMiddleware,
        interruptOn: agentParams.interruptOn ?? defaultInterruptOn ?? undefined,
      };
      agents[agentParams.name] = createSubAgent(resolvedSpec);
      specsByName[agentParams.name] = resolvedSpec;
      forkModeNames.add(agentParams.name);
    } else {
      // Plain SubAgent — never forks, keeps its own prompt untouched.
      const resolvedSpec: SubAgent = {
        ...agentParams,
        mode: "isolated",
        model: agentParams.model ?? defaultModel,
        tools: agentParams.tools ?? defaultTools,
        middleware: subagentMiddleware,
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
  subagents: (SubAgent | CompiledSubAgent)[];
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

    // Compiled runnables are opaque, so only declarative forks get the wider filter.
    const spec = specsByName[subagent_type];
    const isDeclarativeFork = shouldFork && !("runnable" in spec);

    const subagentState = isDeclarativeFork
      ? filterStateForFork(currentState)
      : filterStateForSubagent(currentState);

    if (shouldFork) {
      const trimmed = stripInFlightAIMessage(
        (currentState.messages as BaseMessage[]) ?? [],
      );
      const effective = getEffectiveMessages(trimmed, currentState);
      subagentState.messages = [
        ...effective,
        new HumanMessage({ content: FORK_TASK_PREAMBLE + description }),
      ];
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

  // Separate object, not the same tool instance — see createForkTaskToolMiddleware.
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
  subagents?: (SubAgent | CompiledSubAgent)[];
  /** Full system prompt override */
  systemPrompt?: string | null;
  /** Whether to include the general-purpose agent */
  generalPurposeAgent?: boolean;
  /** Custom description for the task tool */
  taskDescription?: string | null;
  /** Inherited by a `mode: "fork"` declarative or compiled subagent */
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
