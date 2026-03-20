/**
 * Tests for the CompletionNotifierMiddleware.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import {
  createCompletionNotifierMiddleware,
  extractLastMessage,
  notifyParent,
} from "./completion_notifier.js";

// ---------------------------------------------------------------------------
// Mock the @langchain/langgraph-sdk Client
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(opts?: {
  parentThreadId?: string | null;
  messages?: unknown[];
}): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (opts?.messages !== undefined) {
    state.messages = opts.messages;
  }
  if (opts?.parentThreadId !== undefined && opts.parentThreadId !== null) {
    state.parent_thread_id = opts.parentThreadId;
  }
  return state;
}

function makeRuntime(threadId?: string) {
  return {
    configurable: threadId ? { thread_id: threadId } : {},
  };
}

// ---------------------------------------------------------------------------
// extractLastMessage
// ---------------------------------------------------------------------------

describe("extractLastMessage", () => {
  it("returns '(no output)' when no messages key", () => {
    expect(extractLastMessage({})).toBe("(no output)");
  });

  it("returns '(no output)' when messages array is empty", () => {
    expect(extractLastMessage({ messages: [] })).toBe("(no output)");
  });

  it("extracts content from dict-like message", () => {
    const state = { messages: [{ content: "hello world" }] };
    expect(extractLastMessage(state)).toBe("hello world");
  });

  it("extracts content from AIMessage object", () => {
    const msg = new AIMessage({ content: "test result" });
    const state = { messages: [msg] };
    expect(extractLastMessage(state)).toBe("test result");
  });

  it("truncates long content to 500 characters", () => {
    const longContent = "x".repeat(1000);
    const state = { messages: [{ content: longContent }] };
    const result = extractLastMessage(state);
    expect(result.length).toBe(500);
  });

  it("converts non-string content to string", () => {
    const msg = new AIMessage({ content: [{ type: "text", text: "block1" }] });
    const state = { messages: [msg] };
    const result = extractLastMessage(state);
    expect(result).toContain("block1");
  });

  it("converts plain value message to string", () => {
    const state = { messages: [42] };
    expect(extractLastMessage(state)).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// notifyParent
// ---------------------------------------------------------------------------

describe("notifyParent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientConstructor.mockClear();
  });

  it("sends a run to the parent thread", async () => {
    mockRunsCreate.mockResolvedValueOnce({});

    await notifyParent("thread-123", "supervisor", "Job completed", {
      url: "http://localhost:8123",
    });

    expect(mockRunsCreate).toHaveBeenCalledWith("thread-123", "supervisor", {
      input: {
        messages: [{ role: "user", content: "Job completed" }],
      },
    });
  });

  it("passes url and headers through to client", async () => {
    mockRunsCreate.mockResolvedValueOnce({});

    await notifyParent("thread-123", "supervisor", "done", {
      url: "https://supervisor.langsmith.dev",
      headers: { "x-custom": "val" },
    });

    expect(mockClientConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: "https://supervisor.langsmith.dev",
        defaultHeaders: expect.objectContaining({
          "x-custom": "val",
          "x-auth-scheme": "langsmith",
        }),
      }),
    );
  });

  it("does not override explicit x-auth-scheme", async () => {
    mockRunsCreate.mockResolvedValueOnce({});

    await notifyParent("thread-123", "supervisor", "done", {
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

  it("swallows exceptions without throwing", async () => {
    mockRunsCreate.mockRejectedValueOnce(new Error("network error"));

    // Should not throw
    await notifyParent("thread-123", "supervisor", "Job completed", {
      url: "http://localhost:8123",
    });
  });
});

// ---------------------------------------------------------------------------
// createCompletionNotifierMiddleware
// ---------------------------------------------------------------------------

describe("createCompletionNotifierMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has a stateSchema with parent_thread_id", () => {
    const mw = createCompletionNotifierMiddleware({
      parentGraphId: "supervisor",
      url: "http://localhost:8123",
    });
    expect(mw.stateSchema).toBeDefined();
  });

  it("has name CompletionNotifierMiddleware", () => {
    const mw = createCompletionNotifierMiddleware({
      parentGraphId: "supervisor",
      url: "http://localhost:8123",
    });
    expect(mw.name).toBe("CompletionNotifierMiddleware");
  });

  describe("afterAgent", () => {
    it("sends completion notification when parent_thread_id present", async () => {
      const mw = createCompletionNotifierMiddleware({
        parentGraphId: "supervisor",
      });

      mockRunsCreate.mockResolvedValueOnce({});

      const state = makeState({
        parentThreadId: "thread-123",
        messages: [new AIMessage({ content: "Here is the result" })],
      });

      // @ts-expect-error - afterAgent hook union type
      const result = await mw.afterAgent!(state as any, makeRuntime() as any);

      expect(result).toBeUndefined();
      expect(mockRunsCreate).toHaveBeenCalledOnce();

      const [threadId, assistantId, payload] = mockRunsCreate.mock.calls[0];
      expect(threadId).toBe("thread-123");
      expect(assistantId).toBe("supervisor");
      expect(payload.input.messages[0].content).toContain("Here is the result");
    });

    it("includes task_id from runtime configurable", async () => {
      const mw = createCompletionNotifierMiddleware({
        parentGraphId: "supervisor",
      });

      mockRunsCreate.mockResolvedValueOnce({});

      const state = makeState({
        parentThreadId: "thread-123",
        messages: [new AIMessage({ content: "result" })],
      });

      // @ts-expect-error - afterAgent hook union type
      await mw.afterAgent!(state as any, makeRuntime("task-789") as any);

      const notification =
        mockRunsCreate.mock.calls[0][2].input.messages[0].content;
      expect(notification).toContain("[task_id=task-789]");
    });

    it("omits task_id prefix when runtime has no thread_id", async () => {
      const mw = createCompletionNotifierMiddleware({
        parentGraphId: "supervisor",
      });

      mockRunsCreate.mockResolvedValueOnce({});

      const state = makeState({
        parentThreadId: "thread-123",
        messages: [new AIMessage({ content: "result" })],
      });

      // @ts-expect-error - afterAgent hook union type
      await mw.afterAgent!(state as any, makeRuntime() as any);

      const notification =
        mockRunsCreate.mock.calls[0][2].input.messages[0].content;
      expect(notification).not.toContain("[task_id=");
    });

    it("does not notify without parent_thread_id", async () => {
      const mw = createCompletionNotifierMiddleware({
        parentGraphId: "supervisor",
      });

      const state = makeState({
        messages: [new AIMessage({ content: "result" })],
      });

      // @ts-expect-error - afterAgent hook union type
      await mw.afterAgent!(state as any, makeRuntime() as any);

      expect(mockRunsCreate).not.toHaveBeenCalled();
    });

    it("notifies only once across multiple afterAgent calls", async () => {
      const mw = createCompletionNotifierMiddleware({
        parentGraphId: "supervisor",
      });

      mockRunsCreate.mockResolvedValue({});

      const state = makeState({
        parentThreadId: "thread-123",
        messages: [new AIMessage({ content: "result" })],
      });

      // @ts-expect-error - afterAgent hook union type
      await mw.afterAgent!(state as any, makeRuntime() as any);
      // @ts-expect-error - afterAgent hook union type
      await mw.afterAgent!(state as any, makeRuntime() as any);

      expect(mockRunsCreate).toHaveBeenCalledOnce();
    });
  });

  describe("wrapModelCall", () => {
    it("passes through on success without notifying", async () => {
      const mw = createCompletionNotifierMiddleware({
        parentGraphId: "supervisor",
      });

      const mockResponse = { content: "model response" };
      const handler = vi.fn().mockResolvedValue(mockResponse);

      const request = {
        state: makeState({ parentThreadId: "thread-123" }),
        runtime: makeRuntime(),
      };

      const result = await mw.wrapModelCall!(request as any, handler);

      expect(result).toBe(mockResponse);
      expect(handler).toHaveBeenCalledOnce();
      expect(mockRunsCreate).not.toHaveBeenCalled();
    });

    it("sends error notification on exception and re-throws", async () => {
      const mw = createCompletionNotifierMiddleware({
        parentGraphId: "supervisor",
      });

      mockRunsCreate.mockResolvedValueOnce({});

      const handler = vi.fn().mockRejectedValue(new Error("model crashed"));

      const request = {
        state: makeState({ parentThreadId: "thread-123" }),
        runtime: makeRuntime(),
      };

      await expect(mw.wrapModelCall!(request as any, handler)).rejects.toThrow(
        "model crashed",
      );

      expect(mockRunsCreate).toHaveBeenCalledOnce();
      const notification =
        mockRunsCreate.mock.calls[0][2].input.messages[0].content;
      expect(notification).toContain("model crashed");
    });

    it("does not send error notification without parent_thread_id", async () => {
      const mw = createCompletionNotifierMiddleware({
        parentGraphId: "supervisor",
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

    it("sends error notification only once across retries", async () => {
      const mw = createCompletionNotifierMiddleware({
        parentGraphId: "supervisor",
      });

      mockRunsCreate.mockResolvedValue({});

      const handler = vi.fn().mockRejectedValue(new Error("fail"));

      const request = {
        state: makeState({ parentThreadId: "thread-123" }),
        runtime: makeRuntime(),
      };

      await expect(mw.wrapModelCall!(request as any, handler)).rejects.toThrow(
        "fail",
      );

      await expect(mw.wrapModelCall!(request as any, handler)).rejects.toThrow(
        "fail",
      );

      expect(mockRunsCreate).toHaveBeenCalledOnce();
    });
  });
});
