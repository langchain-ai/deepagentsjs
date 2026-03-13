export interface ClientThread {
  threadId: string;
  parentThreadId?: string;
  agentKind: "root" | "subagent";
  status: "running" | "idle" | "unknown";
  latestStep?: number;
  latestSummary?: string;
}

export interface ClientTodo {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | "skipped";
}

export interface ClientFileTouch {
  path: string;
  operation: "read" | "write" | "edit" | "delete";
}

export interface ClientUpdate {
  kind: string;
  sessionId: string;
  timestamp: string;
  snapshot?: {
    session: {
      sessionId: string;
      running: boolean | "unknown";
      activeThreadId?: string;
      updatedAt?: string;
    };
    threads: ClientThread[];
    todos?: ClientTodo[];
    files?: ClientFileTouch[];
  };
  event?: {
    summary?: string;
    content?: string;
    threadId?: string;
    toolName?: string;
  };
  message?: {
    threadId: string;
    content?: string;
    summary?: string;
  };
  tool?: {
    title: string;
    summary?: string;
  };
  control?: {
    kind?: string;
    status: string;
  };
  plan?: Array<{
    id?: string;
    content: string;
    status: ClientTodo["status"];
  }>;
  files?: ClientFileTouch[];
  thread?: ClientThread;
}

export interface ClientState {
  sessionId?: string;
  running: boolean | "unknown";
  activeThreadId?: string;
  updatedAt?: string;
  threads: ClientThread[];
  todos: ClientTodo[];
  files: ClientFileTouch[];
  updates: ClientUpdate[];
  cursor?: string;
}

export async function fetchInitial() {
  const [initialRes, configRes] = await Promise.all([
    fetch("/api/initial"),
    fetch("/api/config"),
  ]);
  return {
    initial: await initialRes.json(),
    config: await configRes.json(),
  };
}

export async function fetchUpdates(cursor?: string, limit = 20) {
  const url = new URL("/api/updates", window.location.origin);
  if (cursor) url.searchParams.set("after", cursor);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url);
  return res.json();
}

export async function sendSteer(payload: {
  kind: string;
  text: string;
}) {
  const body =
    payload.kind === "add_todo"
      ? {
          kind: payload.kind,
          target: "active",
          payload: { content: payload.text },
        }
      : {
          kind: payload.kind,
          target: "active",
          payload: { text: payload.text },
        };

  const res = await fetch("/api/steer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function createInitialState(): ClientState {
  return {
    running: "unknown",
    threads: [],
    todos: [],
    files: [],
    updates: [],
  };
}

export function applyUpdate(state: ClientState, update: ClientUpdate): ClientState {
  const next: ClientState = {
    ...state,
    updates: [...state.updates, update].slice(-100),
  };

  if (update.snapshot) {
    next.sessionId = update.snapshot.session.sessionId;
    next.running = update.snapshot.session.running;
    next.activeThreadId = update.snapshot.session.activeThreadId;
    next.updatedAt = update.snapshot.session.updatedAt;
    next.threads = update.snapshot.threads;
    next.todos = update.snapshot.todos ?? [];
    next.files = update.snapshot.files ?? [];
    return next;
  }

  if (update.plan) {
    next.todos = update.plan.map((entry) => ({
      id: entry.id,
      content: entry.content,
      status: entry.status,
    }));
  }

  if (update.files?.length) {
    next.files = dedupeFiles([...next.files, ...update.files]);
  }

  if (update.thread) {
    const others = next.threads.filter((thread) => thread.threadId !== update.thread?.threadId);
    next.threads = [...others, update.thread];
  }

  next.updatedAt = update.timestamp;
  return next;
}

function dedupeFiles(files: ClientFileTouch[]): ClientFileTouch[] {
  const map = new Map<string, ClientFileTouch["operation"]>();
  for (const file of files) {
    map.set(file.path, file.operation);
  }
  return Array.from(map.entries()).map(([path, operation]) => ({
    path,
    operation,
  }));
}
