import { ModelRefusalError } from "@langchain/core/errors";
import { BaseMessage, type ContentBlock } from "@langchain/core/messages";
import type { StructuredOutputParsingError } from "langchain";

/**
 * The task result reported when a model in the subagent refused.
 *
 * @param refusal - The refusal block from the model's reply.
 */
export function refusalNotice(refusal: ContentBlock.Refusal): string {
  let notice = "The subagent stopped because a model refused the request.";
  const category = refusal.extras?.category;
  if (category) notice += ` Category: ${String(category)}.`;
  if (refusal.refusal) notice += ` Explanation: "${refusal.refusal}"`;
  return `${notice} Retrying the same request is unlikely to succeed; rephrase it or continue without it.`;
}

/**
 * The refusal block in `message`, if it is a message that refused.
 *
 * @param message - Any value; only a message can hold a refusal.
 */
export function refusalIn(message: unknown): ContentBlock.Refusal | undefined {
  if (!BaseMessage.isInstance(message)) return undefined;
  try {
    return message.contentBlocks.find(
      (block): block is ContentBlock.Refusal => block.type === "refusal",
    );
  } catch {
    return undefined;
  }
}

/**
 * The task result for an error caused by a refusal, or `undefined` to rethrow it.
 *
 * Middleware wraps errors in `MiddlewareError`, so this walks the `cause` chain.
 *
 * @param error - The error the subagent run threw.
 */
export function refusalNoticeFor(error: unknown): string | undefined {
  let current = error;
  while (current) {
    if (ModelRefusalError.isInstance(current)) {
      return refusalNotice(
        refusalIn(current.rawMessage) ?? {
          type: "refusal",
          refusal: current.message,
        },
      );
    }
    // `StructuredOutputParsingError` carries the reply that failed to parse.
    if (typeof current === "object" && "aiMessage" in current) {
      const refusal = refusalIn(
        (current as Pick<StructuredOutputParsingError, "aiMessage">).aiMessage,
      );
      if (refusal) return refusalNotice(refusal);
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return undefined;
}
