import { useState, useRef, useEffect, type FormEvent } from "react";
import {
  useStream,
  FetchStreamTransport,
  type SubagentStreamInterface,
} from "@langchain/langgraph-sdk/react";

const transport = new FetchStreamTransport({ apiUrl: "/api/stream" });

/**
 * The SDK's UseStreamCustomOptions type doesn't include `filterSubagentMessages`
 * or `subagentToolNames` in its Pick<>, but the runtime implementation (useStreamCustom)
 * does pass them through to the StreamManager. We augment the options here to reflect
 * the actual runtime behavior.
 */
type StreamOptions = Parameters<typeof useStream>[0] & {
  filterSubagentMessages?: boolean;
  subagentToolNames?: string[];
};

type StreamResult = ReturnType<typeof useStream> & {
  subagents: Map<
    string,
    SubagentStreamInterface<Record<string, unknown>, unknown, string>
  >;
};

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    running: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    complete: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    error: "bg-red-500/20 text-red-400 border-red-500/30",
  };
  const dotColors: Record<string, string> = {
    pending: "bg-yellow-400",
    running: "bg-blue-400 animate-pulse",
    complete: "bg-emerald-400",
    error: "bg-red-400",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors[status] ?? colors.pending}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${dotColors[status] ?? dotColors.pending}`}
      />
      {status}
    </span>
  );
}

function SubagentCard({
  subagent,
}: {
  subagent: SubagentStreamInterface<Record<string, unknown>, unknown, string>;
}) {
  const type = subagent.toolCall.args.subagent_type ?? "unknown";
  const description = subagent.toolCall.args.description ?? "";
  const lastAiMessage = [...subagent.messages]
    .reverse()
    .find((m) => m.type === "ai");
  const content =
    typeof lastAiMessage?.content === "string" ? lastAiMessage.content : "";

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4 backdrop-blur-sm transition-all duration-300">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-200">{type}</span>
        <StatusBadge status={subagent.status} />
      </div>
      {description && (
        <p className="mb-2 text-xs text-gray-500 leading-relaxed">
          {description}
        </p>
      )}
      {subagent.result ? (
        <div className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-gray-950/50 p-3 text-sm text-gray-300 leading-relaxed">
          {subagent.result}
        </div>
      ) : content ? (
        <div className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-gray-950/50 p-3 text-sm text-gray-400 leading-relaxed">
          <span className="animate-pulse">...</span> {content.slice(-500)}
        </div>
      ) : null}
    </div>
  );
}

type MessageDict = {
  id?: string;
  type: string;
  content: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
};

function getTextContent(content: MessageDict["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("");
}

function MessageBubble({ message }: { message: MessageDict }) {
  const isHuman = message.type === "human";
  const text = getTextContent(message.content);
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;

  if (message.type === "tool") return null;
  if (!text && !hasToolCalls) return null;

  return (
    <div className={`flex ${isHuman ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isHuman
            ? "bg-blue-600 text-white"
            : "bg-gray-800/80 text-gray-200 border border-gray-700/50"
        }`}
      >
        {text && (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
        )}
        {hasToolCalls && (
          <div className="mt-2 space-y-1">
            {message.tool_calls!.map((tc) => (
              <div
                key={tc.id}
                className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-1.5 text-xs"
              >
                <span className="text-blue-300">task</span>
                <span className="text-gray-400">
                  {(tc.args.subagent_type as string) ?? "subagent"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const thread = useStream({
    transport,
    filterSubagentMessages: true,
  } as StreamOptions) as StreamResult;

  const messages = (thread.messages ?? []) as MessageDict[];
  const subagents = thread.subagents ?? new Map();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, thread.isLoading]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || thread.isLoading) return;
    setInput("");
    thread.submit({ messages: [{ type: "human", content: text }], tasks: {} });
  };

  const subagentEntries = subagents ? [...subagents.entries()] : [];

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-gray-800 bg-gray-950/80 px-6 py-4 backdrop-blur-sm">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold">
          A
        </div>
        <div>
          <h1 className="text-sm font-semibold text-gray-100">
            Async Subagents
          </h1>
          <p className="text-xs text-gray-500">
            Supervisor + researcher &amp; analyst
          </p>
        </div>
        {thread.isLoading && (
          <div className="ml-auto flex items-center gap-2 text-xs text-blue-400">
            <div className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
            Streaming
          </div>
        )}
      </header>

      {/* Main content */}
      <div className="flex min-h-0 flex-1">
        {/* Chat area */}
        <main className="flex flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-6 py-6">
            {messages.length === 0 && !thread.isLoading ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-800/50 text-2xl">
                    ?
                  </div>
                  <h2 className="mb-2 text-lg font-medium text-gray-300">
                    Ask something
                  </h2>
                  <p className="max-w-sm text-sm text-gray-500">
                    Try a question that benefits from parallel research and
                    analysis, like &ldquo;Compare React and Vue for building
                    enterprise dashboards&rdquo;
                  </p>
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-4">
                {messages.map((msg, i) => (
                  <MessageBubble key={msg.id ?? i} message={msg} />
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="border-t border-gray-800 bg-gray-950/80 px-6 py-4 backdrop-blur-sm">
            <form
              onSubmit={handleSubmit}
              className="mx-auto flex max-w-3xl gap-3"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask a question..."
                className="flex-1 rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-sm text-gray-100 placeholder-gray-500 outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
              />
              <button
                type="submit"
                disabled={!input.trim() || thread.isLoading}
                className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </div>
        </main>

        {/* Subagent sidebar */}
        {subagentEntries.length > 0 && (
          <aside className="w-96 overflow-y-auto border-l border-gray-800 bg-gray-950/50 p-4">
            <h2 className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
              Subagents ({subagentEntries.length})
            </h2>
            <div className="space-y-3">
              {subagentEntries.map(([id, sub]) => (
                <SubagentCard key={id} subagent={sub} />
              ))}
            </div>
          </aside>
        )}
      </div>

      {/* Error display */}
      {thread.error != null && (
        <div className="border-t border-red-900/50 bg-red-950/30 px-6 py-3 text-sm text-red-400">
          Error:{" "}
          {thread.error instanceof Error
            ? thread.error.message
            : String(thread.error)}
        </div>
      )}
    </div>
  );
}
