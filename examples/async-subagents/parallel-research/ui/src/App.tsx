import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type SubmitEventHandler,
} from "react";
import { Client } from "@langchain/langgraph-sdk";
import { useStream } from "@langchain/langgraph-sdk/react";
import { Search, ArrowUp, AlertCircle, GitFork } from "lucide-react";
import {
  ResearcherCard,
  type ResearcherConfig,
} from "./components/ResearcherCard";
import type { AsyncTask } from "./types";

// ─── Constants ───────────────────────────────────────────────────────────────

const LANGGRAPH_URL = "http://localhost:2024";

const CARD_PALETTES: Omit<ResearcherConfig, "label">[] = [
  {
    icon: <Search className="w-4 h-4" />,
    gradient: "from-cyan-500/20 to-blue-600/20",
    borderColor: "border-cyan-500/40",
    bgColor: "bg-cyan-950/30",
    iconBg: "bg-cyan-500/20",
    accentColor: "text-cyan-400",
  },
  {
    icon: <Search className="w-4 h-4" />,
    gradient: "from-purple-500/20 to-pink-600/20",
    borderColor: "border-purple-500/40",
    bgColor: "bg-purple-950/30",
    iconBg: "bg-purple-500/20",
    accentColor: "text-purple-400",
  },
  {
    icon: <Search className="w-4 h-4" />,
    gradient: "from-emerald-500/20 to-teal-600/20",
    borderColor: "border-emerald-500/40",
    bgColor: "bg-emerald-950/30",
    iconBg: "bg-emerald-500/20",
    accentColor: "text-emerald-400",
  },
  {
    icon: <Search className="w-4 h-4" />,
    gradient: "from-orange-500/20 to-red-600/20",
    borderColor: "border-orange-500/40",
    bgColor: "bg-orange-950/30",
    iconBg: "bg-orange-500/20",
    accentColor: "text-orange-400",
  },
  {
    icon: <Search className="w-4 h-4" />,
    gradient: "from-yellow-500/20 to-amber-600/20",
    borderColor: "border-yellow-500/40",
    bgColor: "bg-yellow-950/30",
    iconBg: "bg-yellow-500/20",
    accentColor: "text-yellow-400",
  },
];

const SUGGESTIONS = [
  "Research the history of New York City",
  "Research the latest AI developments",
  "Research Apple's current market position and competitors",
];

const TERMINAL_STATUSES = new Set([
  "success",
  "error",
  "cancelled",
  "timeout",
  "interrupted",
]);

// ─── Types ───────────────────────────────────────────────────────────────────

