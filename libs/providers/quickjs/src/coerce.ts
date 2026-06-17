/**
 * Coercion of tool / subagent return values for the QuickJS bridge.
 *
 * The deepagents `task` tool resolves to a LangGraph `Command` whose payload
 * carries the subagent's final message(s) under `update.messages`; some tools
 * return a `ToolMessage` or a list of messages. The interpreter bridges need
 * the underlying output, not the envelope, so this unwraps those shapes to the
 * content the model actually cares about.
 */

/**
 * Narrow to a non-null, non-array object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A LangGraph `Command`-like value: an object carrying an `update` payload.
 * Live `Command` instances and their serialized form both expose `update`.
 */
function isCommandLike(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && "update" in value;
}

/**
 * A LangChain message-like value (e.g. `ToolMessage`): an object with `content`
 * that is not a `Command`, distinguished from a plain `{ content }` data object
 * by a message discriminator so arbitrary tool results aren't misread.
 */
function isMessageLike(value: unknown): boolean {
  if (!isPlainObject(value) || "update" in value || !("content" in value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v._getType === "function" ||
    typeof v.getType === "function" ||
    "tool_call_id" in v ||
    v.lc_serializable === true ||
    // serialized LangChain message: id: ["langchain_core","messages","ToolMessage"]
    Array.isArray(v.id)
  );
}

/**
 * Read a message's content, handling live instances and serialized form.
 */
function messageContent(message: unknown): unknown {
  if (!isPlainObject(message)) {
    return undefined;
  }
  if (message.content != null) {
    return message.content;
  }

  const kwargs = message.kwargs;
  if (isPlainObject(kwargs) && kwargs.content != null) {
    return kwargs.content;
  }

  return undefined;
}

/**
 * Return the trailing message content from a `Command`'s `update.messages`,
 * scanning from the end for the last message that actually has content. Returns
 * the command unchanged when it has no message-shaped payload.
 */
function extractCommandContent(command: Record<string, unknown>): unknown {
  const update = command.update;
  const messages = isPlainObject(update) ? update.messages : undefined;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = messageContent(messages[i]);
      if (content != null) {
        return content;
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
  if (typeof value === "string") {
    return value;
  }

  if (isCommandLike(value)) {
    const inner = extractCommandContent(value);
    return inner === value ? value : unwrapToolEnvelope(inner);
  }

  if (isMessageLike(value)) {
    return unwrapToolEnvelope(messageContent(value));
  }

  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const entry = value[i];
      if (isMessageLike(entry)) {
        const content = messageContent(entry);
        return unwrapToolEnvelope(content);
      }

      if (isCommandLike(entry)) {
        const inner = extractCommandContent(entry);
        if (inner !== entry) {
          return unwrapToolEnvelope(inner);
        }
      }
    }
    return value;
  }

  return value;
}
