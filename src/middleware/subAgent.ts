/**
 * Middleware for providing subagents to an agent via a `task` tool.
 */

import {
  createMiddleware,
  AgentMiddleware,
  ToolMessage,
  tool,
  StructuredTool,
  createAgent,
  humanInTheLoopMiddleware,
  HumanInTheLoopMiddlewareConfig,
  ReactAgent,
} from "langchain";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { LanguageModelLike } from "@langchain/core/language_models/base";
import {
  DEFAULT_SUBAGENT_PROMPT,
  DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
  TASK_TOOL_DESCRIPTION,
  TASK_SYSTEM_PROMPT,
} from "./subAgent.prompts.js";

// State keys that should be excluded when passing state to subagents
const EXCLUDED_STATE_KEYS = ["messages", "todos", "jumpTo"];

// Type definitions
export interface SubAgent {
  name: string;
  description: string;
  systemPrompt: string;
  tools: StructuredTool[];
  model?: string | LanguageModelLike;
  middleware?: AgentMiddleware[];
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
}

export interface CompiledSubAgent {
  name: string;
  description: string;
  runnable: ReactAgent;
}

interface InterruptOnConfig {
  enabled: boolean;
  // Additional properties as needed
}

type MiddlewareInterruptOn = Exclude<
  HumanInTheLoopMiddlewareConfig["interruptOn"],
  undefined
>;

/**
 * Create subagent instances from specifications.
 */
function _getSubagents({
  defaultModel,
  defaultTools,
  defaultMiddleware,
  defaultInterruptOn,
  subagents,
  generalPurposeAgent,
}: {
  defaultModel: string | LanguageModelLike;
  defaultTools: StructuredTool[];
  defaultMiddleware: AgentMiddleware[] | null;
  defaultInterruptOn: MiddlewareInterruptOn | null;
  subagents: (SubAgent | CompiledSubAgent)[];
  generalPurposeAgent: boolean;
}): {
  subagentGraphs: Record<string, ReactAgent>;
  subagentDescriptions: string[];
} {
  // Use empty list if null (no default middleware)
  const defaultSubagentMiddleware = defaultMiddleware || [];

  const subagentGraphs: Record<string, ReactAgent> = {};
  const subagentDescriptions: string[] = [];

  // Create general-purpose agent if enabled
  if (generalPurposeAgent) {
    const generalPurposeMiddleware = [...defaultSubagentMiddleware];
    if (defaultInterruptOn) {
      generalPurposeMiddleware.push(
        humanInTheLoopMiddleware({ interruptOn: defaultInterruptOn })
      );
    }

    subagentGraphs["general-purpose"] = createAgent({
      model: defaultModel,
      systemPrompt: DEFAULT_SUBAGENT_PROMPT,
      tools: defaultTools,
      middleware: generalPurposeMiddleware,
    });
    subagentDescriptions.push(
      `- general-purpose: ${DEFAULT_GENERAL_PURPOSE_DESCRIPTION}`
    );
  }

  // Process custom subagents
  for (const agent of subagents) {
    subagentDescriptions.push(`- ${agent.name}: ${agent.description}`);

    if ("runnable" in agent) {
      const customAgent = agent as CompiledSubAgent;
      subagentGraphs[customAgent.name] = customAgent.runnable;
      continue;
    }

    const typedAgent = agent as SubAgent;
    const tools = typedAgent.tools || defaultTools;
    const model = typedAgent.model || defaultModel;

    let middleware = [...defaultSubagentMiddleware];
    if (typedAgent.middleware) {
      middleware = [...defaultSubagentMiddleware, ...typedAgent.middleware];
    }

    subagentGraphs[typedAgent.name] = createAgent({
      model,
      systemPrompt: typedAgent.systemPrompt,
      tools,
      middleware,
      checkpointer: false,
    });
  }

  return { subagentGraphs, subagentDescriptions };
}

/**
 * Create a task tool for invoking subagents.
 */
