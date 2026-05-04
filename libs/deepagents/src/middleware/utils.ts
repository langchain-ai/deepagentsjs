/**
 * Utility functions for middleware.
 *
 * This module provides shared helpers used across middleware implementations.
 */

import { SystemMessage } from "@langchain/core/messages";

/**
 * Recursively add `additionalProperties: false` to every object-typed node
 * in a JSON Schema.
 */
export function normalizeSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type !== "object" && schema.type !== "array") {
    return schema;
  }

  if (schema.type === "array") {
    const result: Record<string, unknown> = { ...schema };
    const items = result.items;
    if (items != null && typeof items === "object" && !Array.isArray(items)) {
      result.items = normalizeSchema(items as Record<string, unknown>);
    }
    return result;
  }

  const result: Record<string, unknown> = {
    ...schema,
    additionalProperties: false,
  };

  const props = schema.properties;
  if (props != null && typeof props === "object" && !Array.isArray(props)) {
    const normalizedProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (v != null && typeof v === "object" && !Array.isArray(v)) {
        normalizedProps[k] = normalizeSchema(v as Record<string, unknown>);
      } else {
        normalizedProps[k] = v;
      }
    }
    result.properties = normalizedProps;
  }

  return result;
}

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
