import type {
  DeepAgentStateType,
  ToolInterruptConfig,
} from "./types.js";
import { interrupt } from "@langchain/langgraph";
import { isAIMessage, AIMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { HumanInterrupt, HumanResponse } from "@langchain/langgraph/prebuilt";

export function createInterruptHook(
  toolConfigs: ToolInterruptConfig,
  messagePrefix: string = "Tool execution requires approval",
): (state: DeepAgentStateType) => Promise<DeepAgentStateType> {
  /**
   * Create a post model hook that handles interrupts using native LangGraph schemas.
   *
   * Args:
   *   toolConfigs: Record mapping tool names to HumanInterruptConfig objects
   *   messagePrefix: Optional message prefix for interrupt descriptions
   */

  return async function interruptHook(
    state: DeepAgentStateType,
  ): Promise<DeepAgentStateType> {
    const messages = state.messages || [];
    if (!messages.length) {
      return state;
    }

    const lastMessage = messages[messages.length - 1];
    if (
      !isAIMessage(lastMessage) ||
      !lastMessage.tool_calls ||
      !lastMessage.tool_calls.length
    ) {
      return state;
    }

    // Separate tool calls that need interrupts from those that don't
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
      return state;
    }

    const approvedToolCalls = [...autoApprovedToolCalls];

    const requests: HumanInterrupt[] = [];

    for (const toolCall of interruptToolCalls) {
      const toolName = toolCall.name;
      const toolArgs = toolCall.args;
      const description = `${messagePrefix}\n\nTool: ${toolName}\nArgs: ${JSON.stringify(toolArgs, null, 2)}`;
      const toolConfig = toolConfigs[toolName];

      const request: HumanInterrupt = {
        action_request: {
          action: toolName,
          args: toolArgs,
        },
        config: toolConfig,
        description: description,
      };
      requests.push(request);
    }

    const responses = await interrupt<
      HumanInterrupt[],
      HumanResponse[]
    >(requests);

    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      const toolCall = interruptToolCalls[i];

      if (response.type === "accept") {
        approvedToolCalls.push(toolCall);
      } else if (response.type === "edit" && response.args && typeof response.args === "object" && response.args !== null && "args" in response.args) {
        const edited = response.args;
        const newToolCall = {
          name: toolCall.name,
          args: edited.args,
          id: toolCall.id,
        };
        approvedToolCalls.push(newToolCall);
      } else if (response.type === "ignore") {
        continue;
      } else if (response.type === "response") {
        // continue here since it's a direct feedback
        continue;
      } else {
        throw new Error(`Unknown response type: ${response.type}`);
      }
    }

    const updatedLastMessage = new AIMessage({
      ...lastMessage,
      tool_calls: approvedToolCalls,
    });

    return {
      ...state,
      messages: [...state.messages.slice(0, -1), updatedLastMessage],
    };
  };
}
