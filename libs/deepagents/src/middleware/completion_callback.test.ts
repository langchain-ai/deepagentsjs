/**
 * Tests for the CompletionCallbackMiddleware.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  createCompletionCallbackMiddleware,
  extractLastMessage,
  notifyParent,
  resolveHeaders,
} from "./completion_callback.js";

const mockRunsCreate = vi.fn();
const mockClientConstructor = vi.fn();

vi.mock("@langchain/langgraph-sdk", () => {
  return {
    Client: class MockClient {
      runs = { create: mockRunsCreate };
      constructor(config?: unknown) {
        mockClientConstructor(config);
      }
    },
  };
});

function makeState(opts?: {
  callbackThreadId?: string | null;
  messages?: unknown[];
}): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (opts?.messages !== undefined) {
    state.messages = opts.messages;
  }
  if (opts?.callbackThreadId !== undefined && opts.callbackThreadId !== null) {
    state.callbackThreadId = opts.callbackThreadId;
  }
  return state;
}

function makeRuntime(threadId?: string) {
  return {
    configurable: threadId ? { thread_id: threadId } : {},
  };
}

describe("extractLastMessage", () => {
  it("throws when no messages key", () => {
    expect(() => extractLastMessage({})).toThrow(
      "Expected at least one message",
    );
  });

  it("throws when messages array is empty", () => {
    expect(() => extractLastMessage({ messages: [] })).toThrow(
      "Expected at least one message",
    );
  });

  it("throws on dict-like message (not AIMessage)", () => {
    const state = { messages: [{ content: "hello world" }] };
    expect(() => extractLastMessage(state)).toThrow("Expected an AIMessage");
  });

  it("throws on non-AIMessage message type", () => {
    const msg = new HumanMessage({ content: "hello" });
    const state = { messages: [msg] };
    expect(() => extractLastMessage(state)).toThrow("Expected an AIMessage");
  });

  it("throws on plain value message", () => {
    const state = { messages: [42] };
    expect(() => extractLastMessage(state)).toThrow("Expected an AIMessage");
  });

  it("extracts content from AIMessage object", () => {
    const msg = new AIMessage({ content: "test result" });
    const state = { messages: [msg] };
    expect(extractLastMessage(state)).toBe("test result");
  });

  it("truncates long content with suffix", () => {
    const longContent = "x".repeat(1000);
    const state = { messages: [new AIMessage({ content: longContent })] };
    const result = extractLastMessage(state);
    expect(result).toBe("x".repeat(500) + "... [full result truncated]");
  });

  it("includes task_id hint when truncated and taskId provided", () => {
    const longContent = "x".repeat(1000);
    const state = { messages: [new AIMessage({ content: longContent })] };
    const result = extractLastMessage(state, "task-abc");
    expect(result).toContain("... [full result truncated]");
    expect(result).toContain(
      "Result truncated. Use `check_async_task(task_id='task-abc')` to retrieve the full result if needed.",
    );
  });

  it("does not include task_id hint when not truncated", () => {
    const state = {
      messages: [new AIMessage({ content: "short result" })],
    };
    const result = extractLastMessage(state, "task-abc");
    expect(result).toBe("short result");
    expect(result).not.toContain("truncated");
  });

  it("handles array content blocks from AIMessage", () => {
    const msg = new AIMessage({ content: [{ type: "text", text: "block1" }] });
    const state = { messages: [msg] };
    const result = extractLastMessage(state);
    expect(result).toContain("block1");
  });
});

// ---------------------------------------------------------------------------
// resolveHeaders
// ---------------------------------------------------------------------------

describe("resolveHeaders", () => {
  it("adds x-auth-scheme by default", () => {
    expect(resolveHeaders(undefined)).toEqual({
      "x-auth-scheme": "langsmith",
    });
  });

  it("preserves custom headers", () => {
    const result = resolveHeaders({ "x-custom": "value" });
    expect(result).toEqual({
      "x-custom": "value",
      "x-auth-scheme": "langsmith",
    });
  });

  it("does not override explicit x-auth-scheme", () => {
    const result = resolveHeaders({ "x-auth-scheme": "custom" });
    expect(result).toEqual({ "x-auth-scheme": "custom" });
  });
});

describe("notifyParent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientConstructor.mockClear();
  });

  it("sends a run to the callback thread", async () => {
    mockRunsCreate.mockResolvedValueOnce({});

    await notifyParent("parent-agent", "thread-123", "Job completed", {
      url: "http://localhost:8123",
    });

    expect(mockRunsCreate).toHaveBeenCalledWith("thread-123", "parent-agent", {
      input: {
        messages: [{ role: "user", content: "Job completed" }],
      },
    });
  });

  it("passes url and headers through to client", async () => {
    mockRunsCreate.mockResolvedValueOnce({});

    await notifyParent("parent-agent", "thread-123", "done", {
      url: "https://callback.langsmith.dev",
      headers: { "x-custom": "val" },
    });

    expect(mockClientConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: "https://callback.langsmith.dev",
        defaultHeaders: expect.objectContaining({
          "x-custom": "val",
          "x-auth-scheme": "langsmith",
        }),
      }),
    );
  });

  it("does not override explicit x-auth-scheme", async () => {
    mockRunsCreate.mockResolvedValueOnce({});

    await notifyParent("parent-agent", "thread-123", "done", {
      url: "http://localhost:8123",
      headers: { "x-auth-scheme": "custom" },
    });

    expect(mockClientConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: expect.objectContaining({
          "x-auth-scheme": "custom",
        }),
      }),
    );
  });

  it("works without url (same-deployment ASGI)", async () => {
    mockRunsCreate.mockResolvedValueOnce({});

    await notifyParent("parent-agent", "thread-123", "Job completed");

    expect(mockRunsCreate).toHaveBeenCalledOnce();
  });

  it("swallows exceptions without throwing", async () => {
    mockRunsCreate.mockRejectedValueOnce(new Error("network error"));

    // Should not throw
    await notifyParent("parent-agent", "thread-123", "Job completed", {
      url: "http://localhost:8123",
    });
  });
});

describe("createCompletionCallbackMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has a stateSchema with callbackThreadId", () => {
    const mw = createCompletionCallbackMiddleware({
      callbackGraphId: "parent-agent",
    });
    expect(mw.stateSchema).toBeDefined();
  });

  it("has name CompletionCallbackMiddleware", () => {
    const mw = createCompletionCallbackMiddleware({
      callbackGraphId: "parent-agent",
    });
    expect(mw.name).toBe("CompletionCallbackMiddleware");
  });

  it("accepts url as optional", () => {
    // Should not throw
    const mw = createCompletionCallbackMiddleware({
      callbackGraphId: "parent-agent",
    });
    expect(mw).toBeDefined();
  });

  describe("afterAgent", () => {
    it("sends completion notification when callback_thread_id present", async () => {
      const mw = createCompletionCallbackMiddleware({
        callbackGraphId: "parent-agent",
      });

      mockRunsCreate.mockResolvedValueOnce({});

      const state = makeState({
        callbackThreadId: "thread-123",
        messages: [new AIMessage({ content: "Here is the result" })],
      });

      // @ts-expect-error - afterAgent hook union type
      const result = await mw.afterAgent!(state as any, makeRuntime() as any);

      expect(result).toBeUndefined();
      expect(mockRunsCreate).toHaveBeenCalledOnce();

      const [threadId, assistantId, payload] = mockRunsCreate.mock.calls[0];
      expect(threadId).toBe("thread-123");
      expect(assistantId).toBe("parent-agent");
      expect(payload.input.messages[0].content).toContain("Here is the result");
    });

    it("includes task_id from runtime configurable", async () => {
      const mw = createCompletionCallbackMiddleware({
        callbackGraphId: "parent-agent",
      });

      mockRunsCreate.mockResolvedValueOnce({});

      const state = makeState({
        callbackThreadId: "thread-123",
        messages: [new AIMessage({ content: "result" })],
      });

      // @ts-expect-error - afterAgent hook union type
      await mw.afterAgent!(state as any, makeRuntime("task-789") as any);

      const notification =
        mockRunsCreate.mock.calls[0][2].input.messages[0].content;
      expect(notification).toContain("[task_id=task-789]");
    });

    it("omits task_id prefix when runtime has no thread_id", async () => {
      const mw = createCompletionCallbackMiddleware({
        callbackGraphId: "parent-agent",
      });

      mockRunsCreate.mockResolvedValueOnce({});

      const state = makeState({
        callbackThreadId: "thread-123",
        messages: [new AIMessage({ content: "result" })],
      });

      // @ts-expect-error - afterAgent hook union type
      await mw.afterAgent!(state as any, makeRuntime() as any);

      const notification =
        mockRunsCreate.mock.calls[0][2].input.messages[0].content;
      expect(notification).not.toContain("[task_id=");
    });

    it("throws without callback_thread_id (matches Python KeyError)", async () => {
      const mw = createCompletionCallbackMiddleware({
        callbackGraphId: "parent-agent",
      });

      const state = makeState({
        messages: [new AIMessage({ content: "result" })],
      });

      // @ts-expect-error - afterAgent hook union type
      const promise = mw.afterAgent!(state as any, makeRuntime() as any);
      await expect(promise).rejects.toThrow("callbackThreadId");

      expect(mockRunsCreate).not.toHaveBeenCalled();
    });

    it("includes truncation hint with task_id for long messages", async () => {
      const mw = createCompletionCallbackMiddleware({
        callbackGraphId: "parent-agent",
      });

      mockRunsCreate.mockResolvedValueOnce({});

      const longContent = "x".repeat(1000);
      const state = makeState({
        callbackThreadId: "thread-123",
        messages: [new AIMessage({ content: longContent })],
      });

      // @ts-expect-error - afterAgent hook union type
      await mw.afterAgent!(state as any, makeRuntime("task-789") as any);

      const notification =
        mockRunsCreate.mock.calls[0][2].input.messages[0].content;
      expect(notification).toContain("... [full result truncated]");
      expect(notification).toContain("check_async_task(task_id='task-789')");
    });
  });

  describe("wrapModelCall", () => {
    it("passes through on success without notifying", async () => {
      const mw = createCompletionCallbackMiddleware({
        callbackGraphId: "parent-agent",
      });

      const mockResponse = { content: "model response" };
      const handler = vi.fn().mockResolvedValue(mockResponse);

      const request = {
        state: makeState({ callbackThreadId: "thread-123" }),
        runtime: makeRuntime(),
      };

      const result = await mw.wrapModelCall!(request as any, handler);

      expect(result).toBe(mockResponse);
      expect(handler).toHaveBeenCalledOnce();
      expect(mockRunsCreate).not.toHaveBeenCalled();
    });

    it("sends generic error notification on exception and re-throws", async () => {
      const mw = createCompletionCallbackMiddleware({
        callbackGraphId: "parent-agent",
      });

      mockRunsCreate.mockResolvedValueOnce({});

      const handler = vi.fn().mockRejectedValue(new Error("model crashed"));

      const request = {
        state: makeState({ callbackThreadId: "thread-123" }),
        runtime: makeRuntime("task-789"),
      };

      await expect(mw.wrapModelCall!(request as any, handler)).rejects.toThrow(
        "model crashed",
      );

      expect(mockRunsCreate).toHaveBeenCalledOnce();
      const notification =
        mockRunsCreate.mock.calls[0][2].input.messages[0].content;
      // Should use generic message, NOT leak error details
      expect(notification).toContain(
        "The agent encountered an error while calling the model.",
      );
      expect(notification).not.toContain("model crashed");
    });

    it("includes task_id prefix in error notification", async () => {
      const mw = createCompletionCallbackMiddleware({
        callbackGraphId: "parent-agent",
      });

      mockRunsCreate.mockResolvedValueOnce({});

      const handler = vi.fn().mockRejectedValue(new Error("fail"));

      const request = {
        state: makeState({ callbackThreadId: "thread-123" }),
        runtime: makeRuntime("task-789"),
      };

      await expect(mw.wrapModelCall!(request as any, handler)).rejects.toThrow(
        "fail",
      );

      const notification =
        mockRunsCreate.mock.calls[0][2].input.messages[0].content;
      expect(notification).toContain("[task_id=task-789]");
    });

    it("does not send error notification without callback_thread_id", async () => {
      const mw = createCompletionCallbackMiddleware({
        callbackGraphId: "parent-agent",
      });

      const handler = vi.fn().mockRejectedValue(new Error("model crashed"));

      const request = {
        state: makeState(),
        runtime: makeRuntime(),
      };

      await expect(mw.wrapModelCall!(request as any, handler)).rejects.toThrow(
        "model crashed",
      );

      expect(mockRunsCreate).not.toHaveBeenCalled();
    });

    it("sends error notification on each exception (no dedup)", async () => {
      const mw = createCompletionCallbackMiddleware({
        callbackGraphId: "parent-agent",
      });

      mockRunsCreate.mockResolvedValue({});

      const handler = vi.fn().mockRejectedValue(new Error("fail"));

      const request = {
        state: makeState({ callbackThreadId: "thread-123" }),
        runtime: makeRuntime("task-789"),
      };

      await expect(mw.wrapModelCall!(request as any, handler)).rejects.toThrow(
        "fail",
      );

      await expect(mw.wrapModelCall!(request as any, handler)).rejects.toThrow(
        "fail",
      );

      // Python sends on each error (no dedup guard)
      expect(mockRunsCreate).toHaveBeenCalledTimes(2);
    });
  });
});
