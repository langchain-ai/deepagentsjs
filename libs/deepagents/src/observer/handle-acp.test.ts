import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

import { createSessionHandle } from "./handle.js";
import {
  DEFAULT_MAX_EVENTS,
  DEFAULT_NAMESPACE,
  writeActivityEvent,
} from "./store.js";
import { SessionAttachmentError } from "./types.js";
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

describe("SessionHandle ACP attachment", () => {
  it("polls normalized updates from activity events", async () => {
    const store = new InMemoryStore();
    await seedEvents(store, "s1", [
      makeEvent({
        sessionId: "s1",
        threadId: "s1",
        type: "model_response",
        content: "hello",
      }),
      makeEvent({
        sessionId: "s1",
        threadId: "s1",
        type: "tool_result",
        toolName: "write_file",
        success: true,
        files: [{ path: "/tmp/a.ts", operation: "write" }],
      }),
    ]);

    const session = createSessionHandle({ sessionId: "s1", store });
    const page = await session.poll({ limit: 10 });

    expect(page.updates).toHaveLength(2);
    expect(page.updates[0].kind).toBe("message");
    expect(page.updates[1].kind).toBe("tool_update");
  });

  it("replays initial updates for an attached client", async () => {
    const store = new InMemoryStore();
    await seedEvents(store, "s1", [
      makeEvent({
        sessionId: "s1",
        threadId: "s1",
        type: "model_response",
        content: "hello",
      }),
    ]);

    const session = createSessionHandle({ sessionId: "s1", store });
    const attached = session.attachACPClient({
      client: { id: "zed-local", transport: "acp" },
      historyLimit: 10,
    });

    const initial = await attached.getInitialUpdates();
    expect(initial[0].kind).toBe("snapshot");
    expect(initial[1].kind).toBe("message");
  });

  it("enforces the single-client limit", async () => {
    const store = new InMemoryStore();
    const session = createSessionHandle({ sessionId: "s1", store });
    session.attachACPClient({ client: { id: "first" } });

    expect(() =>
      session.attachACPClient({ client: { id: "second" } }),
    ).toThrow(SessionAttachmentError);
  });

  it("allows a new attach after close", async () => {
    const store = new InMemoryStore();
    const session = createSessionHandle({ sessionId: "s1", store });
    const attached = session.attachACPClient({ client: { id: "first" } });

    attached.close();

    expect(() =>
      session.attachACPClient({ client: { id: "second" } }),
    ).not.toThrow();
  });

  it("blocks steering by default", async () => {
    const store = new InMemoryStore();
    const session = createSessionHandle({ sessionId: "s1", store });
    const attached = session.attachACPClient({ client: { id: "read-only" } });

    await expect(
      attached.steer({
        kind: "reminder",
        target: "active",
        payload: { text: "remember" },
      }),
    ).rejects.toMatchObject({ code: "steer_not_allowed" });
  });

  it("routes steering through SessionHandle.send with attribution", async () => {
    const store = new InMemoryStore();
    const session = createSessionHandle({ sessionId: "s1", store });
    const attached = session.attachACPClient({
      client: { id: "web", transport: "web-ui" },
      allowSteering: true,
    });

    const result = await attached.steer({
      kind: "reminder",
      target: "active",
      payload: { text: "remember" },
    });

    expect(result.status).toBe("queued");

    const page = await session.getEvents({ limit: 10 });
    const queued = page.events.find((event) => event.type === "control_queued");
    expect(queued?.createdBy).toBe("web-ui:web");
  });

  it("throws explicit unsupported lifecycle errors", async () => {
    const store = new InMemoryStore();
    const session = createSessionHandle({ sessionId: "s1", store });
    const attached = session.attachACPClient({ client: { id: "zed" } });

    await expect(attached.lifecycle("session/new")).rejects.toMatchObject({
      code: "unsupported_operation",
      operation: "session/new",
    });
  });

  it("subscribes to live updates by polling", async () => {
    const store = new InMemoryStore();
    const session = createSessionHandle({
      sessionId: "s1",
      store,
      pollIntervalMs: 10,
    });
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener, { pollIntervalMs: 10 });

    await seedEvents(store, "s1", [
      makeEvent({
        sessionId: "s1",
        threadId: "s1",
        type: "model_response",
        content: "hello",
      }),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    unsubscribe();

    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls[0][0].kind).toBe("message");
  });
});
