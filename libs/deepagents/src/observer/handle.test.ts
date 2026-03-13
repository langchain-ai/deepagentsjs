import { describe, it, expect, vi } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

import { createSessionHandle } from "./handle.js";
import {
  DEFAULT_NAMESPACE,
  writeActivityEvent,
  DEFAULT_MAX_EVENTS,
} from "./store.js";
import type { ActivityEvent } from "./types.js";

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: "session-1",
    threadId: "thread-1",
    type: "model_response",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function seedEvents(
  store: InMemoryStore,
  sessionId: string,
  events: ActivityEvent[],
): Promise<void> {
  for (const event of events) {
    await writeActivityEvent(
      store,
      DEFAULT_NAMESPACE,
      sessionId,
      event,
      DEFAULT_MAX_EVENTS,
    );
  }
}

describe("createSessionHandle", () => {
  describe("getSnapshot", () => {
    it("returns valid snapshot with no threads when no events exist", async () => {
      const store = new InMemoryStore();
      const session = createSessionHandle({
        sessionId: "s1",
        store,
      });

      const snapshot = await session.getSnapshot();
      expect(snapshot.session.sessionId).toBe("s1");
      expect(snapshot.session.running).toBe("unknown");
      expect(snapshot.threads).toEqual([]);
      expect(snapshot.todos).toBeUndefined();
      expect(snapshot.files).toBeUndefined();
    });

    it("returns correct thread after model_response events", async () => {
      const store = new InMemoryStore();
      await seedEvents(store, "s1", [
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          type: "model_response",
          step: 1,
          summary: "Working on auth",
        }),
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          type: "model_response",
          step: 2,
          summary: "Refactoring middleware",
        }),
      ]);

      const session = createSessionHandle({ sessionId: "s1", store });
      const snapshot = await session.getSnapshot();

      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0].threadId).toBe("t1");
      expect(snapshot.threads[0].latestStep).toBe(2);
      expect(snapshot.threads[0].latestSummary).toBe("Refactoring middleware");
      expect(snapshot.threads[0].status).toBe("running");
    });

    it("groups events from root and subagent threads correctly", async () => {
      const store = new InMemoryStore();
      await seedEvents(store, "s1", [
        makeEvent({
          sessionId: "s1",
          threadId: "s1",
          agentKind: "root",
          type: "model_response",
          step: 1,
          summary: "Root work",
        }),
        makeEvent({
          sessionId: "s1",
          threadId: "s1/sub-1",
          parentThreadId: "s1",
          agentKind: "subagent",
          type: "model_response",
          step: 1,
          summary: "Subagent work",
        }),
      ]);

      const session = createSessionHandle({ sessionId: "s1", store });
      const snapshot = await session.getSnapshot();

      expect(snapshot.threads).toHaveLength(2);
      const root = snapshot.threads.find((t) => t.agentKind === "root");
      const sub = snapshot.threads.find((t) => t.agentKind === "subagent");
      expect(root).toBeDefined();
      expect(sub).toBeDefined();
      expect(sub!.parentThreadId).toBe("s1");
    });

    it("scope 'active' excludes completed threads", async () => {
      const store = new InMemoryStore();
      await seedEvents(store, "s1", [
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          type: "thread_started",
        }),
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          type: "thread_completed",
        }),
        makeEvent({
          sessionId: "s1",
          threadId: "t2",
          type: "thread_started",
        }),
      ]);

      const session = createSessionHandle({ sessionId: "s1", store });
      const snapshot = await session.getSnapshot({ scope: "active" });

      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0].threadId).toBe("t2");
    });

    it("scope 'root' returns only root threads", async () => {
      const store = new InMemoryStore();
      await seedEvents(store, "s1", [
        makeEvent({
          sessionId: "s1",
          threadId: "s1",
          agentKind: "root",
          type: "model_response",
        }),
        makeEvent({
          sessionId: "s1",
          threadId: "s1/sub-1",
          parentThreadId: "s1",
          agentKind: "subagent",
          type: "model_response",
        }),
      ]);

      const session = createSessionHandle({ sessionId: "s1", store });
      const snapshot = await session.getSnapshot({ scope: "root" });

      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0].agentKind).toBe("root");
    });

    it("aggregates todos from latest todo_snapshot event", async () => {
      const store = new InMemoryStore();
      await seedEvents(store, "s1", [
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          type: "model_response",
          todos: [{ content: "Task A", status: "pending" }],
        }),
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          type: "model_response",
          todos: [
            { content: "Task A", status: "completed" },
            { content: "Task B", status: "in_progress" },
          ],
        }),
      ]);

      const session = createSessionHandle({ sessionId: "s1", store });
      const snapshot = await session.getSnapshot();

      expect(snapshot.todos).toHaveLength(2);
      expect(snapshot.todos![0].status).toBe("completed");
    });

    it("deduplicates and aggregates files from events", async () => {
      const store = new InMemoryStore();
      await seedEvents(store, "s1", [
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          type: "tool_result",
          files: [{ path: "/src/a.ts", operation: "read" }],
        }),
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          type: "tool_result",
          files: [{ path: "/src/a.ts", operation: "edit" }],
        }),
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          type: "tool_result",
          files: [{ path: "/src/b.ts", operation: "write" }],
        }),
      ]);

      const session = createSessionHandle({ sessionId: "s1", store });
      const snapshot = await session.getSnapshot();

      expect(snapshot.files).toBeDefined();
      expect(snapshot.files!.length).toBe(2);
      const aPaths = snapshot.files!.filter((f) => f.path === "/src/a.ts");
      expect(aPaths).toHaveLength(1);
      expect(aPaths[0].operation).toBe("edit");
    });

    it("enriches with getState when provided", async () => {
      const store = new InMemoryStore();
      await seedEvents(store, "s1", [
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          type: "model_response",
        }),
      ]);

      const mockGetState = vi.fn().mockResolvedValue({
        values: {
          todos: [{ content: "From checkpoint", status: "pending" }],
        },
      });

      const session = createSessionHandle({
        sessionId: "s1",
        store,
        getState: mockGetState,
      });

      const snapshot = await session.getSnapshot();

      expect(mockGetState).toHaveBeenCalledWith("t1");
      expect(snapshot.todos).toEqual([
        { content: "From checkpoint", status: "pending" },
      ]);
    });
  });

  describe("getEvents", () => {
    it("returns events with cursor-based pagination", async () => {
      const store = new InMemoryStore();
      for (let i = 0; i < 10; i++) {
        await seedEvents(store, "s1", [
          makeEvent({
            sessionId: "s1",
            threadId: "t1",
            summary: `event-${i}`,
          }),
        ]);
      }

      const session = createSessionHandle({ sessionId: "s1", store });

      const page1 = await session.getEvents({ limit: 3 });
      expect(page1.events).toHaveLength(3);
      expect(page1.events[0].summary).toBe("event-0");
      expect(page1.nextCursor).toBeDefined();

      const page2 = await session.getEvents({
        limit: 3,
        after: page1.nextCursor,
      });
      expect(page2.events).toHaveLength(3);
      expect(page2.events[0].summary).toBe("event-3");
    });

    it("respects limit parameter", async () => {
      const store = new InMemoryStore();
      for (let i = 0; i < 10; i++) {
        await seedEvents(store, "s1", [
          makeEvent({ sessionId: "s1", threadId: "t1" }),
        ]);
      }

      const session = createSessionHandle({ sessionId: "s1", store });

      const page = await session.getEvents({ limit: 5 });
      expect(page.events).toHaveLength(5);
    });

    it("filters by threadId", async () => {
      const store = new InMemoryStore();
      await seedEvents(store, "s1", [
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          summary: "t1-event",
        }),
        makeEvent({
          sessionId: "s1",
          threadId: "t2",
          summary: "t2-event",
        }),
        makeEvent({
          sessionId: "s1",
          threadId: "t1",
          summary: "t1-event-2",
        }),
      ]);

      const session = createSessionHandle({ sessionId: "s1", store });

      const page = await session.getEvents({ threadId: "t1" });
      expect(page.events).toHaveLength(2);
      expect(page.events.every((e) => e.threadId === "t1")).toBe(true);
    });

    it("returns empty page when no events exist", async () => {
      const store = new InMemoryStore();
      const session = createSessionHandle({ sessionId: "s1", store });

      const page = await session.getEvents();
      expect(page.events).toEqual([]);
      expect(page.nextCursor).toBeUndefined();
    });
  });

  describe("send", () => {
    it("writes a queued command and control_queued event", async () => {
      const store = new InMemoryStore();
      const session = createSessionHandle({ sessionId: "s1", store });

      const result = await session.send({
        kind: "reminder",
        target: "active",
        payload: { text: "Update the docs" },
      });

      expect(result.status).toBe("queued");
      expect(result.commandId).toBeDefined();

      const page = await session.getEvents();
      const queuedEvents = page.events.filter(
        (e) => e.type === "control_queued",
      );
      expect(queuedEvents).toHaveLength(1);
      expect(queuedEvents[0].controlKind).toBe("reminder");
      expect(queuedEvents[0].controlCommandId).toBe(result.commandId);
    });

    it("supports all command kinds", async () => {
      const store = new InMemoryStore();
      const session = createSessionHandle({ sessionId: "s1", store });

      const kinds = [
        "message",
        "reminder",
        "add_todo",
        "update_todo",
        "set_guidance",
      ] as const;

      for (const kind of kinds) {
        const result = await session.send({
          kind,
          target: "active",
          payload: { text: `${kind} payload` },
        });
        expect(result.status).toBe("queued");
      }

      const page = await session.getEvents({ limit: 50 });
      expect(
        page.events.filter((e) => e.type === "control_queued"),
      ).toHaveLength(kinds.length);
    });

    it("includes createdBy in the command", async () => {
      const store = new InMemoryStore();
      const session = createSessionHandle({ sessionId: "s1", store });

      await session.send({
        kind: "reminder",
        target: "active",
        createdBy: "companion",
        payload: { text: "From companion" },
      });

      const page = await session.getEvents();
      expect(page.events).toHaveLength(1);
    });
  });
});
