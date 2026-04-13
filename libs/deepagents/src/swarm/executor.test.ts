import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeSwarm } from "./executor.js";
import type { SwarmExecutionOptions } from "./executor.js";
import type { SwarmTaskSpec } from "./types.js";
import { TASK_TIMEOUT_SECONDS } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeSubagent(
  result: Record<string, unknown> = { messages: [{ content: "result text" }] },
) {
  return { invoke: vi.fn().mockResolvedValue(result) } as any;
}

function makeBackend() {
  return {
    write: vi.fn().mockResolvedValue({ path: "/results.jsonl" }),
    read: vi.fn().mockResolvedValue({ content: "" }),
    readRaw: vi.fn().mockResolvedValue({ data: null }),
    edit: vi.fn().mockResolvedValue({ path: "" }),
    lsInfo: vi.fn().mockResolvedValue([]),
    ls: vi.fn().mockResolvedValue({ files: [] }),
    grepRaw: vi.fn().mockResolvedValue([]),
    grep: vi.fn().mockResolvedValue({ matches: [] }),
    globInfo: vi.fn().mockResolvedValue([]),
    glob: vi.fn().mockResolvedValue({ files: [] }),
  };
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
): SwarmExecutionOptions {
  return {
    subagentGraphs: { "general-purpose": makeSubagent() },
    backend: makeBackend(),
    parentState: {},
    ...overrides,
  };
}

// ── Single task success ─────────────────────────────────────────────────

describe("executeSwarm — single task success", () => {
  it("returns completed status with extracted text", async () => {
    const subagent = makeSubagent({ messages: [{ content: "the answer" }] });
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
    });
    const summary = await executeSwarm([makeTask("t1")], options);

    expect(summary.total).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.failedTasks).toEqual([]);
  });

  it("invokes the subagent with a HumanMessage containing the task description", async () => {
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

// ── Multiple tasks ──────────────────────────────────────────────────────

describe("executeSwarm — multiple tasks all succeed", () => {
  it("reports all tasks as completed", async () => {
    const subagent = makeSubagent();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
    });
    const summary = await executeSwarm(
      [makeTask("t1"), makeTask("t2"), makeTask("t3")],
      options,
    );

    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(subagent.invoke).toHaveBeenCalledTimes(3);
  });
});

// ── Mixed results ───────────────────────────────────────────────────────

describe("executeSwarm — mixed results", () => {
  it("counts successes and failures correctly", async () => {
    const subagent = {
      invoke: vi
        .fn()
        .mockResolvedValueOnce({ messages: [{ content: "ok" }] })
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ messages: [{ content: "ok again" }] }),
    } as any;
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
    });
    const summary = await executeSwarm(
      [makeTask("t1"), makeTask("t2"), makeTask("t3")],
      options,
    );

    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it("populates failedTasks with id and error", async () => {
    const subagent = {
      invoke: vi
        .fn()
        .mockResolvedValueOnce({ messages: [{ content: "ok" }] })
        .mockRejectedValueOnce(new Error("something broke")),
    } as any;
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
    });
    const summary = await executeSwarm(
      [makeTask("t1"), makeTask("t2")],
      options,
    );

    expect(summary.failedTasks).toHaveLength(1);
    expect(summary.failedTasks[0]).toEqual({
      id: "t2",
      error: "something broke",
    });
  });
});

// ── No retries ──────────────────────────────────────────────────────────

describe("executeSwarm — no retries", () => {
  it("fails immediately without retrying", async () => {
    const subagent = {
      invoke: vi.fn().mockRejectedValue(new Error("persistent failure")),
    } as any;
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
    });
    const summary = await executeSwarm([makeTask("t1")], options);

    expect(summary.completed).toBe(0);
    expect(summary.failed).toBe(1);
    // Should be called exactly once — no retries
    expect(subagent.invoke).toHaveBeenCalledTimes(1);
  });
});

// ── Results do not include description ──────────────────────────────────

describe("executeSwarm — results shape", () => {
  it("does not include description in the written results", async () => {
    const backend = makeBackend();
    const subagent = makeSubagent({ messages: [{ content: "output" }] });
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    await executeSwarm([makeTask("t1", "long description text")], options);

    const writtenContent: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.id).toBe("t1");
    expect(parsed.status).toBe("completed");
    expect(parsed.result).toBe("output");
    expect(parsed).not.toHaveProperty("description");
  });

  it("includes subagentType in results", async () => {
    const backend = makeBackend();
    const subagent = makeSubagent();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    await executeSwarm([makeTask("t1")], options);

    const writtenContent: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent.trim());
    expect(parsed.subagentType).toBe("general-purpose");
  });
});

// ── Unknown subagentType ────────────────────────────────────────────────

describe("executeSwarm — unknown subagentType", () => {
  it("throws before invoking any subagent", async () => {
    const subagent = makeSubagent();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
    });

    await expect(
      executeSwarm(
        [makeTask("t1", "Do something", "nonexistent-type")],
        options,
      ),
    ).rejects.toThrow(
      'Task "t1" references unknown subagentType "nonexistent-type"',
    );
    expect(subagent.invoke).not.toHaveBeenCalled();
  });

  it("lists available subagent types in the error message", async () => {
    const options = makeOptions({
      subagentGraphs: {
        "general-purpose": makeSubagent(),
        researcher: makeSubagent(),
      },
    });

    await expect(
      executeSwarm([makeTask("t1", "Do something", "bad-type")], options),
    ).rejects.toThrow("Available:");
  });
});

