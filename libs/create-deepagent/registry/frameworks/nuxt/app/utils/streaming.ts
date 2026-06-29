import { AIMessage, type BaseMessage } from "@langchain/core/messages";

/**
 * Extract reasoning-summary text from a message.
 *
 * Reasoning models surface their summaries as `{ type: "reasoning" }` standard
 * content blocks (see `@langchain/openai`'s Responses API converter). Only AI
 * messages carry reasoning; everything else returns an empty string.
 */
export function getReasoningText(message: BaseMessage): string {
  if (!AIMessage.isInstance(message)) return "";
  try {
    return message.contentBlocks
      .filter(
        (block): block is { type: "reasoning"; reasoning: string } =>
          block?.type === "reasoning",
      )
      .map((block) => block.reasoning)
      .join("")
      .trim();
  } catch {
    return "";
  }
}

/**
 * Whether to show the "assistant is thinking" indicator.
 *
 * Mirrors the reference example: show it while a run is loading and the latest
 * message is a human turn, a tool result, or an assistant turn that has not
 * produced any text yet.
 */
export function shouldShowTypingIndicator(
  messages: BaseMessage[],
  isLoading: boolean,
): boolean {
  if (!isLoading) return false;

  const last = messages.at(-1);
  if (!last) return true;
  if (last.type === "human" || last.type === "tool") return true;
  if (last.type === "ai" && !last.text?.trim()) return true;
  return false;
}
