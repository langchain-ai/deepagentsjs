/**
 * Utility functions for middleware.
 *
 * This module provides shared helpers used across middleware implementations.
 */

import { SystemMessage } from "@langchain/core/messages";
import { AgentMiddleware } from "langchain";

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

/**
 * Merge default and custom middleware arrays.
 *
 * Default middleware that share a name with a custom middleware are replaced
 * in-place (preserving the default's position). Custom middleware that do not
 * override any default are appended at the end.
 *
 * @param defaults - Base middleware array.
 * @param custom - User-provided overrides and additions.
 * @returns Merged middleware array with no duplicate names.
 *
 * @example
 * ```typescript
 * const defaults = [mw1, mw2, mw3];
 * const custom   = [mw2Override, mw4];
 * const result   = mergeMiddleware(defaults, custom);
 * // Result: [mw1, mw2Override, mw3, mw4]
 * ```
 */
export function mergeMiddleware(
  defaults: readonly AgentMiddleware[],
  custom: readonly AgentMiddleware[],
): AgentMiddleware[] {
  const customByName = new Map<string, AgentMiddleware>();
  for (const mw of custom) {
    customByName.set(mw.name, mw);
  }

  // Replace defaults in-place when a custom override exists
  const merged = defaults.map((mw) => customByName.get(mw.name) ?? mw);

  // Append custom middleware that didn't override any default
  const defaultNames = new Set(defaults.map((mw) => mw.name));
  for (const mw of custom) {
    if (!defaultNames.has(mw.name)) {
      merged.push(mw);
    }
  }

  return merged;
}