interface StreamMessage {
  id?: string;
  type: string;
  content: string | { type: string; text?: string }[];
  tool_calls?: unknown[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getMessageText(msg: StreamMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("");
  }
  return "";
}

// ─── Components ──────────────────────────────────────────────────────────────

function HumanBubble({ content }: { content: string }) {
  return (
    <div className="animate-fade-in flex justify-end">
      <div className="bg-brand-dark text-brand-light rounded-2xl px-4 py-2.5 max-w-[85%] md:max-w-[70%]">
        <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
          {content}
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({ content }: { content: string }) {
  return (
    <div className="animate-fade-in">
      <div className="text-xs font-medium text-neutral-500 mb-2">Assistant</div>
      <div className="text-neutral-100 whitespace-pre-wrap leading-relaxed text-[15px]">
        {content}
      </div>
    </div>
  );
}

function NotificationBubble({ content }: { content: string }) {
  return (
    <div className="animate-fade-in flex justify-center">
      <div className="bg-neutral-900 border border-dashed border-neutral-700 rounded-lg px-4 py-2 text-xs text-neutral-500 max-w-[70%] text-center truncate">
        {content}
      </div>
    </div>
  );
}

function StreamingIndicator() {
  return (
    <div className="animate-fade-in">
      <div className="text-xs font-medium text-neutral-500 mb-2">Assistant</div>
      <div className="flex items-center gap-1.5 text-neutral-500 animate-pulse">
        <div className="w-2 h-2 rounded-full bg-current" />
        <div
          className="w-2 h-2 rounded-full bg-current"
          style={{ animationDelay: "150ms" }}
        />
        <div
          className="w-2 h-2 rounded-full bg-current"
          style={{ animationDelay: "300ms" }}
        />
      </div>
    </div>
  );
}

function EmptyState({
  onSuggestionClick,
}: {
  onSuggestionClick: (s: string) => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-4 py-24">
      <div className="w-16 h-16 rounded-2xl bg-linear-to-br from-brand-accent/20 to-brand-dark/30 border border-brand-accent/30 flex items-center justify-center mb-6">
        <GitFork className="w-8 h-8 text-brand-accent" strokeWidth={1.5} />
      </div>
      <h2 className="text-xl font-semibold text-white mb-2">
        Parallel Research Assistant
      </h2>
      <p className="text-neutral-400 max-w-md mb-6 leading-relaxed">
        Ask any research question and AI researchers will investigate in
        parallel as async subagents and report back.
      </p>
      <div className="flex flex-wrap gap-2 justify-center">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onSuggestionClick(s)}
            className="px-3 py-1.5 rounded-full bg-brand-dark/40 hover:bg-brand-dark/60 text-brand-light text-xs transition-colors border border-brand-accent/20 hover:border-brand-accent/40 cursor-pointer"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export function App() {
  const [input, setInput] = useState("");
  const [asyncTasks, setAsyncTasks] = useState<Record<string, AsyncTask>>({});
  const chatRef = useRef<HTMLDivElement>(null);

  const thread = useStream({
    apiUrl: LANGGRAPH_URL,
    assistantId: "supervisor",
    // eslint-disable-next-line no-console
    onError: (err) => console.error("[stream error]", err),
    onUpdateEvent: (data) => {
      if (data && typeof data === "object") {
        for (const nodeUpdate of Object.values(
          data as Record<string, Record<string, unknown>>,
        )) {
          const taskMap = nodeUpdate?.asyncTasks as
            | Record<string, AsyncTask>
            | undefined;
          if (taskMap && typeof taskMap === "object") {
            setAsyncTasks((prev) => {
              const next = { ...prev };
              for (const task of Object.values(taskMap)) {
                next[task.taskId] = { ...prev[task.taskId], ...task };
              }
              return next;
            });
          }
        }
      }
    },
  });

  const threadRef = useRef(thread);
  threadRef.current = thread;

  // Poll running tasks for status updates
  const pollTasks = useCallback(async () => {
    const running = Object.values(asyncTasks).filter(
      (t) => !TERMINAL_STATUSES.has(t.status),
    );
    if (running.length === 0) return;

    const client = new Client({ apiUrl: LANGGRAPH_URL });
    for (const task of running) {
      try {
        const run = await client.runs.get(task.threadId, task.runId);
        if (TERMINAL_STATUSES.has(run.status)) {
          setAsyncTasks((prev) => ({
            ...prev,
            [task.taskId]: { ...prev[task.taskId], status: run.status },
          }));
          if (run.status === "success") {
            threadRef.current.submit({
              messages: [
                {
                  role: "user",
                  content: `What did the researcher find? (task_id: ${task.taskId})`,
                },
              ],
            });
          }
        }
      } catch {
        // ignore poll errors
      }
    }
  }, [asyncTasks]);

  useEffect(() => {
    const interval = setInterval(pollTasks, 4000);
    return () => clearInterval(interval);
  }, [pollTasks]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [thread.messages]);

  const taskList = Object.values(asyncTasks);

  const messages = thread.messages as unknown as StreamMessage[];

  // Merge consecutive assistant messages into single bubbles
  const visibleMessages: StreamMessage[] = [];
  for (const msg of messages) {
    if (msg.type === "tool") continue;
    const text = getMessageText(msg);
    if (msg.type === "ai" && !text) continue;

    const prev = visibleMessages[visibleMessages.length - 1];
    if (msg.type === "ai" && prev?.type === "ai") {
      prev.content = getMessageText(prev) + "\n\n" + text;
      prev.id = msg.id;
    } else {
      visibleMessages.push({ ...msg, content: text });
    }
  }

  const hasMessages = visibleMessages.length > 0;

  const handleSubmit: SubmitEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || thread.isLoading) return;
    setInput("");
    thread.submit({ messages: [{ role: "user", content: text }] });
  };

  const handleSuggestion = (text: string) => {
    setInput("");
    thread.submit({ messages: [{ role: "user", content: text }] });
  };

  const isConnected = thread.error == null;

  return (
    <div className="h-screen flex flex-col bg-black font-sans">
      <header className="border-b border-neutral-800 px-6 py-3.5 flex items-center gap-3 flex-shrink-0">
        <div className="w-8 h-8 rounded-lg bg-brand-dark flex items-center justify-center">
          <GitFork className="w-4 h-4 text-brand-accent" strokeWidth={1.5} />
        </div>
        <div>
          <h1 className="text-sm font-semibold text-white leading-none">
            Parallel Research Assistant
          </h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            useStream · async subagents
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-neutral-500">
          <span
            className={`w-2 h-2 rounded-full ${isConnected ? "bg-emerald-400" : "bg-red-400"}`}
          />
          {isConnected ? "Connected" : "Disconnected"}
        </div>
      </header>

      {taskList.length > 0 && (
        <div className="flex gap-3 px-6 py-4 border-b border-neutral-800 flex-shrink-0 overflow-x-auto">
          {taskList.map((task, i) => {
            const palette = CARD_PALETTES[i % CARD_PALETTES.length];
            const label =
              task.agentName.charAt(0).toUpperCase() + task.agentName.slice(1);
            const config: ResearcherConfig = { ...palette, label };
            return (
              <ResearcherCard key={task.taskId} config={config} task={task} />
            );
          })}
        </div>
      )}

      <main ref={chatRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          {!hasMessages && !thread.isLoading ? (
            <EmptyState onSuggestionClick={handleSuggestion} />
          ) : (
            <div className="flex flex-col gap-5">
              {visibleMessages.map((msg, i) => {
                const key = msg.id ?? `msg-${i}`;
                const text = getMessageText(msg);
                if (msg.type === "human") {
                  if (
                    text.startsWith("[Async subagent") ||
                    text.startsWith("[task_id=") ||
                    text.includes("task_id:")
                  ) {
                    return <NotificationBubble key={key} content={text} />;
                  }
                  return <HumanBubble key={key} content={text} />;
                }
                if (msg.type === "ai") {
                  return <AssistantBubble key={key} content={text} />;
                }
                return null;
              })}
              {thread.isLoading &&
                visibleMessages[visibleMessages.length - 1]?.type !== "ai" && (
                  <StreamingIndicator />
                )}
            </div>
          )}
        </div>
      </main>

      {thread.error != null && (
        <div className="mx-auto max-w-3xl px-6 pb-3 w-full">
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>
              {/* eslint-disable-next-line no-instanceof/no-instanceof */}
              {thread.error instanceof Error
                ? thread.error.message
                : "An error occurred"}
            </span>
          </div>
        </div>
      )}

      <footer className="border-t border-neutral-800 flex-shrink-0">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <form className="relative" onSubmit={handleSubmit}>
            <div className="relative bg-neutral-900 rounded-xl border border-neutral-800 focus-within:border-brand-dark transition-colors">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask a research question..."
                disabled={thread.isLoading}
                autoFocus
                className="w-full bg-transparent text-white placeholder-neutral-500 px-4 py-3 pr-12 focus:outline-none text-sm leading-relaxed disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={thread.isLoading || !input.trim()}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg bg-brand-accent hover:bg-brand-light disabled:bg-neutral-700 disabled:cursor-not-allowed text-black disabled:text-neutral-500 transition-colors"
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            </div>
            <p className="text-center text-xs text-neutral-600 mt-2">
              Press{" "}
              <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 font-mono text-[10px]">
                Enter
              </kbd>{" "}
              to send
            </p>
          </form>
        </div>
      </footer>
    </div>
  );
}
