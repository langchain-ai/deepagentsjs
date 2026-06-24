"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HttpAgentServerAdapter, StreamProvider } from "@langchain/react";

import {
  type ThreadSummary,
  createThread,
  deleteThread,
  fetchThreads,
  getApiUrl,
} from "@/lib/chat/threads-client";
import { Chat } from "./Chat";
import { ThreadHistory } from "./ThreadHistory";
import { MoonIcon, SunIcon } from "./ThemeIcons";

export function ChatApp() {
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string>("");
  // Guards the one-time init against React Strict Mode's double-invoke in dev,
  // which would otherwise create two threads when none exist yet.
  const initStarted = useRef(false);

  const refreshThreads = useCallback(async () => {
    setThreads(await fetchThreads());
  }, []);

  // On mount, load threads from the server (single source of truth). If none
  // exist yet, create one. All setState happens in an async callback, so the
  // effect body never calls setState synchronously.
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

  const transport = useMemo(() => {
    if (!threadId) return null;
    return new HttpAgentServerAdapter({
      apiUrl: getApiUrl(),
      threadId,
      paths: {
        commands: `/threads/${threadId}/commands`,
        stream: `/threads/${threadId}/stream`,
      },
    });
  }, [threadId]);

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

  if (!mounted || !threadId || !transport) {
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

      <StreamProvider key={threadId} threadId={threadId} transport={transport}>
        <Chat onRunSettled={refreshThreads} threadId={threadId} />
      </StreamProvider>
    </div>
  );
}
