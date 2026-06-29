import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

/**
 * Rebuild prior assistant messages so the Responses API doesn't replay stale
 * item ids.
 *
 * Over the Responses API, `@langchain/openai` replays an assistant turn either
 * from `response_metadata.output` (the raw response items) or by reconstructing
 * items from `additional_kwargs` — both of which carry ids (reasoning items,
 * function-call items). After a round-trip through the checkpointer those ids
 * can come back empty, and OpenAI rejects the next call with
 * `400 Invalid 'input[..].id': ''`.
 *
 * We rebuild each prior assistant message from just its `content` and
 * `tool_calls`. Tool calls keep their `call_id` (the valid pairing key), the
 * converter emits clean items with no stale ids, and reasoning items are
 * dropped from the model *input*. State is untouched, so the UI still renders
 * each turn's reasoning; the model simply produces fresh reasoning per turn and
 * never receives the old items back.
 */
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
