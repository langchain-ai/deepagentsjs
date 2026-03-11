import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

import {
  INDEX_KEY,
  DEFAULT_NAMESPACE,
  DEFAULT_MAX_EVENTS,
  getEventsNamespace,
  getControlNamespace,
  getThreadNamespace,
  makeEventKey,
  makeControlKey,
  writeActivityEvent,
  readActivityEvents,
  writeControlCommand,
  claimPendingControlCommands,
  readIndex,
} from "./store.js";
import type { ActivityEvent, ControlCommand } from "./types.js";

function makeEvent(
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: "session-1",
    threadId: "thread-1",
    type: "model_response",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeCommand(
  overrides: Partial<ControlCommand> = {},
): ControlCommand {
  return {
    id: crypto.randomUUID(),
    sessionId: "session-1",
    target: "active",
    status: "queued",
    createdAt: new Date().toISOString(),
    kind: "reminder",
    payload: { text: "Remember to update docs" },
    ...overrides,
  };
}

describe("namespace helpers", () => {
  it("getEventsNamespace builds correct path", () => {
    expect(getEventsNamespace(["observer"], "s1")).toEqual([
      "observer",
      "s1",
      "events",
    ]);
  });

  it("getControlNamespace builds correct path", () => {
    expect(getControlNamespace(["observer"], "s1")).toEqual([
      "observer",
      "s1",
      "control",
    ]);
  });

  it("getThreadNamespace builds correct path", () => {
    expect(getThreadNamespace(["observer"], "s1", "t1")).toEqual([
      "observer",
      "s1",
      "threads",
      "t1",
    ]);
  });

  it("supports custom base namespace", () => {
    expect(getEventsNamespace(["custom", "ns"], "s1")).toEqual([
      "custom",
      "ns",
      "s1",
      "events",
    ]);
  });
});

describe("key generators", () => {
  it("makeEventKey zero-pads the sequence", () => {
    expect(makeEventKey(0)).toBe("event-00000000");
    expect(makeEventKey(42)).toBe("event-00000042");
    expect(makeEventKey(12345)).toBe("event-00012345");
  });

  it("makeControlKey zero-pads the sequence", () => {
    expect(makeControlKey(0)).toBe("cmd-00000000");
    expect(makeControlKey(7)).toBe("cmd-00000007");
  });
});

describe("constants", () => {
  it("has expected defaults", () => {
    expect(INDEX_KEY).toBe("_index");
    expect(DEFAULT_NAMESPACE).toEqual(["observer"]);
    expect(DEFAULT_MAX_EVENTS).toBe(100);
  });
});

describe("writeActivityEvent / readActivityEvents", () => {
  it("writes and reads a single event", async () => {
    const store = new InMemoryStore();
    const event = makeEvent({ summary: "hello" });

    await writeActivityEvent(store, DEFAULT_NAMESPACE, "s1", event);

    const { events } = await readActivityEvents(
      store,
      DEFAULT_NAMESPACE,
      "s1",
    );
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe("hello");
    expect(events[0].id).toBe(event.id);
  });

  it("writes multiple events in order", async () => {
    const store = new InMemoryStore();

    for (let i = 0; i < 5; i++) {
      await writeActivityEvent(
        store,
        DEFAULT_NAMESPACE,
        "s1",
        makeEvent({ summary: `event-${i}` }),
      );
    }

    const { events } = await readActivityEvents(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      { limit: 10 },
    );
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.summary)).toEqual([
      "event-0",
      "event-1",
      "event-2",
      "event-3",
      "event-4",
    ]);
  });

  it("evicts oldest events when maxEvents is exceeded", async () => {
    const store = new InMemoryStore();
    const maxEvents = 3;

    for (let i = 0; i < 5; i++) {
      await writeActivityEvent(
        store,
        DEFAULT_NAMESPACE,
        "s1",
        makeEvent({ summary: `event-${i}` }),
        maxEvents,
      );
    }

    const { events } = await readActivityEvents(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      { limit: 10 },
    );
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.summary)).toEqual([
      "event-2",
      "event-3",
      "event-4",
    ]);

    const keys = await readIndex(store, DEFAULT_NAMESPACE, "s1");
    expect(keys).toHaveLength(3);
  });

  it("cursor-based pagination with after", async () => {
    const store = new InMemoryStore();

    for (let i = 0; i < 5; i++) {
      await writeActivityEvent(
        store,
        DEFAULT_NAMESPACE,
        "s1",
        makeEvent({ summary: `event-${i}` }),
      );
    }

    const firstPage = await readActivityEvents(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      { limit: 2 },
    );
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.events[0].summary).toBe("event-0");
    expect(firstPage.events[1].summary).toBe("event-1");
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = await readActivityEvents(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      { limit: 2, after: firstPage.nextCursor },
    );
    expect(secondPage.events).toHaveLength(2);
    expect(secondPage.events[0].summary).toBe("event-2");
    expect(secondPage.events[1].summary).toBe("event-3");
    expect(secondPage.nextCursor).toBeDefined();

    const thirdPage = await readActivityEvents(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      { limit: 2, after: secondPage.nextCursor },
    );
    expect(thirdPage.events).toHaveLength(1);
    expect(thirdPage.events[0].summary).toBe("event-4");
    expect(thirdPage.nextCursor).toBeUndefined();
  });

  it("filters by threadId", async () => {
    const store = new InMemoryStore();

    await writeActivityEvent(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      makeEvent({ threadId: "thread-a", summary: "a1" }),
    );
    await writeActivityEvent(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      makeEvent({ threadId: "thread-b", summary: "b1" }),
    );
    await writeActivityEvent(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      makeEvent({ threadId: "thread-a", summary: "a2" }),
    );

    const { events } = await readActivityEvents(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      { threadId: "thread-a" },
    );
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.summary)).toEqual(["a1", "a2"]);
  });

  it("returns empty when no events exist", async () => {
    const store = new InMemoryStore();
    const { events, nextCursor } = await readActivityEvents(
      store,
      DEFAULT_NAMESPACE,
      "s1",
    );
    expect(events).toEqual([]);
    expect(nextCursor).toBeUndefined();
  });
});

