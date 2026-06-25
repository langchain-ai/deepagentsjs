"use client";

import { AIMessage, type BaseMessage } from "@langchain/core/messages";

type ToolCallLike = {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
};

function messageLabel(message: { type: string; name?: string }) {
  if (message.type === "human") return "You";
  if (message.type === "tool") return `Tool · ${message.name ?? "result"}`;
  if (message.type === "ai") return "Assistant";
  return message.type;
}

function formatToolArgs(args: Record<string, unknown>) {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  if (entries.length === 1) return String(entries[0]?.[1] ?? "");
  return JSON.stringify(args);
}

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
          (block as { type?: string })?.type === "reasoning"
      )
      .map((block) => block.reasoning)
      .join("")
      .trim();
  } catch {
    return "";
  }
}

/**
 * Renders a single message as a chat bubble with its tool-call rows.
 *
 * `toolCalls` can be passed to override which tool calls are shown (e.g. to
 * hide the `task` calls that are rendered as subagent cards instead).
 */
export function MessageBubble({
  message,
  toolCalls,
}: {
  message: BaseMessage;
  toolCalls?: ToolCallLike[];
}) {
  const calls =
    toolCalls ??
    (AIMessage.isInstance(message) ? (message.tool_calls ?? []) : []);

  return (
    <div
      className={`message ${message.type === "human" ? "user" : ""} ${
        message.type === "tool" ? "tool" : ""
      }`}
    >
      <span>{messageLabel(message)}</span>
      {calls.length > 0 ? (
        <ul className="tool-call-list">
          {calls.map((toolCall, toolIndex) => {
            const args = formatToolArgs(toolCall.args ?? {});
            return (
              <li key={toolCall.id ?? toolIndex}>
                <strong>{toolCall.name}</strong>
                {args ? `(${args})` : ""}
              </li>
            );
          })}
        </ul>
      ) : null}
      {message.text ? <p>{message.text}</p> : null}
    </div>
  );
}
