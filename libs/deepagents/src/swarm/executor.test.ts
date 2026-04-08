import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeSwarm } from "./executor.js";
import type { SwarmExecutionOptions } from "./executor.js";
import type { SwarmTaskSpec } from "./types.js";
import { TASK_TIMEOUT_SECONDS } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSubagent(
  result: Record<string, unknown> = { messages: [{ content: "result text" }] },
) {
  return { invoke: vi.fn().mockResolvedValue(result) };
}

function makeBackend(opts: { uploadFiles?: boolean } = {}) {
  const backend: Record<string, any> = {
    write: vi.fn().mockResolvedValue({ path: "/tasks.jsonl" }),
    read: vi.fn().mockResolvedValue({ content: "" }),
    readRaw: vi.fn().mockResolvedValue({ data: null }),
    edit: vi.fn().mockResolvedValue({ path: "/tasks.jsonl" }),
    lsInfo: vi.fn().mockResolvedValue([]),
    ls: vi.fn().mockResolvedValue({ files: [] }),
    grepRaw: vi.fn().mockResolvedValue([]),
    grep: vi.fn().mockResolvedValue({ matches: [] }),
    globInfo: vi.fn().mockResolvedValue([]),
    glob: vi.fn().mockResolvedValue({ files: [] }),
  };
  if (opts.uploadFiles) {
    backend.uploadFiles = vi.fn().mockResolvedValue([]);
  }
  return backend;
}

function makeTask(
  id: string,
  description = "Do something",
  subagentType?: string,
): SwarmTaskSpec {
  const task: SwarmTaskSpec = { id, description };
  if (subagentType !== undefined) task.subagentType = subagentType;
  return task;
}

function makeOptions(
  overrides: Partial<SwarmExecutionOptions> = {},
  backendOpts: { uploadFiles?: boolean } = {},
): SwarmExecutionOptions {
  return {
    subagentGraphs: { "general-purpose": makeSubagent() },
    backend: makeBackend(backendOpts),
    parentState: {},
    maxRetries: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Single task success
// ---------------------------------------------------------------------------

describe("executeSwarm — single task success", () => {
  it("should return completed status with extracted text", async () => {
    const subagent = makeSubagent({ messages: [{ content: "the answer" }] });
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
    });
    const summary = await executeSwarm([makeTask("t1")], options);

    expect(summary.total).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("should invoke the subagent with a HumanMessage containing the task description", async () => {
    const subagent = makeSubagent();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
    });
    await executeSwarm([makeTask("t1", "Research topic X")], options);

    expect(subagent.invoke).toHaveBeenCalledOnce();
    const [state] = subagent.invoke.mock.calls[0];
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("Research topic X");
  });
});

// ---------------------------------------------------------------------------
// 2. Multiple tasks — all succeed
// ---------------------------------------------------------------------------

