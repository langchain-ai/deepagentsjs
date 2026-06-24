import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

function sanitizeForReplay(message: BaseMessage): BaseMessage {
  if (!AIMessage.isInstance(message)) return message;

  return new AIMessage({
    id: message.id,
    content: message.content,
    tool_calls: message.tool_calls,
    invalid_tool_calls: message.invalid_tool_calls,
    usage_metadata: message.usage_metadata,
  });
}

export const stripReasoningReplay = createMiddleware({
  name: "StripReasoningReplay",
  wrapModelCall: async (request, handler) =>
    handler({ ...request, messages: request.messages.map(sanitizeForReplay) }),
});