// ── Concurrency ─────────────────────────────────────────────────────────

describe("executeSwarm — concurrency", () => {
  it("runs tasks sequentially when concurrency=1", async () => {
    const order: string[] = [];
    const makeOrderedSubagent = (id: string) =>
      ({
        invoke: vi.fn(async () => {
          order.push(id);
          return { messages: [{ content: `result from ${id}` }] };
        }),
      }) as any;

    const options = makeOptions({
      subagentGraphs: {
        "general-purpose": makeSubagent(),
        typeA: makeOrderedSubagent("A"),
        typeB: makeOrderedSubagent("B"),
        typeC: makeOrderedSubagent("C"),
      },
      concurrency: 1,
    });

    await executeSwarm(
      [
        makeTask("t1", "Task 1", "typeA"),
        makeTask("t2", "Task 2", "typeB"),
        makeTask("t3", "Task 3", "typeC"),
      ],
      options,
    );

    expect(order).toEqual(["A", "B", "C"]);
  });
});

// ── Timeout ─────────────────────────────────────────────────────────────

describe("executeSwarm — timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("records a hanging task as failed with a timeout error", async () => {
    const hangingSubagent = {
      invoke: vi.fn(() => new Promise<never>(() => {})),
    } as any;
    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": hangingSubagent },
      backend,
    });

    const executionPromise = executeSwarm([makeTask("t1")], options);
    await vi.advanceTimersByTimeAsync(TASK_TIMEOUT_SECONDS * 1000 + 1000);
    const summary = await executionPromise;

    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(0);
    expect(summary.failedTasks[0].error).toContain("timed out");
    expect(summary.failedTasks[0].error).toContain(
      String(TASK_TIMEOUT_SECONDS),
    );
  });
});

// ── Backend write ───────────────────────────────────────────────────────

describe("executeSwarm — backend write", () => {
  it("writes results to a unique run directory", async () => {
    const backend = makeBackend();
    const options = makeOptions({ backend });
    const summary = await executeSwarm([makeTask("t1")], options);

    expect(backend.write).toHaveBeenCalledOnce();
    const writtenPath: string = backend.write.mock.calls[0][0];
    expect(writtenPath).toMatch(/^swarm_runs\/[a-f0-9-]+\/results\.jsonl$/);
    expect(summary.resultsDir).toBe(writtenPath.replace("/results.jsonl", ""));
  });
});

// ── extractResultText (via executeSwarm) ────────────────────────────────

describe("executeSwarm — extractResultText", () => {
  it("uses structuredResponse when present", async () => {
    const data = { answer: 42, label: "meaning" };
    const subagent = makeSubagent({
      messages: [{ content: "ignored" }],
      structuredResponse: data,
    });
    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    await executeSwarm([makeTask("t1")], options);

    const written: string = backend.write.mock.calls[0][1];
    const parsed = JSON.parse(written.trim());
    expect(parsed.result).toBe(JSON.stringify(data));
  });

  it("extracts plain string content from the last message", async () => {
    const subagent = makeSubagent({ messages: [{ content: "plain result" }] });
    const backend = makeBackend();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    await executeSwarm([makeTask("t1")], options);

    const written: string = backend.write.mock.calls[0][1];
    expect(JSON.parse(written.trim()).result).toBe("plain result");
  });

  it("filters out tool_use, thinking, and redacted_thinking blocks", async () => {
    const subagent = makeSubagent({
      messages: [
        {
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "visible answer" },
            { type: "tool_use", id: "c1", name: "t", input: {} },
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

    const written: string = backend.write.mock.calls[0][1];
    expect(JSON.parse(written.trim()).result).toBe("visible answer");
  });
});

// ── filterStateForSubagent (via executeSwarm) ───────────────────────────

describe("executeSwarm — filterStateForSubagent", () => {
  const EXCLUDED = [
    "messages",
    "todos",
    "structuredResponse",
    "skillsMetadata",
    "memoryContents",
  ];

  it("strips excluded keys from state passed to subagents", async () => {
    const parentState: Record<string, unknown> = {
      messages: [{ content: "old" }],
      todos: ["x"],
      structuredResponse: { foo: 1 },
      skillsMetadata: {},
      memoryContents: "memory",
      keepMe: "yes",
    };

    const subagent = makeSubagent();
    const options = makeOptions({
      subagentGraphs: { "general-purpose": subagent },
      parentState,
    });

    await executeSwarm([makeTask("t1")], options);

    const [state] = subagent.invoke.mock.calls[0];
    for (const key of EXCLUDED) {
      if (key === "messages") {
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].content).toBe("Do something");
      } else {
        expect(state).not.toHaveProperty(key);
      }
    }
    expect(state.keepMe).toBe("yes");
  });
});
