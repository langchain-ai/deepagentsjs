import { BaseMessage } from "@langchain/core/messages";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Recursively replace LangChain message instances with plain protocol dicts.
 *
 * Uses {@link BaseMessage.isInstance} and {@link BaseMessage.toDict} from
 * `@langchain/core/messages` — the canonical LangChain serialization primitive.
 * Message instances surface in `values`/`updates` stream data and in the
 * checkpointer state snapshot returned by the thread-state routes, often nested
 * under `messages`.
 */
export function sanitizeForJson(value: unknown): unknown {
  if (BaseMessage.isInstance(value)) {
    const { type, data } = value.toDict();
    return sanitizeForJson({ ...data, type });
  }
  if (Array.isArray(value)) return value.map(sanitizeForJson);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = sanitizeForJson(item);
    }
    return result;
  }
  return value;
}
