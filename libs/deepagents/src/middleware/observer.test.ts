import { describe, it, expect, vi } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { SystemMessage } from "@langchain/core/messages";

import { createObserverMiddleware } from "./observer.js";
import {
  DEFAULT_NAMESPACE,
  readActivityEvents,
  writeControlCommand,
} from "../observer/store.js";
import type { ControlCommand } from "../observer/types.js";

function makeModelRequest(overrides: Record<string, any> = {}) {
  return {
    systemMessage: new SystemMessage("You are a helpful assistant."),
    messages: [new HumanMessage("Hello")],
    state: {},
    runtime: {
      configurable: {
        thread_id: "thread-1",
        observer_session_id: "session-1",
      },
      store: new InMemoryStore(),
    },
    tools: [],
    ...overrides,
  };
}

function makeToolRequest(overrides: Record<string, any> = {}) {
  return {
    toolCall: {
      id: "call-1",
      name: "read_file",
      args: { path: "/src/index.ts" },
    },
    state: {},
    runtime: {
      configurable: {
        thread_id: "thread-1",
        observer_session_id: "session-1",
      },
      store: new InMemoryStore(),
    },
    ...overrides,
  };
}

function makeModelResponse(overrides: Record<string, any> = {}) {
  return {
    messages: [
      new HumanMessage("Hello"),
      new AIMessage("Hi there! How can I help?"),
    ],
    ...overrides,
  };
}

