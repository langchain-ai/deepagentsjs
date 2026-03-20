/**
 * Unit tests for QueueLookaheadMiddleware.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { getConfig } from "@langchain/langgraph";

import {
  createQueueLookaheadMiddleware,
  extractMessagesFromRun,
  convertToHumanMessages,
  type RunWithKwargs,
} from "./queue_lookahead.js";

// ---------------------------------------------------------------------------
// Mock getConfig from @langchain/langgraph so getThreadId() works outside
// a real graph execution context.
// ---------------------------------------------------------------------------
vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/langgraph")>();
  return {
    ...actual,
    getConfig: vi.fn(() => ({
      configurable: { thread_id: "test-thread-1" },
    })),
  };
});

// ---------------------------------------------------------------------------
// Helper: build a fake pending run dict
// ---------------------------------------------------------------------------
function makePendingRun(runId: string, content: string): RunWithKwargs {
  return {
    run_id: runId,
    thread_id: "test-thread-1",
    assistant_id: "agent",
    created_at: "",
    updated_at: "",
    status: "pending",
    metadata: {},
    multitask_strategy: "enqueue",
    kwargs: {
      input: {
        messages: [{ role: "user", content }],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helper extraction tests
// ---------------------------------------------------------------------------

describe("extractMessagesFromRun", () => {
  it("extracts messages from kwargs", () => {
    const run = makePendingRun("r1", "hello");
    const result = extractMessagesFromRun(run);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  it("returns empty when no kwargs", () => {
    const run = makePendingRun("r1", "hello");
    delete run.kwargs;
    expect(extractMessagesFromRun(run)).toEqual([]);
  });

  it("returns empty when no input", () => {
    const run = makePendingRun("r1", "hello");
    run.kwargs = {};
    expect(extractMessagesFromRun(run)).toEqual([]);
  });

  it("returns empty when no messages", () => {
    const run = makePendingRun("r1", "hello");
    run.kwargs = { input: {} };
    expect(extractMessagesFromRun(run)).toEqual([]);
  });

  it("returns empty when input is not an object", () => {
    const run = makePendingRun("r1", "hello");
    run.kwargs = { input: "string" as any };
    expect(extractMessagesFromRun(run)).toEqual([]);
  });

  it("extracts multiple messages", () => {
    const run = makePendingRun("r1", "first");
    run.kwargs!.input!.messages = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ];
    const result = extractMessagesFromRun(run);
    expect(result).toHaveLength(2);
  });
});

describe("convertToHumanMessages", () => {
  it("converts user messages", () => {
    const raw = [{ role: "user", content: "hello" }];
    const result = convertToHumanMessages(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(HumanMessage);
    expect(result[0].content).toBe("hello");
  });

  it("converts human role", () => {
    const raw = [{ role: "human", content: "hello" }];
    const result = convertToHumanMessages(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(HumanMessage);
  });

  it("ignores non-user messages", () => {
    const raw = [
      { role: "assistant", content: "hi" },
      { role: "system", content: "you are helpful" },
      { role: "user", content: "real message" },
    ];
    const result = convertToHumanMessages(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("real message");
  });

  it("ignores empty content", () => {
    const raw = [{ role: "user", content: "" }];
    const result = convertToHumanMessages(raw);
    expect(result).toHaveLength(0);
  });

  it("handles empty input", () => {
    expect(convertToHumanMessages([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Middleware construction tests
// ---------------------------------------------------------------------------

describe("createQueueLookaheadMiddleware", () => {
  describe("construction", () => {
    it("can be constructed with no args", () => {
      const middleware = createQueueLookaheadMiddleware();
      expect(middleware).toBeDefined();
      expect(middleware.beforeModel).toBeDefined();
    });

    it("accepts explicit client", () => {
      const mockClient = { runs: { list: vi.fn(), cancel: vi.fn() } };
      const middleware = createQueueLookaheadMiddleware({
        client: mockClient as any,
      });
      expect(middleware).toBeDefined();
    });

    it("accepts custom cancel action", () => {
      const middleware = createQueueLookaheadMiddleware({
        cancelAction: "rollback",
      });
      expect(middleware).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // beforeModel tests
  // ---------------------------------------------------------------------------

  describe("beforeModel", () => {
    let mockClient: {
      runs: {
        list: ReturnType<typeof vi.fn>;
        cancel: ReturnType<typeof vi.fn>;
      };
    };

    beforeEach(() => {
      mockClient = {
        runs: {
          list: vi.fn(),
          cancel: vi.fn(),
        },
      };
      vi.clearAllMocks();
      // Reset default: return a config with thread_id
      vi.mocked(getConfig).mockReturnValue({
        configurable: { thread_id: "test-thread-1" },
      });
    });

    it("returns undefined when no thread_id", async () => {
      vi.mocked(getConfig).mockReturnValueOnce({ configurable: {} });

      const middleware = createQueueLookaheadMiddleware({
        client: mockClient as any,
      });

      // @ts-expect-error - testing hook directly
      const result = await middleware.beforeModel?.(
        { messages: [new HumanMessage({ content: "original" })] },
        {},
      );

      expect(result).toBeUndefined();
      expect(mockClient.runs.list).not.toHaveBeenCalled();
    });

    it("returns undefined when getConfig throws (no graph context)", async () => {
      vi.mocked(getConfig).mockImplementationOnce(() => {
        throw new Error("No graph context");
      });

      const middleware = createQueueLookaheadMiddleware({
        client: mockClient as any,
      });

      // @ts-expect-error - testing hook directly
      const result = await middleware.beforeModel?.(
        { messages: [new HumanMessage({ content: "original" })] },
        {},
      );

      expect(result).toBeUndefined();
      expect(mockClient.runs.list).not.toHaveBeenCalled();
    });

    it("returns undefined when no pending runs", async () => {
      mockClient.runs.list.mockResolvedValue([]);

      const middleware = createQueueLookaheadMiddleware({
        client: mockClient as any,
      });

      // @ts-expect-error - testing hook directly
      const result = await middleware.beforeModel?.(
        { messages: [new HumanMessage({ content: "original" })] },
        {},
      );

      expect(mockClient.runs.list).toHaveBeenCalledWith("test-thread-1", {
        status: "pending",
        select: ["run_id", "kwargs"],
      });
      expect(result).toBeUndefined();
    });

    it("returns messages state update from pending runs", async () => {
      mockClient.runs.list.mockResolvedValue([
        makePendingRun("pending-run-1", "follow-up"),
      ]);
      mockClient.runs.cancel.mockResolvedValue(undefined);

      const middleware = createQueueLookaheadMiddleware({
        client: mockClient as any,
      });

      // @ts-expect-error - testing hook directly
      const result = await middleware.beforeModel?.(
        { messages: [new HumanMessage({ content: "original" })] },
        {},
      );

      expect(result).not.toBeUndefined();
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toBeInstanceOf(HumanMessage);
      expect(result.messages[0].content).toBe("follow-up");

      // Pending run should have been cancelled
      expect(mockClient.runs.cancel).toHaveBeenCalledWith(
        "test-thread-1",
        "pending-run-1",
        false,
        "interrupt",
      );
    });

    it("handles multiple pending runs", async () => {
      mockClient.runs.list.mockResolvedValue([
        makePendingRun("run-1", "msg1"),
        makePendingRun("run-2", "msg2"),
      ]);
      mockClient.runs.cancel.mockResolvedValue(undefined);

      const middleware = createQueueLookaheadMiddleware({
        client: mockClient as any,
      });

      // @ts-expect-error - testing hook directly
      const result = await middleware.beforeModel?.(
        { messages: [new HumanMessage({ content: "original" })] },
        {},
      );

      // Both runs cancelled
      expect(mockClient.runs.cancel).toHaveBeenCalledTimes(2);

      // State update contains messages from both runs
      expect(result).not.toBeUndefined();
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toBe("msg1");
      expect(result.messages[1].content).toBe("msg2");
    });

    it("returns undefined when list fails", async () => {
      mockClient.runs.list.mockRejectedValue(new Error("network error"));

      const middleware = createQueueLookaheadMiddleware({
        client: mockClient as any,
      });

      // @ts-expect-error - testing hook directly
      const result = await middleware.beforeModel?.(
        { messages: [new HumanMessage({ content: "original" })] },
        {},
      );

      expect(result).toBeUndefined();
    });

    it("still returns messages even if cancel fails", async () => {
      mockClient.runs.list.mockResolvedValue([makePendingRun("run-1", "msg")]);
      mockClient.runs.cancel.mockRejectedValue(new Error("cancel failed"));

      const middleware = createQueueLookaheadMiddleware({
        client: mockClient as any,
      });

      // @ts-expect-error - testing hook directly
      const result = await middleware.beforeModel?.(
        { messages: [new HumanMessage({ content: "original" })] },
        {},
      );

      expect(result).not.toBeUndefined();
      expect(result.messages).toHaveLength(1);
    });

    it("filters non-user messages from pending runs", async () => {
      const run = makePendingRun("run-1", "user msg");
      run.kwargs!.input!.messages = [
        { role: "system", content: "sys msg" },
        { role: "user", content: "user msg" },
        { role: "assistant", content: "ai msg" },
      ];
      mockClient.runs.list.mockResolvedValue([run]);
      mockClient.runs.cancel.mockResolvedValue(undefined);

      const middleware = createQueueLookaheadMiddleware({
        client: mockClient as any,
      });

      // @ts-expect-error - testing hook directly
      const result = await middleware.beforeModel?.(
        { messages: [new HumanMessage({ content: "original" })] },
        {},
      );

      expect(result).not.toBeUndefined();
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("user msg");
    });

    it("uses custom cancel action", async () => {
      mockClient.runs.list.mockResolvedValue([makePendingRun("run-1", "msg")]);
      mockClient.runs.cancel.mockResolvedValue(undefined);

      const middleware = createQueueLookaheadMiddleware({
        client: mockClient as any,
        cancelAction: "rollback",
      });

      // @ts-expect-error - testing hook directly
      await middleware.beforeModel?.(
        { messages: [new HumanMessage({ content: "original" })] },
        {},
      );

      expect(mockClient.runs.cancel).toHaveBeenCalledWith(
        "test-thread-1",
        "run-1",
        false,
        "rollback",
      );
    });

    it("lazily resolves client on first use", async () => {
      mockClient.runs.list.mockResolvedValue([]);

      const middleware = createQueueLookaheadMiddleware({
        client: mockClient as any,
      });

      // @ts-expect-error - testing hook directly
      await middleware.beforeModel?.(
        { messages: [new HumanMessage({ content: "original" })] },
        {},
      );

      // The explicitly provided client should have been used
      expect(mockClient.runs.list).toHaveBeenCalled();
    });
  });
});
