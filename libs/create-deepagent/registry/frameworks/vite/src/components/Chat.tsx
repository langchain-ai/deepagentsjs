"use client";

import { useEffect, useRef, useState } from "react";

import { HumanMessage } from "@langchain/core/messages";
import { useStreamContext } from "@langchain/react";

import type { Agent } from "@/lib/agent-type";
import { Conversation } from "./Conversation";
import { SubagentDetail } from "./Subagents";

const EXAMPLE_PROMPT =
  "Research LangGraph streaming, and separately calculate 42 * 17.";

export function Chat({
  onRunSettled,
}: {
  threadId: string;
  /** Called when a run settles, so the sidebar can refresh titles/order. */
  onRunSettled: () => void;
}) {
  const stream = useStreamContext<Agent>();
  const [content, setContent] = useState(EXAMPLE_PROMPT);
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Refresh the sidebar whenever a run finishes (titles derive from the first
  // message; order from the latest checkpoint, both owned by the server).
  useEffect(() => {
    if (!stream.isLoading) onRunSettled();
  }, [stream.isLoading, onRunSettled]);

  function autoGrow() {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }

  const subagents = [...stream.subagents.values()];
  const openSubagent = openSubagentId
    ? subagents.find((snapshot) => snapshot.id === openSubagentId)
    : undefined;

  function handleSubmit() {
    const nextContent = content.trim();
    if (nextContent.length === 0 || stream.isLoading) return;

    setContent("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    void stream.submit({
      messages: [new HumanMessage(nextContent)],
    });
  }

  // Subagent detail view: breadcrumb + that subagent's chat (no composer).
  if (openSubagent) {
    return (
      <main className="chat-main">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <button
            className="crumb-link"
            onClick={() => setOpenSubagentId(null)}
            type="button"
          >
            Main chat
          </button>
          <span className="crumb-sep">/</span>
          <span className="crumb-current">{openSubagent.name}</span>
        </nav>
        <div className="conversation">
          <div className="conversation-inner">
            <SubagentDetail snapshot={openSubagent} />
          </div>
        </div>
      </main>
    );
  }

  // Main view: messages + subagent chips, with the composer pinned at the bottom.
  return (
    <main className="chat-main">
      <div className="conversation">
        <div className="conversation-inner">
          <Conversation onOpenSubagent={setOpenSubagentId} />
        </div>
      </div>

      <div className="composer-bar">
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <textarea
            aria-label="Message"
            onChange={(event) => {
              setContent(event.target.value);
              autoGrow();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Ask for research, a calculation, or both..."
            ref={textareaRef}
            rows={1}
            value={content}
          />
          <button
            disabled={content.trim() === "" || stream.isLoading}
            type="submit"
          >
            Send
          </button>
        </form>
      </div>
    </main>
  );
}