describe("executeSwarm — multiple tasks all succeed", () => {
  it("should report all tasks as completed", async () => {
    const subagent = makeSubagent();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
    });
    const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3")];

    const summary = await executeSwarm(tasks, options);

    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(subagent.invoke).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Mixed results — some succeed, some fail
// ---------------------------------------------------------------------------

describe("executeSwarm — mixed results", () => {
  it("should count successes and failures correctly", async () => {
    const subagent = {
      invoke: vi
        .fn()
        .mockResolvedValueOnce({ messages: [{ content: "ok" }] })
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ messages: [{ content: "ok again" }] }),
    };
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      maxRetries: 1,
    });
    const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3")];

    const summary = await executeSwarm(tasks, options);

    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(2);
    expect(summary.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Retry logic — task fails on attempt 1, succeeds on attempt 2
// ---------------------------------------------------------------------------

describe("executeSwarm — retry logic", () => {
  it("should record a task as completed when it succeeds on the second attempt", async () => {
    const subagent = {
      invoke: vi
        .fn()
        .mockRejectedValueOnce(new Error("transient error"))
        .mockResolvedValueOnce({ messages: [{ content: "recovered" }] }),
    };
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      maxRetries: 2,
    });

    const summary = await executeSwarm([makeTask("t1")], options);

    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(subagent.invoke).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 5. All retries exhausted
// ---------------------------------------------------------------------------

describe("executeSwarm — all retries exhausted", () => {
  it("should record a task as failed with the error message after maxRetries", async () => {
    const subagent = {
      invoke: vi.fn().mockRejectedValue(new Error("persistent failure")),
    };
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      maxRetries: 3,
    });

    const summary = await executeSwarm([makeTask("t1")], options);

    expect(summary.completed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(subagent.invoke).toHaveBeenCalledTimes(3);
  });

  it("should preserve the last error message in the written results", async () => {
    const subagent = {
      invoke: vi.fn().mockRejectedValue(new Error("persistent failure")),
    };
    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
      maxRetries: 2,
    });

    await executeSwarm([makeTask("t1")], options);

    expect(backend.write).toHaveBeenCalledOnce();
    const writtenContent: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.status).toBe("failed");
    expect(parsed.error).toBe("persistent failure");
  });
});

// ---------------------------------------------------------------------------
// 6. Unknown subagentType — throws before any execution
// ---------------------------------------------------------------------------

describe("executeSwarm — unknown subagentType", () => {
  it("should throw an error before invoking any subagent", async () => {
    const subagent = makeSubagent();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      maxRetries: 1,
    });
    const tasks = [makeTask("t1", "Do something", "nonexistent-type")];

    await expect(executeSwarm(tasks, options)).rejects.toThrow(
      'Task "t1" references unknown subagentType "nonexistent-type"',
    );
    expect(subagent.invoke).not.toHaveBeenCalled();
  });

  it("should list available subagent types in the error message", async () => {
    const options = makeOptions({
      subagentGraphs: {
        "general-purpose": makeSubagent(),
        researcher: makeSubagent(),
      },
      maxRetries: 1,
    });
    const tasks = [makeTask("t1", "Do something", "bad-type")];

    await expect(executeSwarm(tasks, options)).rejects.toThrow("Available:");
  });
});

// ---------------------------------------------------------------------------
// 7. Backend write called
// ---------------------------------------------------------------------------

describe("executeSwarm — backend write", () => {
  it("should write results to a unique run directory", async () => {
    const backend = makeBackend();
    const options = makeOptions({ backend });

    const summary = await executeSwarm([makeTask("t1")], options);

    expect(backend.write).toHaveBeenCalledOnce();
    const writtenPath: string = backend.write.mock.calls[0][0];
    expect(writtenPath).toMatch(/^swarm_runs\/[a-f0-9-]+\/results\.jsonl$/);
    expect(summary.resultsDir).toBe(writtenPath.replace("/results.jsonl", ""));
  });

  it("should write valid JSONL content containing the task result", async () => {
    const backend = makeBackend();
    const subagent = makeSubagent({ messages: [{ content: "task output" }] });
    const options = makeOptions({
      backend,
      subagentGraphs: { "general-purpose": subagent },
    });

    await executeSwarm([makeTask("t1", "Do work")], options);

    const writtenContent: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.id).toBe("t1");
    expect(parsed.status).toBe("completed");
    expect(parsed.result).toBe("task output");
  });
});

// ---------------------------------------------------------------------------
// 8. Concurrency limiting
// ---------------------------------------------------------------------------

describe("executeSwarm — concurrency limiting", () => {
  it("should run tasks sequentially when concurrency=1", async () => {
    const invocationOrder: string[] = [];
    const makeOrderedSubagent = (id: string) => ({
      invoke: vi.fn(async () => {
        invocationOrder.push(id);
        return { messages: [{ content: `result from ${id}` }] };
      }),
    });

    const subagentA = makeOrderedSubagent("A");
    const subagentB = makeOrderedSubagent("B");
    const subagentC = makeOrderedSubagent("C");

    const options = makeOptions({
      subagentGraphs: {
        "general-purpose": makeSubagent(),
        typeA: subagentA,
        typeB: subagentB,
        typeC: subagentC,
      },
      concurrency: 1,
      maxRetries: 1,
    });

    const tasks = [
      makeTask("t1", "Task 1", "typeA"),
      makeTask("t2", "Task 2", "typeB"),
      makeTask("t3", "Task 3", "typeC"),
    ];

    await executeSwarm(tasks, options);

    expect(invocationOrder).toEqual(["A", "B", "C"]);
  });
});

