import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

import { createSessionHandle } from "./handle.js";
import {
  DEFAULT_MAX_EVENTS,
  DEFAULT_NAMESPACE,
  writeActivityEvent,
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

describe("SessionHandle ACP integration", () => {
  it(
    "replays and streams updates for an attached client on a seeded observed session",
    { timeout: 60_000 },
    async () => {
      const store = new InMemoryStore();
      const sessionId = "attached-session";
      const session = createSessionHandle({ sessionId, store, pollIntervalMs: 10 });

      await writeActivityEvent(
        store,
        DEFAULT_NAMESPACE,
        sessionId,
        makeEvent({
          sessionId,
          threadId: sessionId,
          type: "model_response",
          content: "I will update the docs next.",
          summary: "Updating docs",
        }),
        DEFAULT_MAX_EVENTS,
      );
      await writeActivityEvent(
        store,
        DEFAULT_NAMESPACE,
        sessionId,
        makeEvent({
          sessionId,
          threadId: sessionId,
          type: "control_applied",
          controlKind: "reminder",
          controlCommandId: "cmd-1",
        }),
        DEFAULT_MAX_EVENTS,
      );

      const attached = session.attachACPClient({
        client: { id: "zed-local", transport: "acp" },
        allowSteering: true,
      });

      const unsubscribe = attached.subscribe(() => {});
      const initial = await attached.getInitialUpdates();
      const page = await attached.poll({ limit: 50 });
      unsubscribe();

      expect(initial.some((update) => update.kind === "snapshot")).toBe(true);
      expect(page.updates.some((update) => update.kind === "message")).toBe(true);
      expect(
        page.updates.some(
          (update) => update.kind === "control_update" && update.control?.status === "applied",
        ),
      ).toBe(true);
    },
  );
});
