"use client";

import { Fragment, type ReactNode, useMemo } from "react";

import { AIMessage, type BaseMessage } from "@langchain/core/messages";

import { getReasoningText, MessageBubble } from "./MessageBubbles";
import { MessageReasoning } from "./MessageReasoning";
import { ToolCall, type ToolCallView } from "./ToolCall";

type ToolCallLike = {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
};

/** Deep agents delegate to subagents through the built-in `task` tool. */
const TASK_TOOL = "task";

/**
 * Renders a list of messages as a chat thread.
 *
 * Tool calls are not shown as raw rows. Each tool call is folded together with
 * its result message (matched by `tool_call_id`) into a single collapsible
 * {@link ToolCall} chip, and the standalone tool result messages are hidden.
 *
 * `taskRenderer`, when provided, receives the `task` tool calls of an assistant
 * message and returns a node to render in their place (e.g. subagent cards);
 * those calls are then excluded from the chip rendering.
 */
export function MessageThread({
  messages,
  isLoading,
  taskRenderer,
}: {
  messages: BaseMessage[];
  isLoading: boolean;
  taskRenderer?: (
    tasks: ToolCallLike[],
    message: AIMessage,
    index: number
  ) => ReactNode | null;
}) {
  const resultsByCallId = useMemo(() => {
    const map = new Map<string, BaseMessage>();
    for (const message of messages) {
      if (message.type !== "tool") continue;
      const id = (message as { tool_call_id?: unknown }).tool_call_id;
      if (typeof id === "string") map.set(id, message);
    }
    return map;
  }, [messages]);

  const items: { key: string; node: ReactNode }[] = [];

  messages.forEach((message, index) => {
    // Tool results are folded into their tool-call chip.
    if (message.type === "tool") return;

    if (AIMessage.isInstance(message)) {
      // Reasoning renders standalone (not inside the assistant bubble), before
      // the answer. Reasoning summaries stream first, then the model produces
      // either text or tool calls — so reasoning is only "active" (streaming)
      // while the run is loading, this is the last message, and it has not yet
      // produced any text or tool calls.
      const reasoning = getReasoningText(message);
      if (reasoning) {
        const hasToolCalls = (message.tool_calls?.length ?? 0) > 0;
        const reasoningActive =
          isLoading &&
          index === messages.length - 1 &&
          !message.text?.trim() &&
          !hasToolCalls;
        items.push({
          key: `reason-${message.id ?? index}`,
          node: <MessageReasoning active={reasoningActive} reasoning={reasoning} />,
        });
      }

      if (message.text?.trim()) {
        items.push({
          key: message.id ?? `m-${index}`,
          node: <MessageBubble message={message} toolCalls={[]} />,
        });
      }

      const calls = (message.tool_calls ?? []) as ToolCallLike[];
      const tasks = calls.filter((call) => call.name === TASK_TOOL);
      const chipCalls = taskRenderer
        ? calls.filter((call) => call.name !== TASK_TOOL)
        : calls;

      if (taskRenderer && tasks.length > 0) {
        const node = taskRenderer(tasks, message, index);
        if (node) items.push({ key: `task-${message.id ?? index}`, node });
      }

      chipCalls.forEach((call, callIndex) => {
        const result = call.id ? resultsByCallId.get(call.id) : undefined;
        const errored =
          (result as { status?: string } | undefined)?.status === "error";
        const view: ToolCallView = {
          id: call.id ?? `${index}-${callIndex}`,
          name: call.name,
          args: call.args ?? {},
          output: result?.text,
          status: result ? (errored ? "error" : "complete") : isLoading
            ? "running"
            : "complete",
        };
        items.push({ key: `tc-${view.id}`, node: <ToolCall call={view} /> });
      });
      return;
    }

    items.push({
      key: message.id ?? `m-${index}`,
      node: <MessageBubble message={message} />,
    });
  });

  return (
    <>
      {items.map((item) => (
        <Fragment key={item.key}>{item.node}</Fragment>
      ))}
    </>
  );
}
