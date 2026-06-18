/**
 * Coercion of tool / subagent return values for the QuickJS bridge.
 *
 * The deepagents `task` tool resolves to a LangGraph `Command` whose payload
 * carries the subagent's final message(s) under `update.messages`; some tools
 * return a `ToolMessage` or a list of messages. The interpreter bridges need
 * the underlying output, not the envelope, so this unwraps those shapes to the
 * content the model actually cares about.
 */
import { isCommand, type Command } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";

/**
 * Return the trailing message content from a `Command`'s `update.messages`,
 * scanning from the end for the last message that actually has content. Returns
 * the command unchanged when it has no message-shaped payload.
 */
function extractCommandContent(command: Command): unknown {
  const update: unknown = command.update;
  const messages =
    update !== null && typeof update === "object"
      ? (update as { messages?: unknown }).messages
      : undefined;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (BaseMessage.isInstance(message) && message.content != null) {
        return message.content;
      }
    }
  }
  return command;
}

/**
 * Unwrap a LangChain `Command` / `ToolMessage` / message-list envelope to the
 * underlying content. Non-envelope values (strings, content-block arrays, plain
 * objects) are returned unchanged.
 *
 * @param value The raw value returned by a tool or subagent dispatch.
 * @returns The unwrapped content, or `value` itself when it isn't an envelope.
 */
export function unwrapToolEnvelope(value: unknown): unknown {
  if (typeof value === "string") return value;

  if (isCommand(value)) {
    const inner = extractCommandContent(value);
    return inner === value ? value : unwrapToolEnvelope(inner);
  }

  if (BaseMessage.isInstance(value)) {
    return unwrapToolEnvelope(value.content);
  }

  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const entry = value[i];
      if (BaseMessage.isInstance(entry)) {
        return unwrapToolEnvelope(entry.content);
      }
      if (isCommand(entry)) {
        const inner = extractCommandContent(entry);
        if (inner !== entry) return unwrapToolEnvelope(inner);
      }
    }
    return value;
  }

  return value;
}
