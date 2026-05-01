import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  callTask,
  dispatch,
  deduplicateFailures,
  mergeResult,
} from "./executor.js";

// ---------------------------------------------------------------------------
// globalThis.tools stub for PTC task tool
// ---------------------------------------------------------------------------

beforeEach(() => {
  (globalThis as Record<string, unknown>).tools = {
    task: vi.fn(
      async ({ description }: { description: string }) =>
        `Result for: ${description}`,
    ),
  };
});

// ---------------------------------------------------------------------------
// callTask
// ---------------------------------------------------------------------------

describe("callTask", () => {
  it("calls tools.task and returns the result", async () => {
    const result = await callTask({
      description: "do something",
      subagent_type: "general-purpose",
    });
    expect(result).toBe("Result for: do something");
  });

  it("forwards response_schema when provided", async () => {
    const schema = { type: "object", properties: { x: { type: "number" } } };
    await callTask({
      description: "structured",
      subagent_type: "analyst",
      response_schema: schema,
    });

    const taskFn = (globalThis as Record<string, unknown>).tools as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(taskFn.task).toHaveBeenCalledWith({
      description: "structured",
      subagent_type: "analyst",
      response_schema: schema,
    });
  });

  it("throws when task tool is not configured", async () => {
    (globalThis as Record<string, unknown>).tools = {};
    await expect(
      callTask({ description: "x", subagent_type: "general-purpose" }),
    ).rejects.toThrow("task");
  });
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe("dispatch", () => {
  it("dispatches a single task and returns a completed result", async () => {
    const results = await dispatch(
      [{ id: "r1", prompt: "hello", subagentType: "general-purpose" }],
      { concurrency: 1 },
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: "r1",
      status: "completed",
      result: "Result for: hello",
    });
  });

  it("preserves input order with multiple tasks", async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      prompt: `task ${i}`,
      subagentType: "general-purpose",
    }));
    const results = await dispatch(tasks, { concurrency: 3 });
    expect(results.map((r) => r.id)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(results.every((r) => r.status === "completed")).toBe(true);
  });

  it("captures errors as failed results", async () => {
    (globalThis as Record<string, unknown>).tools = {
      task: vi.fn(async () => {
        throw new Error("subagent timeout");
      }),
    };

    const results = await dispatch(
      [{ id: "r1", prompt: "fail", subagentType: "general-purpose" }],
      { concurrency: 1 },
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toBe("subagent timeout");
  });

  it("handles non-Error throws", async () => {
    (globalThis as Record<string, unknown>).tools = {
      task: vi.fn(async () => {
        throw "string error";
      }),
    };

    const results = await dispatch(
      [{ id: "r1", prompt: "fail", subagentType: "general-purpose" }],
      { concurrency: 1 },
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toBe("string error");
  });

  it("bounds concurrency to task count", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    (globalThis as Record<string, unknown>).tools = {
      task: vi.fn(async ({ description }: { description: string }) => {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) {
          maxConcurrent = currentConcurrent;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentConcurrent--;
        return `done: ${description}`;
      }),
    };

    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `r${i}`,
      prompt: `task ${i}`,
      subagentType: "general-purpose",
    }));
    await dispatch(tasks, { concurrency: 3 });
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("includes response_schema only when present", async () => {
    const taskFn = vi.fn(async () => "ok");
    (globalThis as Record<string, unknown>).tools = { task: taskFn };

    await dispatch(
      [{ id: "r1", prompt: "no schema", subagentType: "general-purpose" }],
      { concurrency: 1 },
    );
    expect(taskFn.mock.calls[0][0]).not.toHaveProperty("response_schema");

    const schema = { type: "object" };
    await dispatch(
      [
        {
          id: "r2",
          prompt: "with schema",
          subagentType: "analyst",
          responseSchema: schema,
        },
      ],
      { concurrency: 1 },
    );
    expect(taskFn.mock.calls[1][0].response_schema).toEqual(schema);
  });

  it("returns empty array for empty input", async () => {
    const results = await dispatch([], { concurrency: 5 });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deduplicateFailures
// ---------------------------------------------------------------------------

describe("deduplicateFailures", () => {
  it("groups failures by error message", () => {
    const results = deduplicateFailures([
      { id: "r1", status: "failed", error: "timeout" },
      { id: "r2", status: "failed", error: "timeout" },
      { id: "r3", status: "failed", error: "rate limit" },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      error: "timeout",
      count: 2,
      ids: ["r1", "r2"],
    });
    expect(results[1]).toEqual({
      error: "rate limit",
      count: 1,
      ids: ["r3"],
    });
  });

  it("sorts by count descending", () => {
    const results = deduplicateFailures([
      { id: "r1", status: "failed", error: "a" },
      { id: "r2", status: "failed", error: "b" },
      { id: "r3", status: "failed", error: "b" },
      { id: "r4", status: "failed", error: "b" },
    ]);
    expect(results[0].error).toBe("b");
    expect(results[0].count).toBe(3);
    expect(results[1].error).toBe("a");
    expect(results[1].count).toBe(1);
  });

  it("skips completed results", () => {
    const results = deduplicateFailures([
      { id: "r1", status: "completed", result: "ok" },
      { id: "r2", status: "failed", error: "err" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].ids).toEqual(["r2"]);
  });

  it("returns empty array when no failures", () => {
    expect(
      deduplicateFailures([{ id: "r1", status: "completed", result: "ok" }]),
    ).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(deduplicateFailures([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeResult
// ---------------------------------------------------------------------------

describe("mergeResult", () => {
  it("spreads object properties onto the row", () => {
    const row: Record<string, unknown> = { id: "r1", file: "a.ts" };
    mergeResult(row, "result", { sentiment: "positive", confidence: 0.95 });
    expect(row.sentiment).toBe("positive");
    expect(row.confidence).toBe(0.95);
  });

  it("does not overwrite reserved column 'id'", () => {
    const row: Record<string, unknown> = { id: "r1", file: "a.ts" };
    mergeResult(row, "result", { id: "overwritten", score: 5 });
    expect(row.id).toBe("r1");
    expect(row.score).toBe(5);
  });

  it("does not overwrite reserved column 'file'", () => {
    const row: Record<string, unknown> = { id: "r1", file: "a.ts" };
    mergeResult(row, "result", { file: "overwritten", score: 5 });
    expect(row.file).toBe("a.ts");
    expect(row.score).toBe(5);
  });

  it("stores a string under the column name", () => {
    const row: Record<string, unknown> = { id: "r1" };
    mergeResult(row, "review", "looks good");
    expect(row.review).toBe("looks good");
  });

  it("stores a number under the column name", () => {
    const row: Record<string, unknown> = { id: "r1" };
    mergeResult(row, "score", 42);
    expect(row.score).toBe(42);
  });

  it("stores an array under the column name", () => {
    const row: Record<string, unknown> = { id: "r1" };
    mergeResult(row, "tags", ["a", "b"]);
    expect(row.tags).toEqual(["a", "b"]);
  });

  it("stores null under the column name", () => {
    const row: Record<string, unknown> = { id: "r1" };
    mergeResult(row, "result", null);
    expect(row.result).toBeNull();
  });
});
