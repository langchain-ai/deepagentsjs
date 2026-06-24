"use client";

import { useMemo } from "react";

import type { SubagentDiscoverySnapshot } from "@langchain/langgraph-sdk/stream";
import { useStreamContext } from "@langchain/react";

import type { Agent } from "@/lib/agent/types";
import { MessageThread } from "./MessageThread";
import {
  shouldShowTypingIndicator,
  StreamingIndicator,
} from "./StreamingIndicator";
import { SubagentList, type SubagentCard } from "./Subagents";

/**
 * The root conversation, rendered in message order.
 *
 * Subagent `task` delegations are rendered as cards (not raw tool rows) at the
 * position they occur, and all other tool calls are folded into collapsible
 * tool-call chips by {@link MessageThread}.
 */
export function Conversation({
  onOpenSubagent,
}: {
  onOpenSubagent: (id: string) => void;
}) {
  const stream = useStreamContext<Agent>();

  const messages = useMemo(
    () => stream.messages.filter((message) => message != null),
    [stream.messages]
  );

  const subagentsById = useMemo(() => {
    const map = new Map<string, SubagentDiscoverySnapshot>();
    for (const snapshot of stream.subagents.values()) {
      map.set(snapshot.id, snapshot);
    }
    return map;
  }, [stream.subagents]);

  const showTypingIndicator = shouldShowTypingIndicator(
    messages,
    stream.isLoading
  );

  return (
    <>
      {messages.length === 0 && !stream.error ? (
        <div className="empty-state">
          Ask a question below. The coordinator will delegate to its subagents
          and stream tokens, tool calls, and results.
        </div>
      ) : null}

      <MessageThread
        isLoading={stream.isLoading}
        messages={messages}
        taskRenderer={(tasks) => {
          const cards: SubagentCard[] = tasks.map((call, index) => {
            const snapshot = call.id ? subagentsById.get(call.id) : undefined;
            const args = (call.args ?? {}) as Record<string, unknown>;
            return {
              id: call.id ?? `task-${index}`,
              name: snapshot?.name ?? String(args.subagent_type ?? "subagent"),
              task:
                snapshot?.taskInput ??
                (typeof args.description === "string"
                  ? args.description
                  : undefined),
              status: snapshot?.status ?? "running",
              openable: snapshot != null,
            };
          });
          return <SubagentList cards={cards} onOpen={onOpenSubagent} />;
        }}
      />

      {showTypingIndicator ? <StreamingIndicator /> : null}

      {messages.length === 0 && !stream.isLoading && stream.error ? (
        <div className="error">
          Could not reach the agent API. Make sure the dev server is running and
          <code>OPENAI_API_KEY</code> is set, then try again.
        </div>
      ) : null}
    </>
  );
}
