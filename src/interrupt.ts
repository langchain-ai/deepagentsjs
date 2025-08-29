import type { DeepAgentStateType, ToolInterruptConfig } from "./types.js";
import { interrupt } from "@langchain/langgraph";
import { isAIMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import {
  HumanInterrupt,
  HumanResponse,
  ActionRequest,
  HumanInterruptConfig,
} from "@langchain/langgraph/prebuilt";

export function createInterruptHook(
  toolConfigs: ToolInterruptConfig,
  messagePrefix: string = "Tool execution requires approval",
): (state: DeepAgentStateType) => Promise<Partial<DeepAgentStateType> | void> {
  /**
   * Create a post model hook that handles interrupts using native LangGraph schemas.
   *
   * Args:
   *   toolConfigs: Record mapping tool names to HumanInterruptConfig objects
   *   messagePrefix: Optional message prefix for interrupt descriptions
   */

  Object.entries(toolConfigs).forEach(([tool, interruptConfig]) => {
    if (
      interruptConfig &&
      typeof interruptConfig === "object" &&
      interruptConfig.allow_ignore
    ) {
      throw new Error(
        `For ${tool} we get allow_ignore = true - we currently don't support ignore.`,
      );
    }
  });

  return async function interruptHook(
    state: DeepAgentStateType,
  ): Promise<Partial<DeepAgentStateType> | void> {
    const messages = state.messages || [];
    if (!messages.length) {
      return;
    }

    const lastMessage = messages[messages.length - 1];
    if (
      !isAIMessage(lastMessage) ||
      !lastMessage.tool_calls ||
      !lastMessage.tool_calls.length
    ) {
      return;
    }

    const interruptToolCalls: ToolCall[] = [];
    const autoApprovedToolCalls: ToolCall[] = [];

    for (const toolCall of lastMessage.tool_calls) {
      const toolName = toolCall.name;
      if (toolName in toolConfigs) {
        interruptToolCalls.push(toolCall);
      } else {
        autoApprovedToolCalls.push(toolCall);
      }
    }

    if (!interruptToolCalls.length) {
      return;
    }

    const approvedToolCalls = [...autoApprovedToolCalls];

    if (interruptToolCalls.length > 1) {
      throw new Error(
        "Right now, interrupt hook only works when one tool requires interrupts",
      );
    }

    const toolCall = interruptToolCalls[0];
    const toolName = toolCall.name;
    const toolArgs = toolCall.args;
    const description = `${messagePrefix}\n\nTool: ${toolName}\nArgs: ${JSON.stringify(toolArgs, null, 2)}`;
    const toolConfig = toolConfigs[toolName];

    const defaultToolConfig: HumanInterruptConfig = {
      allow_accept: true,
      allow_edit: true,
      allow_respond: true,
      allow_ignore: false,
    };

    const request: HumanInterrupt = {
      action_request: {
        action: toolName,
        args: toolArgs,
      },
      config: typeof toolConfig === "object" ? toolConfig : defaultToolConfig,
      description: description,
    };

    const res: HumanResponse | HumanResponse[] = await interrupt([request]);
    const responses = Array.isArray(res) ? res : [res];
    if (responses.length !== 1) {
      throw new Error(`Expected a list of one response, got ${responses}`);
    }

    const response = responses[0];

    if (response.type === "accept") {
      approvedToolCalls.push(toolCall);
    } else if (response.type === "edit") {
      const edited = response.args as ActionRequest;
      const newToolCall = {
        name: edited.action,
        args: edited.args,
        id: toolCall.id,
      };
      approvedToolCalls.push(newToolCall);
    } else if (response.type === "response") {
      if (!toolCall.id) {
        throw new Error("Tool call must have an ID for response type");
      }
      const responseMessage = new ToolMessage({
        tool_call_id: toolCall.id,
        content: response.args as string,
      });
      return { messages: [responseMessage] };
    } else {
      throw new Error(`Unknown response type: ${response.type}`);
    }

    const updatedLastMessage = new AIMessage({
      ...lastMessage,
      tool_calls: approvedToolCalls,
    });

    return { messages: [updatedLastMessage] };
  };
}
