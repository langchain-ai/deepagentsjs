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

/**
 * State keys that are excluded when passing state to subagents and when returning
 * updates from subagents.
 *
 * When returning updates:
 * 1. The messages key is handled explicitly to ensure only the final message is included
 * 2. The todos and structuredResponse keys are excluded as they do not have a defined reducer
 *    and no clear meaning for returning them from a subagent to the main agent.
 * 3. The skillsMetadata and memoryContents keys are automatically excluded from subagent output
 *    to prevent parent state from leaking to child agents. Each agent loads its own skills/memory
 *    independently based on its middleware configuration.
 */
const EXCLUDED_STATE_KEYS = [
  "messages",
  "todos",
  "structuredResponse",
  "skillsMetadata",
  "memoryContents",
] as const;

/**
 * Default description for the general-purpose subagent.
 * This description is shown to the model when selecting which subagent to use.
 */
export const DEFAULT_GENERAL_PURPOSE_DESCRIPTION =
  "General-purpose agent for researching complex questions, searching for files and content, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. This agent has access to all tools as the main agent.";

function getTaskToolDescription(subagentDescriptions: string[]): string {
  return context`
    Launch an ephemeral subagent to handle a complex, multi-step task in an isolated context window.

    Available agent types and the tools they have access to:
    ${subagentDescriptions.join("\n")}

    Specify subagent_type to select the agent. Usage notes:
    - Launch multiple agents concurrently when their tasks are independent, using a single message with multiple tool calls.
    - Each invocation is stateless: the agent sees only the prompt you give it and returns a single final report. Put full detail in the prompt and state exactly what it should return.
    - The agent's report is not shown to the user; relay a summary yourself.
    - Tell the agent whether to create content, analyze, or only research, since it cannot see the user's intent.
    - If an agent's description says to use it proactively, do so without waiting to be asked.
    - When only general-purpose is available, use it for any complex, context-heavy task; it has the same capabilities as the main agent.
  `;
}

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
}

/**
 * Specification for a subagent that can be dynamically created.
 *
 * When using `createDeepAgent`, subagents automatically receive a default middleware
 * stack (todoListMiddleware, filesystemMiddleware, summarizationMiddleware, etc.) before
 * any custom `middleware` specified in this spec.
 *
 * Required fields:
 * - `name`: Identifier used to select this subagent in the task tool
 * - `description`: Shown to the model for subagent selection
 * - `systemPrompt`: The system prompt for the subagent
 *
 * Optional fields:
 * - `model`: Override the default model for this subagent
 * - `tools`: Override the default tools for this subagent
 * - `middleware`: Additional middleware appended after defaults
 * - `interruptOn`: Human-in-the-loop configuration for specific tools
 * - `skills`: Skill source paths for SkillsMiddleware (e.g., `["/skills/user/", "/skills/project/"]`)
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
export interface SubAgent {
  /** Identifier used to select this subagent in the task tool */
  name: string;

  /** Description shown to the model for subagent selection */
  description: string;

  /** The system prompt to use for the agent */
  systemPrompt: string;

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
export const GENERAL_PURPOSE_SUBAGENT: Pick<
  SubAgent,
  "name" | "description" | "systemPrompt"
> = {
  name: "general-purpose",
  description: DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
  systemPrompt: DEFAULT_SUBAGENT_PROMPT,
} as const;

/**
 * Filter state to exclude certain keys when passing to subagents
 */
function filterStateForSubagent(
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
  options?: { responseFormat?: CreateAgentParams["responseFormat"] },
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
 * recompilation with dynamic response formats), and descriptions.
 */
function getSubagents(options: {
  defaultModel: LanguageModelLike | string;
  defaultTools: StructuredTool[];
  defaultMiddleware: AgentMiddleware[] | null;
  generalPurposeMiddleware: AgentMiddleware[] | null;
  defaultInterruptOn: Record<string, boolean | InterruptOnConfig> | null;
  subagents: (SubAgent | CompiledSubAgent)[];
  generalPurposeAgent: boolean;
}): {
  agents: Record<string, ReactAgent | Runnable>;
  specsByName: Record<string, SubAgent | CompiledSubAgent>;
  descriptions: string[];
} {
  const {
    defaultModel,
    defaultTools,
    defaultMiddleware,
    generalPurposeMiddleware: gpMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
  } = options;

  const defaultSubagentMiddleware = defaultMiddleware || [];
  const generalPurposeMiddlewareBase =
    gpMiddleware || defaultSubagentMiddleware;
  const agents: Record<string, ReactAgent | Runnable> = {};
  const specsByName: Record<string, SubAgent | CompiledSubAgent> = {};
  const subagentDescriptions: string[] = [];

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
      `- general-purpose: ${DEFAULT_GENERAL_PURPOSE_DESCRIPTION}`,
    );
  }

  for (const agentParams of subagents) {
    subagentDescriptions.push(
      `- ${agentParams.name}: ${agentParams.description}`,
    );

    if ("runnable" in agentParams) {
      agents[agentParams.name] = agentParams.runnable;
      specsByName[agentParams.name] = agentParams;
    } else {
      const resolvedSpec: SubAgent = {
        ...agentParams,
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

  return { agents, specsByName, descriptions: subagentDescriptions };
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
  } = options;

  const {
    agents: subagentGraphs,
    specsByName,
    descriptions: subagentDescriptions,
  } = getSubagents({
    defaultModel,
    defaultTools,
    defaultMiddleware,
    generalPurposeMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
  });

  function selectSubagent(
    subagentType: string,
    config: Record<string, any>,
  ): Runnable {
    const responseFormat =
      config.configurable?.[SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY];
    if (responseFormat != null) {
      const spec = specsByName[subagentType];
      if ("runnable" in spec) {
        throw new Error(
          `responseSchema cannot be used with compiled subagent "${spec.name}"; ` +
            "dynamic schemas require a declarative SubAgent spec.",
        );
      }
      return createSubAgent(spec, { responseFormat }) as unknown as Runnable;
    }
    return subagentGraphs[subagentType] as Runnable;
  }

  const finalTaskDescription = taskDescription
    ? taskDescription
    : getTaskToolDescription(subagentDescriptions);

  return tool(
    async (
      input: { description: string; subagent_type: string },
      config,
    ): Promise<Command | string> => {
      const { description, subagent_type } = input;

      if (!(subagent_type in subagentGraphs)) {
        const allowedTypes = Object.keys(subagentGraphs)
          .map((k) => `\`${k}\``)
          .join(", ");
        throw new Error(
          `Error: invoked agent of type ${subagent_type}, the only allowed types are ${allowedTypes}`,
        );
      }

      const subagent = selectSubagent(subagent_type, config);

      const currentState = getCurrentTaskInput<Record<string, unknown>>();
      const subagentState = filterStateForSubagent(currentState);
      subagentState.messages = [new HumanMessage({ content: description })];

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
    },
    {
      name: "task",
      description: finalTaskDescription,
      schema: z.object({
        description: z
          .string()
          .describe("The task to execute with the selected agent"),
        subagent_type: z
          .string()
          .describe(
            `Name of the agent to use. Available: ${Object.keys(subagentGraphs).join(", ")}`,
          ),
      }),
    },
  );
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
