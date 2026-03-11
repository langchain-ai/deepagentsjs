import type {
  ActivityEvent,
  SessionSnapshot,
  SessionUpdate,
  SessionUpdatePlanEntry,
  SessionUpdateToolCall,
  TodoItem,
} from "./types.js";

function mapTodoStatus(
  status: TodoItem["status"],
): SessionUpdatePlanEntry["status"] {
  return status === "cancelled" ? "skipped" : status;
}

function getToolKind(
  toolName: string,
): SessionUpdateToolCall["kind"] {
  const readTools = ["read_file", "ls"];
  const searchTools = ["grep", "glob"];
  const editTools = ["write_file", "edit_file", "str_replace"];
  const executeTools = ["execute", "shell", "terminal"];
  const thinkTools = ["write_todos"];

  if (readTools.includes(toolName)) return "read";
  if (searchTools.includes(toolName)) return "search";
  if (editTools.includes(toolName)) return "edit";
  if (executeTools.includes(toolName)) return "execute";
  if (thinkTools.includes(toolName)) return "think";
  return "other";
}

function getToolTitle(event: ActivityEvent): string {
  const toolName = event.toolName ?? "tool";
  const filePath = event.files?.[0]?.path;
  switch (toolName) {
    case "read_file":
      return `Reading ${filePath ?? "file"}`;
    case "write_file":
      return `Writing ${filePath ?? "file"}`;
    case "edit_file":
    case "str_replace":
      return `Editing ${filePath ?? "file"}`;
    case "ls":
      return `Listing ${filePath ?? "directory"}`;
    case "grep":
      return `Searching files`;
    case "glob":
      return `Finding matching files`;
    default:
      return `Executing ${toolName}`;
  }
}

export function todosToPlanEntries(
  todos: TodoItem[] | undefined,
): SessionUpdatePlanEntry[] | undefined {
  if (!todos || todos.length === 0) return undefined;
  return todos.map((todo) => ({
    id: todo.id,
    content: todo.content,
    status: mapTodoStatus(todo.status),
    priority: "medium",
  }));
}

export function snapshotToSessionUpdate(
  snapshot: SessionSnapshot,
): SessionUpdate {
  return {
    kind: "snapshot",
    sessionId: snapshot.session.sessionId,
    timestamp: snapshot.session.updatedAt ?? new Date().toISOString(),
    snapshot,
    status: snapshot.session,
    plan: todosToPlanEntries(snapshot.todos),
    files: snapshot.files,
  };
}

export function eventToSessionUpdate(event: ActivityEvent): SessionUpdate {
  if (event.type === "model_response") {
    return {
      kind: "message",
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      event,
      message: {
        threadId: event.threadId,
        content: event.content,
        summary: event.summary,
        step: event.step,
      },
      plan: todosToPlanEntries(event.todos),
      files: event.files,
    };
  }

  if (event.type === "tool_result") {
    return {
      kind: "tool_update",
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      event,
      tool: {
        id: event.id,
        name: event.toolName ?? "tool",
        kind: getToolKind(event.toolName ?? "tool"),
        title: getToolTitle(event),
        status: event.success === false ? "failed" : "completed",
        summary: event.summary,
        locations: event.files?.map((file) => ({ path: file.path })),
      },
      files: event.files,
    };
  }

  if (
    event.type === "control_queued" ||
    event.type === "control_applied" ||
    event.type === "control_rejected"
  ) {
    return {
      kind: "control_update",
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      event,
      control: {
        commandId: event.controlCommandId,
        kind: event.controlKind,
        status:
          event.type === "control_queued"
            ? "queued"
            : event.type === "control_applied"
              ? "applied"
              : "rejected",
        createdBy: event.createdBy,
      },
    };
  }

  if (
    event.type === "thread_started" ||
    event.type === "thread_completed" ||
    event.type === "thread_failed"
  ) {
    return {
      kind: "thread_update",
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      event,
      thread: {
        threadId: event.threadId,
        parentThreadId: event.parentThreadId,
        agentKind: event.agentKind ?? (event.parentThreadId ? "subagent" : "root"),
        status:
          event.type === "thread_started"
            ? "running"
            : "idle",
        latestStep: event.step,
        latestSummary: event.summary,
      },
    };
  }

  return {
    kind: "events",
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    event,
    events: [event],
  };
}

export function eventsToSessionUpdates(events: ActivityEvent[]): SessionUpdate[] {
  return events.map((event) => eventToSessionUpdate(event));
}
