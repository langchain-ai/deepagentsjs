import type {
  ACPAttachedSession,
  SessionHandle,
  SessionSnapshot,
  ControlCommand,
  CreateSessionHandleParams,
  ActivityEvent,
  SessionThreadSnapshot,
  SessionUpdate,
} from "./types.js";
import { SessionAttachmentError } from "./types.js";
import {
  DEFAULT_NAMESPACE,
  readActivityEvents,
  writeControlCommand,
  writeActivityEvent,
  readIndex,
  getEventsNamespace,
  DEFAULT_MAX_EVENTS,
} from "./store.js";
import { eventsToSessionUpdates } from "./updates.js";
import { createAttachedACPClientSession } from "./handle-acp.js";

export function createSessionHandle(
  params: CreateSessionHandleParams,
): SessionHandle {
  const {
    sessionId,
    store,
    getState,
    namespace = DEFAULT_NAMESPACE,
    pollIntervalMs = 250,
  } = params;

  let activeAttachment: ACPAttachedSession | undefined;

  async function getAllEvents(): Promise<ActivityEvent[]> {
    const keys = await readIndex(store, namespace, sessionId);
    const ns = getEventsNamespace(namespace, sessionId);
    const events: ActivityEvent[] = [];

    for (const key of keys) {
      const item = await store.get(ns, key);
      if (item) {
        events.push(item.value as unknown as ActivityEvent);
      }
    }

    return events;
  }

  async function getSnapshot(
    input?: Parameters<SessionHandle["getSnapshot"]>[0],
  ): Promise<SessionSnapshot> {
    const scope = input?.scope ?? "all";
    const allEvents = await getAllEvents();

    const threadMap = new Map<string, SessionThreadSnapshot>();

    let latestTimestamp: string | undefined;
    let activeThreadId: string | undefined;
    let latestTodos: ActivityEvent["todos"] | undefined;
    const allFiles = new Map<
      string,
      "read" | "write" | "edit" | "delete"
    >();

    for (const event of allEvents) {
      if (!latestTimestamp || event.timestamp > latestTimestamp) {
        latestTimestamp = event.timestamp;
        activeThreadId = event.threadId;
      }

      const existing = threadMap.get(event.threadId);
      const threadEntry = existing ?? {
        threadId: event.threadId,
        parentThreadId: event.parentThreadId,
        agentKind: event.agentKind ?? (event.parentThreadId ? "subagent" : "root"),
        status: "unknown" as "running" | "idle" | "unknown",
        latestStep: undefined as number | undefined,
        latestSummary: undefined as string | undefined,
      };

      if (event.step !== undefined) {
        threadEntry.latestStep = Math.max(
          threadEntry.latestStep ?? 0,
          event.step,
        );
      }

      if (event.summary) {
        threadEntry.latestSummary = event.summary;
      }

      if (event.type === "thread_started") {
        threadEntry.status = "running";
      } else if (
        event.type === "thread_completed" ||
        event.type === "thread_failed"
      ) {
        threadEntry.status = "idle";
      } else if (
        event.type === "model_response" ||
        event.type === "tool_result"
      ) {
        if (threadEntry.status === "unknown") {
          threadEntry.status = "running";
        }
      }

      if (event.parentThreadId) {
        threadEntry.parentThreadId = event.parentThreadId;
      }

      if (event.todos) {
        latestTodos = event.todos;
      }

      if (event.files) {
        for (const f of event.files) {
          allFiles.set(f.path, f.operation);
        }
      }

      threadMap.set(event.threadId, threadEntry);
    }

    let threads = Array.from(threadMap.values());

    if (scope === "active") {
      threads = threads.filter((t) => t.status === "running");
    } else if (scope === "root") {
      threads = threads.filter((t) => t.agentKind === "root");
    }

    if (getState) {
      for (const thread of threads) {
        try {
          const state = await getState(thread.threadId);
          if (state?.values?.todos) {
            latestTodos = state.values.todos;
          }
        } catch {
          // getState enrichment is best-effort
        }
      }
    }

    const files =
      allFiles.size > 0
        ? Array.from(allFiles.entries()).map(([path, operation]) => ({
            path,
            operation,
          }))
        : undefined;

    return {
      session: {
        sessionId,
        running: threads.some((t) => t.status === "running")
          ? true
          : threads.length > 0
            ? false
            : "unknown",
        activeThreadId,
        updatedAt: latestTimestamp,
      },
      threads,
      todos: latestTodos,
      files,
    };
  }

  async function getEvents(
    input?: Parameters<SessionHandle["getEvents"]>[0],
  ) {
    const { after, limit = 20, threadId } = input ?? {};
    return readActivityEvents(store, namespace, sessionId, {
      after,
      limit,
      threadId,
    });
  }

  async function send(input: Parameters<SessionHandle["send"]>[0]) {
    const commandId = crypto.randomUUID();
    const command: ControlCommand = {
      id: commandId,
      sessionId,
      status: "queued",
      createdAt: new Date().toISOString(),
      ...input,
    };

    await writeControlCommand(store, namespace, sessionId, command);

    const queuedEvent: ActivityEvent = {
      id: crypto.randomUUID(),
      sessionId,
      threadId: sessionId,
      type: "control_queued",
      timestamp: new Date().toISOString(),
      controlCommandId: commandId,
      controlKind: input.kind,
      createdBy: input.createdBy,
      summary: `Queued ${input.kind} command`,
    };

    await writeActivityEvent(
      store,
      namespace,
      sessionId,
      queuedEvent,
      DEFAULT_MAX_EVENTS,
    );

    return { commandId, status: "queued" as const };
  }

  async function poll(
    input?: Parameters<SessionHandle["poll"]>[0],
  ): Promise<{
    updates: SessionUpdate[];
    nextCursor?: string;
  }> {
    const page = await getEvents(input);
    return {
      updates: eventsToSessionUpdates(page.events),
      nextCursor: page.nextCursor,
    };
  }

  function subscribe(
    listener: (update: SessionUpdate) => void,
    input?: Parameters<SessionHandle["subscribe"]>[1],
  ): () => void {
    let closed = false;
    let cursor = input?.after;
    const threadId = input?.threadId;
    const limit = input?.limit ?? 20;
    const intervalMs = input?.pollIntervalMs ?? pollIntervalMs;

    const timer = setInterval(async () => {
      if (closed) return;
      try {
        const page = await poll({ after: cursor, limit, threadId });
        for (const update of page.updates) {
          listener(update);
        }
        cursor = page.nextCursor ?? cursor;
      } catch {
        // Subscription polling is best-effort.
      }
    }, intervalMs);

    return () => {
      closed = true;
      clearInterval(timer);
    };
  }

  return {
    getSnapshot,
    getEvents,
    send,
    poll,
    subscribe,
    attachACPClient(options) {
      if (activeAttachment) {
        throw new SessionAttachmentError(
          "single_client_only",
          `Session "${sessionId}" already has an attached client. Multiple clients are not supported yet.`,
        );
      }

      const attachment = createAttachedACPClientSession({
        session: {
          getSnapshot,
          getEvents,
          send,
          poll,
          subscribe,
          attachACPClient: () => {
            throw new SessionAttachmentError(
              "single_client_only",
              `Session "${sessionId}" already has an attached client. Multiple clients are not supported yet.`,
            );
          },
        },
        options,
        onClose: () => {
          if (activeAttachment === attachment) {
            activeAttachment = undefined;
          }
        },
      });

      activeAttachment = attachment;
      return attachment;
    },
  };
}