export function createTaskTool({
  defaultModel,
  defaultTools,
  defaultMiddleware,
  defaultInterruptOn,
  subagents,
  generalPurposeAgent,
  taskDescription,
}: {
  defaultModel: string | LanguageModelLike;
  defaultTools: StructuredTool[];
  defaultMiddleware: AgentMiddleware[] | null;
  defaultInterruptOn: MiddlewareInterruptOn | null;
  subagents: (SubAgent | CompiledSubAgent)[];
  generalPurposeAgent: boolean;
  taskDescription?: string;
}): [StructuredTool, { subgraphs: any[] }] {
  const { subagentGraphs, subagentDescriptions } = _getSubagents({
    defaultModel,
    defaultTools,
    defaultMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
  });

  const subagentDescriptionStr = subagentDescriptions.join("\n");

  function _returnCommandWithStateUpdate(
    result: Record<string, any>,
    toolCallId: string
  ): Command {
    const stateUpdate: Record<string, any> = {};

    // Filter out excluded keys
    for (const [k, v] of Object.entries(result)) {
      if (!EXCLUDED_STATE_KEYS.includes(k)) stateUpdate[k] = v;
    }

    return new Command({
      update: {
        ...stateUpdate,
        messages: [
          new ToolMessage({
            content: result.messages[result.messages.length - 1].content,
            tool_call_id: toolCallId,
          }),
        ],
      },
    });
  }

  function _validateAndPrepareState(
    subagentType: string,
    description: string,
    runtime: RunnableConfig
  ): { subagent: ReactAgent; subagentState: any } {
    if (!(subagentType in subagentGraphs)) {
      const allowedTypes = Object.keys(subagentGraphs).map((k) => `\`${k}\``);
      throw new Error(
        `Invoked agent of type "${subagentType}", the only allowed types are "${allowedTypes}"`
      );
    }

    const state = getCurrentTaskInput(runtime) as Record<string, unknown>;
    const subagent = subagentGraphs[subagentType];

    // Create a new state dict to avoid mutating the original
    const subagentState: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(state)) {
      if (!EXCLUDED_STATE_KEYS.includes(k)) subagentState[k] = v;
    }

    subagentState.messages = [new HumanMessage(description)];
    return { subagent, subagentState };
  }

  // Use custom description if provided, otherwise use default template
  let finalTaskDescription = taskDescription;
  if (!finalTaskDescription) {
    finalTaskDescription = TASK_TOOL_DESCRIPTION.replace(
      "{available_agents}",
      subagentDescriptionStr
    );
  } else if (finalTaskDescription.includes("{available_agents}")) {
    // If custom description has placeholder, format with agent descriptions
    finalTaskDescription = finalTaskDescription.replace(
      "{available_agents}",
      subagentDescriptionStr
    );
  }

  // Create the task tool
  return [
    tool(
      async (input: { description: string; subagent_type: string }, config) => {
        const toolCallId = config.toolCall?.id;

        if (!toolCallId) {
          throw new Error("Tool call ID is required for subagent invocation");
        }

        const { subagent, subagentState } = _validateAndPrepareState(
          input.subagent_type,
          input.description,
          config
        );

        const result = await subagent.invoke(subagentState);
        return _returnCommandWithStateUpdate(result, toolCallId);
      },
      {
        name: "task",
        description: finalTaskDescription,
        schema: z.object({
          description: z
            .string()
            .describe("Detailed task description for the subagent to perform"),
          subagent_type: z
            .string()
            .describe("Type of subagent to use for this task"),
        }),
      }
    ),
    { subgraphs: Object.values(subagentGraphs).map((graph) => graph.graph) },
  ];
}

/**
 * Middleware for providing subagents to an agent via a `task` tool.
 *
 * This middleware adds a `task` tool to the agent that can be used to invoke subagents.
 * Subagents are useful for handling complex tasks that require multiple steps, or tasks
 * that require a lot of context to resolve.
 */
export const subAgentMiddleware = ({
  defaultModel,
  defaultTools = [],
  defaultMiddleware = null,
  defaultInterruptOn = null,
  subagents = [],
  systemPrompt = TASK_SYSTEM_PROMPT,
  generalPurposeAgent = true,
  taskDescription,
}: {
  defaultModel: string | LanguageModelLike;
  defaultTools?: StructuredTool[];
  defaultMiddleware?: AgentMiddleware[] | null;
  defaultInterruptOn?: MiddlewareInterruptOn | null;
  subagents?: (SubAgent | CompiledSubAgent)[];
  systemPrompt?: string;
  generalPurposeAgent?: boolean;
  taskDescription?: string;
}): AgentMiddleware => {
  const [taskTool, toolNodeOptions] = createTaskTool({
    defaultModel,
    defaultTools,
    defaultMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
    taskDescription,
  });

  return createMiddleware({
    name: "subAgentMiddleware",
    tools: [taskTool],
    toolNodeOptions,
    wrapModelCall: async (request, handler) => {
      if (systemPrompt) {
        request.systemPrompt = request.systemPrompt
          ? request.systemPrompt + "\n\n" + systemPrompt
          : systemPrompt;
      }
      return handler(request);
    },
  });
};