describe("readIndex", () => {
  it("returns empty array when index does not exist", async () => {
    const store = new InMemoryStore();
    const keys = await readIndex(store, DEFAULT_NAMESPACE, "s1");
    expect(keys).toEqual([]);
  });

  it("returns keys after events are written", async () => {
    const store = new InMemoryStore();

    await writeActivityEvent(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      makeEvent(),
    );
    await writeActivityEvent(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      makeEvent(),
    );

    const keys = await readIndex(store, DEFAULT_NAMESPACE, "s1");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe("event-00000000");
    expect(keys[1]).toBe("event-00000001");
  });
});

describe("writeControlCommand / claimPendingControlCommands", () => {
  it("writes and claims a control command", async () => {
    const store = new InMemoryStore();
    const cmd = makeCommand();

    await writeControlCommand(store, DEFAULT_NAMESPACE, "s1", cmd);
    const claimed = await claimPendingControlCommands(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      "thread-1",
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("applied");
    expect(claimed[0].kind).toBe("reminder");
  });

  it("does not re-claim already applied commands", async () => {
    const store = new InMemoryStore();
    const cmd = makeCommand();

    await writeControlCommand(store, DEFAULT_NAMESPACE, "s1", cmd);

    const first = await claimPendingControlCommands(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      "thread-1",
    );
    expect(first).toHaveLength(1);

    const second = await claimPendingControlCommands(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      "thread-1",
    );
    expect(second).toHaveLength(0);
  });

  it("respects target: root", async () => {
    const store = new InMemoryStore();
    const cmd = makeCommand({ target: "root" });

    await writeControlCommand(store, DEFAULT_NAMESPACE, "s1", cmd);

    const fromSubagent = await claimPendingControlCommands(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      "s1/subagent-1",
    );
    expect(fromSubagent).toHaveLength(0);

    const fromRoot = await claimPendingControlCommands(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      "s1",
    );
    expect(fromRoot).toHaveLength(1);
  });

  it("respects target: { threadId }", async () => {
    const store = new InMemoryStore();
    const cmd = makeCommand({
      target: { threadId: "specific-thread" },
    });

    await writeControlCommand(store, DEFAULT_NAMESPACE, "s1", cmd);

    const wrong = await claimPendingControlCommands(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      "other-thread",
    );
    expect(wrong).toHaveLength(0);

    const correct = await claimPendingControlCommands(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      "specific-thread",
    );
    expect(correct).toHaveLength(1);
  });

  it("target: all matches any thread", async () => {
    const store = new InMemoryStore();
    const cmd = makeCommand({ target: "all" });

    await writeControlCommand(store, DEFAULT_NAMESPACE, "s1", cmd);

    const claimed = await claimPendingControlCommands(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      "any-thread",
    );
    expect(claimed).toHaveLength(1);
  });

  it("claims multiple queued commands at once", async () => {
    const store = new InMemoryStore();

    await writeControlCommand(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      makeCommand({ kind: "reminder", payload: { text: "first" } }),
    );
    await writeControlCommand(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      makeCommand({ kind: "message", payload: { text: "second" } }),
    );

    const claimed = await claimPendingControlCommands(
      store,
      DEFAULT_NAMESPACE,
      "s1",
      "thread-1",
    );
    expect(claimed).toHaveLength(2);
    expect(claimed.every((c) => c.status === "applied")).toBe(true);
  });
});
