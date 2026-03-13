import { describe, expect, it } from "vitest";

import {
  eventToSessionUpdate,
  eventsToSessionUpdates,
  snapshotToSessionUpdate,
  todosToPlanEntries,
} from "./updates.js";
import type { ActivityEvent, SessionSnapshot, TodoItem } from "./types.js";

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

describe("observer updates", () => {
  it("converts todos into plan entries", () => {
    const todos: TodoItem[] = [
      { id: "a", content: "Pending", status: "pending" },
      { id: "b", content: "Cancelled", status: "cancelled" },
    ];

    expect(todosToPlanEntries(todos)).toEqual([
      { id: "a", content: "Pending", status: "pending", priority: "medium" },
      { id: "b", content: "Cancelled", status: "skipped", priority: "medium" },
    ]);
  });

  it("creates snapshot updates", () => {
    const snapshot: SessionSnapshot = {
      session: {
        sessionId: "session-1",
        running: true,
        activeThreadId: "thread-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      threads: [
        {
          threadId: "thread-1",
          agentKind: "root",
          status: "running",
          latestSummary: "Working",
        },
      ],
      todos: [{ content: "Task", status: "in_progress" }],
      files: [{ path: "/tmp/a.ts", operation: "edit" }],
    };

    const update = snapshotToSessionUpdate(snapshot);
    expect(update.kind).toBe("snapshot");
    expect(update.plan?.[0].status).toBe("in_progress");
    expect(update.files?.[0].path).toBe("/tmp/a.ts");
  });

  it("maps model response events into message updates", () => {
    const update = eventToSessionUpdate(
      makeEvent({
        type: "model_response",
        content: "hello",
        summary: "Responded",
        step: 2,
      }),
    );

    expect(update.kind).toBe("message");
    expect(update.message?.content).toBe("hello");
    expect(update.message?.step).toBe(2);
  });

  it("maps tool results into tool updates", () => {
    const update = eventToSessionUpdate(
      makeEvent({
        type: "tool_result",
        toolName: "write_file",
        success: true,
        summary: "Created file",
        files: [{ path: "/tmp/a.ts", operation: "write" }],
      }),
    );

    expect(update.kind).toBe("tool_update");
    expect(update.tool?.kind).toBe("edit");
    expect(update.tool?.locations?.[0].path).toBe("/tmp/a.ts");
  });

  it("maps control events into control updates", () => {
    const updates = eventsToSessionUpdates([
      makeEvent({
        type: "control_queued",
        controlCommandId: "cmd-1",
        controlKind: "reminder",
      }),
      makeEvent({
        type: "control_applied",
        controlCommandId: "cmd-1",
        controlKind: "reminder",
      }),
    ]);

    expect(updates[0].control?.status).toBe("queued");
    expect(updates[1].control?.status).toBe("applied");
  });
});
