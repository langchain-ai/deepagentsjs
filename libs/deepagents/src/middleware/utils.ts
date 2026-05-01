/**
 * Utility functions for middleware.
 *
 * This module provides shared helpers used across middleware implementations.
 */
import { getMaxListeners, setMaxListeners } from "node:events";
import { SystemMessage } from "@langchain/core/messages";

/**
 * Append text to a system message.
 *
 * Creates a new SystemMessage with the text appended to the existing content.
 * If the original message has content, the new text is separated by two newlines.
 *
 * @param systemMessage - Existing system message or null/undefined.
 * @param text - Text to add to the system message.
 * @returns New SystemMessage with the text appended.
 *
 * @example
 * ```typescript
 * const original = new SystemMessage({ content: "You are a helpful assistant." });
 * const updated = appendToSystemMessage(original, "Always be concise.");
 * // Result: SystemMessage with content "You are a helpful assistant.\n\nAlways be concise."
 * ```
 */
export function appendToSystemMessage(
  systemMessage: SystemMessage | null | undefined,
  text: string,
): SystemMessage {
  if (!systemMessage) {
    return new SystemMessage({ content: text });
  }

  // Handle both string and array content formats
  const existingContent = systemMessage.content;

  if (typeof existingContent === "string") {
    const newContent = existingContent ? `${existingContent}\n\n${text}` : text;
    return new SystemMessage({ content: newContent });
  }

  // For array content (content blocks), append as a new text block
  if (Array.isArray(existingContent)) {
    const newContent = [...existingContent];
    const textToAdd = newContent.length > 0 ? `\n\n${text}` : text;
    newContent.push({ type: "text", text: textToAdd });
    return new SystemMessage({ content: newContent });
  }

  // Fallback for unknown content type
  return new SystemMessage({ content: text });
}

/**
 * Prepend text to a system message.
 *
 * Creates a new SystemMessage with the text prepended to the existing content.
 * If the original message has content, the new text is separated by two newlines.
 *
 * @param systemMessage - Existing system message or null/undefined.
 * @param text - Text to prepend to the system message.
 * @returns New SystemMessage with the text prepended.
 *
 * @example
 * ```typescript
 * const original = new SystemMessage({ content: "Always be concise." });
 * const updated = prependToSystemMessage(original, "You are a helpful assistant.");
 * // Result: SystemMessage with content "You are a helpful assistant.\n\nAlways be concise."
 * ```
 */
export function prependToSystemMessage(
  systemMessage: SystemMessage | null | undefined,
  text: string,
): SystemMessage {
  if (!systemMessage) {
    return new SystemMessage({ content: text });
  }

  // Handle both string and array content formats
  const existingContent = systemMessage.content;

  if (typeof existingContent === "string") {
    const newContent = existingContent ? `${text}\n\n${existingContent}` : text;
    return new SystemMessage({ content: newContent });
  }

  // For array content (content blocks), prepend as a new text block
  if (Array.isArray(existingContent)) {
    const textToAdd = existingContent.length > 0 ? `${text}\n\n` : text;
    const newContent = [{ type: "text", text: textToAdd }, ...existingContent];
    return new SystemMessage({ content: newContent });
  }

  // Fallback for unknown content type
  return new SystemMessage({ content: text });
}

const SUBAGENT_ABORT_SIGNAL_MAX_LISTENERS = 100;
const CONFIG_KEY_ABORT_SIGNALS = "__pregel_abort_signals";

type PregelAbortSignals = {
  externalAbortSignal?: AbortSignal;
  timeoutAbortSignal?: AbortSignal;
  composedAbortSignal?: AbortSignal;
};

/**
 * Parallel task fan-out shares cancellation signals across subagents. Each
 * nested graph invocation can attach several listeners to both the runnable
 * signal and LangGraph's inherited Pregel abort signals, so legitimate
 * parallelism can exceed Node's default EventTarget listener warning threshold.
 */
function raiseAbortSignalListenerLimitForSignal(
  signal: AbortSignal | undefined,
): void {
  if (signal == null) return;

  const currentMax = getMaxListeners(signal);
  if (currentMax !== 0 && currentMax < SUBAGENT_ABORT_SIGNAL_MAX_LISTENERS) {
    setMaxListeners(SUBAGENT_ABORT_SIGNAL_MAX_LISTENERS, signal);
  }
}

export function raiseAbortSignalListenerLimit(config: {
  signal?: AbortSignal;
  configurable?: Record<string, unknown>;
}): void {
  raiseAbortSignalListenerLimitForSignal(config.signal);

  const inheritedSignals = config.configurable?.[CONFIG_KEY_ABORT_SIGNALS] as
    | PregelAbortSignals
    | undefined;
  raiseAbortSignalListenerLimitForSignal(inheritedSignals?.externalAbortSignal);
  raiseAbortSignalListenerLimitForSignal(inheritedSignals?.timeoutAbortSignal);
  raiseAbortSignalListenerLimitForSignal(inheritedSignals?.composedAbortSignal);
}