async function waitForStoreWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("createObserverMiddleware", () => {
  describe("wrapModelCall", () => {
    it("returns handler response unchanged (passthrough)", async () => {
      const middleware = createObserverMiddleware();
      const response = makeModelResponse();
      const handler = vi.fn().mockResolvedValue(response);

      const result = await middleware.wrapModelCall!(
        makeModelRequest() as any,
        handler,
      );

      expect(result).toBe(response);
    });

    it("calls the handler with the request", async () => {
      const middleware = createObserverMiddleware();
      const request = makeModelRequest();
      const handler = vi.fn().mockResolvedValue(makeModelResponse());

      await middleware.wrapModelCall!(request as any, handler);

      expect(handler).toHaveBeenCalled();
    });

    it("writes a model_response event to the store", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware();

      const request = makeModelRequest({
        runtime: {
          configurable: {
            thread_id: "t1",
            observer_session_id: "s1",
          },
          store,
        },
      });

      const response = makeModelResponse();
      const handler = vi.fn().mockResolvedValue(response);

      await middleware.wrapModelCall!(request as any, handler);
      await waitForStoreWrites();

      const { events } = await readActivityEvents(
        store,
        DEFAULT_NAMESPACE,
        "s1",
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("model_response");
      expect(events[0].sessionId).toBe("s1");
      expect(events[0].threadId).toBe("t1");
      expect(events[0].content).toContain("Hi there!");
    });

    it("truncates long content", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware();
      const longText = "x".repeat(5000);

      const request = makeModelRequest({
        runtime: {
          configurable: { thread_id: "t1", observer_session_id: "s1" },
          store,
        },
      });

      const response = {
        messages: [new HumanMessage("Hi"), new AIMessage(longText)],
      };
      const handler = vi.fn().mockResolvedValue(response);

      await middleware.wrapModelCall!(request as any, handler);
      await waitForStoreWrites();

      const { events } = await readActivityEvents(
        store,
        DEFAULT_NAMESPACE,
        "s1",
      );
      expect(events[0].content!.length).toBeLessThanOrEqual(2000);
      expect(events[0].content!.endsWith("...")).toBe(true);
    });

    it("captures tool calls from AI message", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware();

      const request = makeModelRequest({
        runtime: {
          configurable: { thread_id: "t1", observer_session_id: "s1" },
          store,
        },
      });

      const aiMsg = new AIMessage({
        content: "Let me read the file.",
        tool_calls: [
          { name: "read_file", args: { path: "/src/index.ts" }, id: "tc-1" },
        ],
      });

      const response = {
        messages: [new HumanMessage("Hi"), aiMsg],
      };
      const handler = vi.fn().mockResolvedValue(response);

      await middleware.wrapModelCall!(request as any, handler);
      await waitForStoreWrites();

      const { events } = await readActivityEvents(
        store,
        DEFAULT_NAMESPACE,
        "s1",
      );
      expect(events[0].toolCalls).toHaveLength(1);
      expect(events[0].toolCalls![0].name).toBe("read_file");
    });

    it("skips event when capture.modelResponses is false", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware({
        capture: { modelResponses: false },
      });

      const request = makeModelRequest({
        runtime: {
          configurable: { thread_id: "t1", observer_session_id: "s1" },
          store,
        },
      });

      const handler = vi.fn().mockResolvedValue(makeModelResponse());

      await middleware.wrapModelCall!(request as any, handler);
      await waitForStoreWrites();

      const { events } = await readActivityEvents(
        store,
        DEFAULT_NAMESPACE,
        "s1",
      );
      expect(events).toHaveLength(0);
    });

    it("degrades gracefully when store is missing", async () => {
      const middleware = createObserverMiddleware();

      const request = makeModelRequest({
        runtime: { configurable: { thread_id: "t1" } },
      });

      const response = makeModelResponse();
      const handler = vi.fn().mockResolvedValue(response);

      const result = await middleware.wrapModelCall!(request as any, handler);
      expect(result).toBe(response);
    });

    it("degrades gracefully when thread_id is missing", async () => {
      const middleware = createObserverMiddleware();

      const request = makeModelRequest({
        runtime: { configurable: {}, store: new InMemoryStore() },
      });

      const response = makeModelResponse();
      const handler = vi.fn().mockResolvedValue(response);

      const result = await middleware.wrapModelCall!(request as any, handler);
      expect(result).toBe(response);
    });

    it("falls back to thread_id when observer_session_id is missing", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware();

      const request = makeModelRequest({
        runtime: {
          configurable: { thread_id: "fallback-thread" },
          store,
        },
      });

      const handler = vi.fn().mockResolvedValue(makeModelResponse());

      await middleware.wrapModelCall!(request as any, handler);
      await waitForStoreWrites();

      const { events } = await readActivityEvents(
        store,
        DEFAULT_NAMESPACE,
        "fallback-thread",
      );
      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe("fallback-thread");
    });
  });

  describe("wrapToolCall", () => {
    it("returns handler result unchanged (passthrough)", async () => {
      const middleware = createObserverMiddleware();
      const toolResult = new ToolMessage({
        content: "File content here",
        tool_call_id: "call-1",
        name: "read_file",
      });
      const handler = vi.fn().mockResolvedValue(toolResult);

      const result = await middleware.wrapToolCall!(
        makeToolRequest() as any,
        handler,
      );

      expect(result).toBe(toolResult);
    });

    it("writes a tool_result event to the store", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware();

      const request = makeToolRequest({
        runtime: {
          configurable: { thread_id: "t1", observer_session_id: "s1" },
          store,
        },
      });

      const toolResult = new ToolMessage({
        content: "File content here",
        tool_call_id: "call-1",
        name: "read_file",
      });
      const handler = vi.fn().mockResolvedValue(toolResult);

      await middleware.wrapToolCall!(request as any, handler);
      await waitForStoreWrites();

      const { events } = await readActivityEvents(
        store,
        DEFAULT_NAMESPACE,
        "s1",
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("tool_result");
      expect(events[0].toolName).toBe("read_file");
      expect(events[0].success).toBe(true);
    });

    it("detects error results", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware();

      const request = makeToolRequest({
        runtime: {
          configurable: { thread_id: "t1", observer_session_id: "s1" },
          store,
        },
      });

      const toolResult = new ToolMessage({
        content: "Error: File not found",
        tool_call_id: "call-1",
        name: "read_file",
      });
      const handler = vi.fn().mockResolvedValue(toolResult);

      await middleware.wrapToolCall!(request as any, handler);
      await waitForStoreWrites();

      const { events } = await readActivityEvents(
        store,
        DEFAULT_NAMESPACE,
        "s1",
      );
      expect(events[0].success).toBe(false);
    });

    it("extracts file paths from file tool calls", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware();

      const request = makeToolRequest({
        toolCall: {
          id: "call-1",
          name: "write_file",
          args: { path: "/src/new-file.ts" },
        },
        runtime: {
          configurable: { thread_id: "t1", observer_session_id: "s1" },
          store,
        },
      });

      const toolResult = new ToolMessage({
        content: "File written",
        tool_call_id: "call-1",
        name: "write_file",
      });
      const handler = vi.fn().mockResolvedValue(toolResult);

      await middleware.wrapToolCall!(request as any, handler);
      await waitForStoreWrites();

      const { events } = await readActivityEvents(
        store,
        DEFAULT_NAMESPACE,
        "s1",
      );
      expect(events[0].files).toEqual([
        { path: "/src/new-file.ts", operation: "write" },
      ]);
    });

    it("skips event when capture.toolResults is false", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware({
        capture: { toolResults: false },
      });

      const request = makeToolRequest({
        runtime: {
          configurable: { thread_id: "t1", observer_session_id: "s1" },
          store,
        },
      });

      const toolResult = new ToolMessage({
        content: "result",
        tool_call_id: "call-1",
        name: "read_file",
      });
      const handler = vi.fn().mockResolvedValue(toolResult);

      await middleware.wrapToolCall!(request as any, handler);
      await waitForStoreWrites();

      const { events } = await readActivityEvents(
        store,
        DEFAULT_NAMESPACE,
        "s1",
      );
      expect(events).toHaveLength(0);
    });

    it("degrades gracefully when store is missing", async () => {
      const middleware = createObserverMiddleware();

      const request = makeToolRequest({
        runtime: { configurable: { thread_id: "t1" } },
      });

      const toolResult = new ToolMessage({
        content: "result",
        tool_call_id: "call-1",
        name: "read_file",
      });
      const handler = vi.fn().mockResolvedValue(toolResult);

      const result = await middleware.wrapToolCall!(request as any, handler);
      expect(result).toBe(toolResult);
    });
  });

  describe("control command application", () => {
    it("claims and injects pending control commands before model call", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware();

      const cmd: ControlCommand = {
        id: "cmd-1",
        sessionId: "s1",
        target: "active",
        status: "queued",
        createdAt: new Date().toISOString(),
        kind: "reminder",
        payload: { text: "Update the docs before continuing" },
      };

      await writeControlCommand(store, DEFAULT_NAMESPACE, "s1", cmd);

      const request = makeModelRequest({
        runtime: {
          configurable: { thread_id: "t1", observer_session_id: "s1" },
          store,
        },
      });

      const handler = vi.fn().mockResolvedValue(makeModelResponse());

      await middleware.wrapModelCall!(request as any, handler);

      const calledRequest = handler.mock.calls[0][0];
      const messages = calledRequest.messages;
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.content).toContain("Update the docs before continuing");
      expect(lastMsg.content).toContain("[reminder]");
    });

    it("does not re-claim already applied commands", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware();

      const cmd: ControlCommand = {
        id: "cmd-1",
        sessionId: "s1",
        target: "active",
        status: "queued",
        createdAt: new Date().toISOString(),
        kind: "reminder",
        payload: { text: "Do something" },
      };

      await writeControlCommand(store, DEFAULT_NAMESPACE, "s1", cmd);

      const request = makeModelRequest({
        runtime: {
          configurable: { thread_id: "t1", observer_session_id: "s1" },
          store,
        },
      });

      const handler = vi.fn().mockResolvedValue(makeModelResponse());

      await middleware.wrapModelCall!(request as any, handler);

      const firstCallMessages = handler.mock.calls[0][0].messages;
      expect(
        firstCallMessages.some((m: any) =>
          typeof m.content === "string" && m.content.includes("Do something"),
        ),
      ).toBe(true);

      const handler2 = vi.fn().mockResolvedValue(makeModelResponse());
      await middleware.wrapModelCall!(request as any, handler2);

      const secondCallMessages = handler2.mock.calls[0][0].messages;
      expect(
        secondCallMessages.some((m: any) =>
          typeof m.content === "string" &&
          m.content.includes("Steering Commands"),
        ),
      ).toBe(false);
    });

    it("writes control_applied events", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware();

      const cmd: ControlCommand = {
        id: "cmd-1",
        sessionId: "s1",
        target: "active",
        status: "queued",
        createdAt: new Date().toISOString(),
        kind: "message",
        payload: { text: "Pay attention" },
      };

      await writeControlCommand(store, DEFAULT_NAMESPACE, "s1", cmd);

      const request = makeModelRequest({
        runtime: {
          configurable: { thread_id: "t1", observer_session_id: "s1" },
          store,
        },
      });

      const handler = vi.fn().mockResolvedValue(makeModelResponse());
      await middleware.wrapModelCall!(request as any, handler);
      await waitForStoreWrites();

      const { events } = await readActivityEvents(
        store,
        DEFAULT_NAMESPACE,
        "s1",
        { limit: 50 },
      );
      const appliedEvents = events.filter((e) => e.type === "control_applied");
      expect(appliedEvents.length).toBeGreaterThanOrEqual(1);
      expect(appliedEvents[0].controlKind).toBe("message");
    });

    it("does not inject commands when enableControl is false", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware({ enableControl: false });

      const cmd: ControlCommand = {
        id: "cmd-1",
        sessionId: "s1",
        target: "active",
        status: "queued",
        createdAt: new Date().toISOString(),
        kind: "reminder",
        payload: { text: "Should not appear" },
      };

      await writeControlCommand(store, DEFAULT_NAMESPACE, "s1", cmd);

      const request = makeModelRequest({
        runtime: {
          configurable: { thread_id: "t1", observer_session_id: "s1" },
          store,
        },
      });

      const handler = vi.fn().mockResolvedValue(makeModelResponse());
      await middleware.wrapModelCall!(request as any, handler);

      const calledRequest = handler.mock.calls[0][0];
      const hasInjection = calledRequest.messages.some((m: any) =>
        typeof m.content === "string" &&
        m.content.includes("Steering Commands"),
      );
      expect(hasInjection).toBe(false);
    });
  });

  describe("event eviction", () => {
    it("evicts oldest events when maxEvents is exceeded", async () => {
      const store = new InMemoryStore();
      const middleware = createObserverMiddleware({ maxEvents: 3 });

      for (let i = 0; i < 5; i++) {
        const request = makeModelRequest({
          runtime: {
            configurable: { thread_id: "t1", observer_session_id: "s1" },
            store,
          },
        });

        const response = {
          messages: [
            new HumanMessage("Hi"),
            new AIMessage(`Response ${i}`),
          ],
        };
        const handler = vi.fn().mockResolvedValue(response);

        await middleware.wrapModelCall!(request as any, handler);
        await waitForStoreWrites();
      }

      const { events } = await readActivityEvents(
        store,
        DEFAULT_NAMESPACE,
        "s1",
        { limit: 10 },
      );
      expect(events.length).toBeLessThanOrEqual(3);
    });
  });
});
