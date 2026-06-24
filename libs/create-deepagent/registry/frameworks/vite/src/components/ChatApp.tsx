"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { StreamProvider } from "@langchain/react";

import {
  type ThreadSummary,
  createThread,
  deleteThread,
  fetchThreads,
  getAgentApiUrl,
  getApiKey,
} from "@/lib/chat/threads-client";
import { Chat } from "./Chat";
import { ThreadHistory } from "./ThreadHistory";
import { MoonIcon, SunIcon } from "./ThemeIcons";

/** Graph id from `agent/langgraph.json`. */
const ASSISTANT_ID = "agent";

export function ChatApp() {
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string>("");
  const initStarted = useRef(false);

  const refreshThreads = useCallback(async () => {
    setThreads(await fetchThreads());
  }, []);

  useEffect(() => {
    if (initStarted.current) return;
    initStarted.current = true;
    void (async () => {
      const list = await fetchThreads();
      if (list.length > 0) {
        setThreads(list);
        setThreadId(list[0].id);
      } else {
        const id = await createThread();
        setThreads(await fetchThreads());
        setThreadId(id);
      }
      setMounted(true);
    })();
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      if (id !== threadId) setThreadId(id);
    },
    [threadId]
  );

  const handleCreate = useCallback(async () => {
    const id = await createThread();
    await refreshThreads();
    setThreadId(id);
  }, [refreshThreads]);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteThread(id);
      const list = await fetchThreads();
      setThreads(list);
      if (id !== threadId) return;
      if (list.length > 0) {
        setThreadId(list[0].id);
      } else {
        const freshId = await createThread();
        setThreads(await fetchThreads());
        setThreadId(freshId);
      }
    },
    [threadId]
  );

  const shellClassName = `app-shell ${theme === "light" ? "light" : ""}`;

  if (!mounted || !threadId) {
    return (
      <div className={shellClassName}>
        <div className="empty-state center">Preparing chat…</div>
      </div>
    );
  }

  return (
    <div className={shellClassName}>
      <button
        aria-label={
          theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
        }
        className="theme-toggle"
        onClick={() => setTheme((cur) => (cur === "dark" ? "light" : "dark"))}
        type="button"
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>

      <ThreadHistory
        activeThreadId={threadId}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onSelect={handleSelect}
        threads={threads}
      />

      <StreamProvider
        key={threadId}
        assistantId={ASSISTANT_ID}
        apiUrl={getAgentApiUrl()}
        apiKey={getApiKey()}
        threadId={threadId}
      >
        <Chat onRunSettled={refreshThreads} threadId={threadId} />
      </StreamProvider>
    </div>
  );
}
