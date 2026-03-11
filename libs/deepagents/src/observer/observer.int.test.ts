import { describe, it, expect } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

import { createDeepAgent } from "../agent.js";
import { createObserverMiddleware } from "../middleware/observer.js";
import { createSessionHandle } from "./handle.js";

async function waitForStoreWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("Observer Integration Tests", () => {
  it(
    "end-to-end observation: middleware captures events readable via session handle",
    { timeout: 60_000 },
    async () => {
      const store = new InMemoryStore();
      const checkpointer = new MemorySaver();
      const observerMiddleware = createObserverMiddleware({ store });

      const model = new FakeListChatModel({
        responses: ["I'll help you write a hello world function!"],
      });

      const agent = createDeepAgent({
        model,
        middleware: [observerMiddleware],
        checkpointer,
        store,
      });

      const sessionId = "obs-test-session";
      const threadId = "obs-test-thread";

      await agent.invoke(
        { messages: [{ role: "user", content: "Write a hello world function" }] },
        {
          configurable: { thread_id: threadId, observer_session_id: sessionId },
          context: { thread_id: threadId, observer_session_id: sessionId },
        } as any,
      );

      await waitForStoreWrites();

      const session = createSessionHandle({ sessionId, store });

      const snapshot = await session.getSnapshot();
      expect(snapshot.session.sessionId).toBe(sessionId);
      expect(snapshot.threads.length).toBeGreaterThan(0);

      const rootThread = snapshot.threads.find(
        (t) => t.threadId === threadId,
      );
      expect(rootThread).toBeDefined();

      const page = await session.getEvents({ limit: 50 });
      expect(page.events.length).toBeGreaterThan(0);

      const hasModelResponse = page.events.some(
        (e) => e.type === "model_response",
      );
      expect(hasModelResponse).toBe(true);

      for (const event of page.events) {
        expect(event.sessionId).toBe(sessionId);
        expect(event.threadId).toBe(threadId);
        expect(event.id).toBeDefined();
        expect(event.timestamp).toBeDefined();
      }

      const modelEvent = page.events.find(
        (e) => e.type === "model_response",
      );
      expect(modelEvent).toBeDefined();
      expect(modelEvent!.summary).toBeDefined();
      expect(modelEvent!.content).toBeDefined();
    },
  );

  it(
    "end-to-end steering: queued commands are applied and appear in events",
    { timeout: 60_000 },
    async () => {
      const store = new InMemoryStore();
      const checkpointer = new MemorySaver();
      const observerMiddleware = createObserverMiddleware({ store });

      const model = new FakeListChatModel({
        responses: ["Sure, I'll build something great!"],
      });

      const agent = createDeepAgent({
        model,
        middleware: [observerMiddleware],
        checkpointer,
        store,
      });

      const sessionId = "steer-test-session";
      const threadId = "steer-test-thread";

      const session = createSessionHandle({ sessionId, store });

      const sendResult = await session.send({
        kind: "reminder",
        target: "active",
        payload: { text: "Remember to add tests" },
      });
      expect(sendResult.status).toBe("queued");
      expect(sendResult.commandId).toBeDefined();

      const preEvents = await session.getEvents({ limit: 50 });
      expect(preEvents.events.some((e) => e.type === "control_queued")).toBe(
        true,
      );

      const queuedEvent = preEvents.events.find(
        (e) => e.type === "control_queued",
      );
      expect(queuedEvent).toBeDefined();
      expect(queuedEvent!.controlKind).toBe("reminder");
      expect(queuedEvent!.controlCommandId).toBe(sendResult.commandId);

      await agent.invoke(
        { messages: [{ role: "user", content: "Build something" }] },
        {
          configurable: { thread_id: threadId, observer_session_id: sessionId },
          context: { thread_id: threadId, observer_session_id: sessionId },
        } as any,
      );

      await waitForStoreWrites();

      const postEvents = await session.getEvents({ limit: 50 });

      const hasControlApplied = postEvents.events.some(
        (e) => e.type === "control_applied",
      );
      expect(hasControlApplied).toBe(true);

      const appliedEvent = postEvents.events.find(
        (e) => e.type === "control_applied",
      );
      expect(appliedEvent).toBeDefined();
      expect(appliedEvent!.controlKind).toBe("reminder");
      expect(appliedEvent!.controlCommandId).toBeDefined();

      const hasModelResponse = postEvents.events.some(
        (e) => e.type === "model_response",
      );
      expect(hasModelResponse).toBe(true);

      const eventTypes = postEvents.events.map((e) => e.type);
      const appliedIdx = eventTypes.indexOf("control_applied");
      const modelIdx = eventTypes.indexOf("model_response");
      expect(appliedIdx).toBeLessThan(modelIdx);
    },
  );

  it(
    "session handle getSnapshot reflects correct running state after completion",
    { timeout: 60_000 },
    async () => {
      const store = new InMemoryStore();
      const checkpointer = new MemorySaver();
      const observerMiddleware = createObserverMiddleware({ store });

      const model = new FakeListChatModel({
        responses: ["Task complete."],
      });

      const agent = createDeepAgent({
        model,
        middleware: [observerMiddleware],
        checkpointer,
        store,
      });

      const sessionId = "snapshot-test-session";
      const threadId = "snapshot-test-thread";

      await agent.invoke(
        { messages: [{ role: "user", content: "Do something simple" }] },
        {
          configurable: { thread_id: threadId, observer_session_id: sessionId },
          context: { thread_id: threadId, observer_session_id: sessionId },
        } as any,
      );

      await waitForStoreWrites();

      const session = createSessionHandle({ sessionId, store });
      const snapshot = await session.getSnapshot();

      expect(snapshot.session.sessionId).toBe(sessionId);
      expect(snapshot.session.updatedAt).toBeDefined();
      expect(snapshot.threads.length).toBeGreaterThan(0);

      const thread = snapshot.threads.find((t) => t.threadId === threadId);
      expect(thread).toBeDefined();
      expect(thread!.agentKind).toBe("root");
    },
  );

  it(
    "multiple steering commands are all applied in a single model call",
    { timeout: 60_000 },
    async () => {
      const store = new InMemoryStore();
      const checkpointer = new MemorySaver();
      const observerMiddleware = createObserverMiddleware({ store });

      const model = new FakeListChatModel({
        responses: ["Done with all reminders applied."],
      });

      const agent = createDeepAgent({
        model,
        middleware: [observerMiddleware],
        checkpointer,
        store,
      });

      const sessionId = "multi-steer-session";
      const threadId = "multi-steer-thread";

      const session = createSessionHandle({ sessionId, store });

      await session.send({
        kind: "reminder",
        target: "active",
        payload: { text: "First reminder" },
      });

      await session.send({
        kind: "message",
        target: "active",
        payload: { text: "A message for you" },
      });

      await agent.invoke(
        { messages: [{ role: "user", content: "Proceed with the task" }] },
        {
          configurable: { thread_id: threadId, observer_session_id: sessionId },
          context: { thread_id: threadId, observer_session_id: sessionId },
        } as any,
      );

      await waitForStoreWrites();

      const events = await session.getEvents({ limit: 50 });

      const controlAppliedEvents = events.events.filter(
        (e) => e.type === "control_applied",
      );
      expect(controlAppliedEvents.length).toBe(2);

      const appliedKinds = controlAppliedEvents.map((e) => e.controlKind);
      expect(appliedKinds).toContain("reminder");
      expect(appliedKinds).toContain("message");

      const controlQueuedEvents = events.events.filter(
        (e) => e.type === "control_queued",
      );
      expect(controlQueuedEvents.length).toBe(2);
    },
  );
});