// ---------------------------------------------------------------------------
// 9. Timeout — task hangs and is recorded as failed
// ---------------------------------------------------------------------------

describe("executeSwarm — timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should record a hanging task as failed with a timeout error message", async () => {
    const hangingSubagent = {
      invoke: vi.fn(
        () =>
          new Promise<never>(() => {
            /* never resolves */
          }),
      ),
    };

    const options = makeOptions({
      subagentGraphs: { "general-purpose": hangingSubagent },
      maxRetries: 1,
    });

    const executionPromise = executeSwarm([makeTask("t1")], options);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(TASK_TIMEOUT_SECONDS * 1000 + 1000);

    const summary = await executionPromise;

    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(0);

    const backend = options.backend as any;
    const writtenContent: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.status).toBe("failed");
    expect(parsed.error).toContain("timed out");
    expect(parsed.error).toContain(String(TASK_TIMEOUT_SECONDS));
  });
});

// ---------------------------------------------------------------------------
// 10. extractResultText — via executeSwarm
// ---------------------------------------------------------------------------

describe("executeSwarm — extractResultText", () => {
  it("should use structuredResponse when present", async () => {
    const structuredData = { answer: 42, label: "the meaning" };
    const subagent = makeSubagent({
      messages: [{ content: "ignored message" }],
      structuredResponse: structuredData,
    });
    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    await executeSwarm([makeTask("t1")], options);

    const writtenContent: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.result).toBe(JSON.stringify(structuredData));
  });

  it("should extract plain string content from the last message", async () => {
    const subagent = makeSubagent({
      messages: [{ content: "plain string result" }],
    });
    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    await executeSwarm([makeTask("t1")], options);

    const writtenContent: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.result).toBe("plain string result");
  });

  it("should join text blocks from array content", async () => {
    const subagent = makeSubagent({
      messages: [
        {
          content: [
            { type: "text", text: "first part" },
            { type: "text", text: "second part" },
          ],
        },
      ],
    });
    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    await executeSwarm([makeTask("t1")], options);

    const writtenContent: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.result).toBe("first part\nsecond part");
  });

  it("should filter out tool_use, thinking, and redacted_thinking blocks", async () => {
    const subagent = makeSubagent({
      messages: [
        {
          content: [
            { type: "thinking", thinking: "internal reasoning" },
            { type: "text", text: "visible answer" },
            { type: "tool_use", id: "call_1", name: "some_tool", input: {} },
            { type: "redacted_thinking", data: "..." },
          ],
        },
      ],
    });
    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    await executeSwarm([makeTask("t1")], options);

    const writtenContent: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.result).toBe("visible answer");
  });

  it("should return 'Task completed' when all array blocks are non-text", async () => {
    const subagent = makeSubagent({
      messages: [
        {
          content: [
            { type: "tool_use", id: "c1", name: "t", input: {} },
            { type: "thinking", thinking: "..." },
          ],
        },
      ],
    });
    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    await executeSwarm([makeTask("t1")], options);

    const writtenContent: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.result).toBe("Task completed");
  });

  it("should return 'Task completed (no output)' when messages array is empty", async () => {
    const subagent = makeSubagent({ messages: [] });
    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    await executeSwarm([makeTask("t1")], options);

    const writtenContent: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.result).toBe("Task completed (no output)");
  });
});

// ---------------------------------------------------------------------------
// 11. filterStateForSubagent — via executeSwarm
// ---------------------------------------------------------------------------

