"use client";

import { useMemo } from "react";

import type { BaseMessage } from "@langchain/core/messages";
import type { SubagentDiscoverySnapshot } from "@langchain/langgraph-sdk/stream";
import { useMessages, useStreamContext } from "@langchain/react";

import type { Agent } from "@/lib/agent";
import { MessageThread } from "./MessageThread";
import { StreamingIndicator } from "./StreamingIndicator";

export type SubagentStatus = SubagentDiscoverySnapshot["status"];

/** Lightweight model for a subagent card, derived from a `task` tool call. */
export type SubagentCard = {
  /** The `task` tool-call id — also the subagent discovery key. */
  id: string;
  name: string;
  task?: string;
  status: SubagentStatus;
  /** Whether a discovery snapshot exists yet (i.e. the card can be opened). */
  openable: boolean;
};

function statusLabel(status: SubagentStatus) {
  if (status === "running") return "Running";
  if (status === "complete") return "Complete";
  return "Error";
}

/** The task prompt is shown separately; skip the matching human message. */
function omitTaskHumanMessage(
  messages: BaseMessage[],
  taskInput?: string
): BaseMessage[] {
  const task = taskInput?.trim();
  if (!task) return messages;
  return messages.filter(
    (message) => message.type !== "human" || message.text?.trim() !== task
  );
}

/**
 * Compact, clickable subagent cards showing only the name and task prompt.
 * Rendered inline where the coordinator spawned the subagents. Selecting one
 * drills into its dedicated chat view.
 */
export function SubagentList({
  cards,
  onOpen,
}: {
  cards: SubagentCard[];
  onOpen: (id: string) => void;
}) {
  if (cards.length === 0) return null;

  return (
    <div aria-label="Subagents" className="subagent-list">
      {cards.map((card) => (
        <button
          className="subagent-chip"
          disabled={!card.openable}
          key={card.id}
          onClick={() => card.openable && onOpen(card.id)}
          type="button"
        >
          <span className="subagent-chip-head">
            <span className="subagent-chip-name">{card.name}</span>
            <span className={`subagent-status status-${card.status}`}>
              {statusLabel(card.status)}
            </span>
          </span>
          {card.task ? (
            <span className="subagent-chip-task">{card.task}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * The chat interface for a single subagent.
 *
 * `useMessages` is scoped to the subagent's namespace, so its tokens, tool
 * calls, and results stream independently from the root conversation.
 */
export function SubagentDetail({
  snapshot,
}: {
  snapshot: SubagentDiscoverySnapshot;
}) {
  const stream = useStreamContext<Agent>();
  const messages = useMessages(stream, snapshot);
  const visibleMessages = useMemo(
    () => omitTaskHumanMessage(messages, snapshot.taskInput),
    [messages, snapshot.taskInput]
  );

  return (
    <>
      {snapshot.taskInput ? (
        <div className="subagent-prompt">
          <span>Task</span>
          <p>{snapshot.taskInput}</p>
        </div>
      ) : null}

      <MessageThread
        isLoading={snapshot.status === "running"}
        messages={visibleMessages}
      />

      {snapshot.status === "running" && visibleMessages.length === 0 ? (
        <StreamingIndicator />
      ) : null}
    </>
  );
}