describe("executeSwarm — filterStateForSubagent", () => {
  const EXCLUDED_KEYS = [
    "messages",
    "todos",
    "structuredResponse",
    "skillsMetadata",
    "memoryContents",
  ];

  it("should strip all excluded keys from parentState before passing to subagent", async () => {
    const parentState: Record<string, unknown> = {
      messages: [{ content: "old message" }],
      todos: ["write tests"],
      structuredResponse: { foo: "bar" },
      skillsMetadata: { skills: [] },
      memoryContents: "some memory",
      customKey: "should be kept",
      anotherKey: 42,
    };

    const subagent = makeSubagent();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      parentState,
    });

    await executeSwarm([makeTask("t1")], options);

    const [invokedState] = subagent.invoke.mock.calls[0];

    for (const key of EXCLUDED_KEYS) {
      // messages is replaced with the task HumanMessage, not absent
      if (key === "messages") {
        expect(invokedState.messages).toHaveLength(1);
        expect(invokedState.messages[0].content).toBe("Do something");
      } else {
        expect(invokedState).not.toHaveProperty(key);
      }
    }
  });

  it("should preserve non-excluded keys in the state passed to subagent", async () => {
    const parentState: Record<string, unknown> = {
      messages: [],
      customKey: "kept",
      numericProp: 99,
      nested: { a: 1 },
    };

    const subagent = makeSubagent();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      parentState,
    });

    await executeSwarm([makeTask("t1")], options);

    const [invokedState] = subagent.invoke.mock.calls[0];
    expect(invokedState.customKey).toBe("kept");
    expect(invokedState.numericProp).toBe(99);
    expect(invokedState.nested).toEqual({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// 12. Result ordering
// ---------------------------------------------------------------------------

describe("executeSwarm — result ordering", () => {
  it("should write results in the same order as input tasks", async () => {
    // Subagents resolve in reverse order to verify output is not sorted by completion time
    const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
    const subagent = {
      invoke: vi
        .fn()
        .mockImplementationOnce(async () => {
          await delay(30);
          return { messages: [{ content: "first" }] };
        })
        .mockImplementationOnce(async () => {
          await delay(10);
          return { messages: [{ content: "second" }] };
        })
        .mockImplementationOnce(async () => {
          await delay(20);
          return { messages: [{ content: "third" }] };
        }),
    };

    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
      concurrency: 3,
      maxRetries: 1,
    });

    const tasks = [
      makeTask("t1", "First"),
      makeTask("t2", "Second"),
      makeTask("t3", "Third"),
    ];
    await executeSwarm(tasks, options);

    const writtenContent: string = backend.write.mock.calls[0][1];
    const lines = writtenContent.trim().split("\n");
    expect(lines).toHaveLength(3);
    const results = lines.map((l) => JSON.parse(l));
    expect(results[0].id).toBe("t1");
    expect(results[1].id).toBe("t2");
    expect(results[2].id).toBe("t3");
  });

  it("should return summary with inline results when write fails", async () => {
    const backend = makeBackend();
    backend.write = vi.fn().mockRejectedValue(new Error("disk full"));
    const subagent = makeSubagent({ messages: [{ content: "the answer" }] });
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    const summary = await executeSwarm([makeTask("t1")], options);

    expect(summary.total).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.resultsDir).toBe("");
    expect(summary.writeError).toContain("disk full");
    expect(summary.results).toHaveLength(1);
    expect(summary.results![0].status).toBe("completed");
  });

  it("should include tasks that were never executed as failed in results", async () => {
    // Simulate a scenario where a task is not in resultsMap (edge case guard)
    const subagent = makeSubagent();
    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
      maxRetries: 1,
    });

    const tasks = [makeTask("t1"), makeTask("t2")];
    await executeSwarm(tasks, options);

    const writtenContent: string = backend.write.mock.calls[0][1];
    const lines = writtenContent.trim().split("\n");
    const ids = lines.map((l) => JSON.parse(l).id);
    expect(ids).toEqual(["t1", "t2"]);
  });
});
