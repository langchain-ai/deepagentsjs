import { describe, it, expect, vi } from "vitest";
import { executeSwarm, type SwarmExecutionOptions } from "./executor.js";
import type { SubagentFactory } from "../symbols.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSubagent(resultText = "done") {
  return {
    invoke: vi.fn(async () => ({ messages: [{ content: resultText }] })),
  } as any;
}

function makeOptions(
  rows: Record<string, unknown>[],
  overrides: Partial<SwarmExecutionOptions> = {},
): SwarmExecutionOptions {
  return {
    rows,
    instruction: "Process {id}",
    subagentGraphs: { "general-purpose": makeSubagent() },
    currentState: {},
    ...overrides,
  };
}

// ─── Basic dispatch ──────────────────────────────────────────────────────────

describe("executeSwarm — basic dispatch", () => {
  it("returns correct summary counts for a successful run", async () => {
    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }, { id: "r2" }]),
    );
    expect(summary.total).toBe(2);
    expect(summary.completed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it("includes per-row entries in results", async () => {
    const subagent = makeSubagent("answer");
    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }], {
        subagentGraphs: { "general-purpose": subagent },
      }),
    );
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].id).toBe("r1");
    expect(summary.results[0].status).toBe("completed");
    expect(summary.results[0].result).toBe("answer");
  });

  it("merges result column into the returned rows", async () => {
    const summary = await executeSwarm(
      makeOptions([{ id: "r1", text: "hello" }], {
        instruction: "Process {text}",
        subagentGraphs: { "general-purpose": makeSubagent("done") },
        column: "result",
      }),
    );
    expect(summary.rows[0].result).toBe("done");
  });

  it("uses 'result' as the default column name", async () => {
    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }], {
        subagentGraphs: { "general-purpose": makeSubagent("out") },
      }),
    );
    expect(summary.rows[0].result).toBe("out");
  });

  it("returns enriched rows for every dispatched row", async () => {
    const summary = await executeSwarm(
      makeOptions([{ id: "a" }, { id: "b" }, { id: "c" }], {
        subagentGraphs: { "general-purpose": makeSubagent("ok") },
      }),
    );
    expect(summary.rows.every((r) => r.result === "ok")).toBe(true);
  });

  it("records column name in summary", async () => {
    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }], { column: "output" }),
    );
    expect(summary.column).toBe("output");
  });

  it("does not mutate the caller's input rows array", async () => {
    const inputRows = [{ id: "r1" }];
    await executeSwarm(makeOptions(inputRows));
    expect(Object.keys(inputRows[0])).toEqual(["id"]);
  });

  it("invokes subagent with orchestrator state minus excluded keys", async () => {
    const subagent = makeSubagent();
    await executeSwarm(
      makeOptions([{ id: "r1" }], {
        subagentGraphs: { "general-purpose": subagent },
        currentState: {
          messages: ["should be excluded"],
          todos: ["also excluded"],
          customKey: "should be present",
        },
      }),
    );
    const calledState = subagent.invoke.mock.calls[0][0];
    expect(calledState.customKey).toBe("should be present");
    expect(calledState.messages).toEqual([
      expect.objectContaining({ content: "Process r1" }),
    ]);
    expect(calledState.todos).toBeUndefined();
  });
});

// ─── Filter ──────────────────────────────────────────────────────────────────

describe("executeSwarm — filter", () => {
  it("skips rows that do not match the filter", async () => {
    const summary = await executeSwarm(
      makeOptions(
        [
          { id: "r1", status: "pending" },
          { id: "r2", status: "done" },
          { id: "r3", status: "pending" },
        ],
        { filter: { column: "status", equals: "pending" } },
      ),
    );
    expect(summary.total).toBe(2);
    expect(summary.skipped).toBe(1);
  });

  it("does not add result column to skipped rows", async () => {
    const summary = await executeSwarm(
      makeOptions(
        [
          { id: "r1", status: "done" },
          { id: "r2", status: "pending" },
        ],
        {
          filter: { column: "status", equals: "pending" },
          subagentGraphs: { "general-purpose": makeSubagent("ok") },
        },
      ),
    );
    const skipped = summary.rows.find((r) => r.id === "r1");
    expect(skipped?.result).toBeUndefined();
    const dispatched = summary.rows.find((r) => r.id === "r2");
    expect(dispatched?.result).toBe("ok");
  });
});

// ─── Interpolation errors ────────────────────────────────────────────────────

describe("executeSwarm — interpolation errors", () => {
  it("records interpolation failure in failedTasks", async () => {
    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }], {
        instruction: "Process {missing_col}",
      }),
    );
    expect(summary.failed).toBe(1);
    expect(summary.failedTasks[0].id).toBe("r1");
    expect(summary.failedTasks[0].error).toMatch(/Interpolation:/);
  });

  it("dispatches other rows even when one fails interpolation", async () => {
    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }, { id: "r2", extra: "x" }], {
        instruction: "Handle {extra}",
      }),
    );
    expect(summary.total).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(1);
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("executeSwarm — validation", () => {
  it("throws on unknown subagent type", async () => {
    await expect(
      executeSwarm(
        makeOptions([{ id: "r1" }], { subagentType: "nonexistent" }),
      ),
    ).rejects.toThrow("Unknown subagent type(s): nonexistent");
  });

  it("throws when responseSchema type is not 'object'", async () => {
    await expect(
      executeSwarm(
        makeOptions([{ id: "r1" }], {
          responseSchema: { type: "array", items: { type: "string" } },
        }),
      ),
    ).rejects.toThrow('responseSchema must have type "object"');
  });

  it("throws when responseSchema has no properties", async () => {
    await expect(
      executeSwarm(
        makeOptions([{ id: "r1" }], {
          responseSchema: { type: "object" },
        }),
      ),
    ).rejects.toThrow('responseSchema must define "properties"');
  });
});

// ─── Structured output flattening ───────────────────────────────────────────

describe("executeSwarm — structured output flattening", () => {
  it("flattens structured result properties onto the row", async () => {
    const subagent = {
      invoke: vi.fn(async () => ({
        structuredResponse: { label: "positive", confidence: 0.95 },
      })),
    } as any;
    const factory = vi.fn(() => subagent) as unknown as SubagentFactory;

    const summary = await executeSwarm(
      makeOptions([{ id: "r1", text: "great" }], {
        instruction: "Classify: {text}",
        responseSchema: {
          type: "object",
          properties: {
            label: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["label"],
        },
        subagentGraphs: { "general-purpose": makeSubagent() },
        subagentFactories: { "general-purpose": factory },
      }),
    );

    expect(summary.rows[0].label).toBe("positive");
    expect(summary.rows[0].confidence).toBe(0.95);
    expect(summary.rows[0].result).toBeUndefined();
  });

  it("does not flatten plain text results", async () => {
    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }], {
        subagentGraphs: { "general-purpose": makeSubagent("plain text") },
      }),
    );
    expect(summary.rows[0].result).toBe("plain text");
    expect(Object.keys(summary.rows[0])).toEqual(["id", "result"]);
  });
});

// ─── Subagent resolver ───────────────────────────────────────────────────────

describe("executeSwarm — subagent resolver", () => {
  it("invokes factory when responseSchema is provided", async () => {
    const baseSubagent = makeSubagent("base");
    const variantSubagent = makeSubagent("variant");
    const factory = vi.fn(() => variantSubagent) as unknown as SubagentFactory;

    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }], {
        subagentGraphs: { "general-purpose": baseSubagent },
        subagentFactories: { "general-purpose": factory },
        responseSchema: {
          type: "object",
          properties: { val: { type: "string" } },
        },
      }),
    );

    expect(factory).toHaveBeenCalledOnce();
    expect(summary.results[0].result).toBe("variant");
  });

  it("caches factory output — compiles variant once for identical schemas", async () => {
    const factory = vi.fn(() =>
      makeSubagent("v"),
    ) as unknown as SubagentFactory;
    const schema = { type: "object", properties: { x: { type: "string" } } };

    await executeSwarm(
      makeOptions([{ id: "r1" }, { id: "r2" }], {
        subagentFactories: { "general-purpose": factory },
        responseSchema: schema,
      }),
    );

    expect(factory).toHaveBeenCalledOnce();
  });

  it("falls back to base graph when factory is not registered for the type", async () => {
    const base = makeSubagent("fallback");
    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }], {
        subagentGraphs: { "general-purpose": base },
        subagentFactories: {},
        responseSchema: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      }),
    );

    expect(base.invoke).toHaveBeenCalled();
    expect(summary.results[0].status).toBe("completed");
  });
});

// ─── Abort ───────────────────────────────────────────────────────────────────

describe("executeSwarm — abort signal", () => {
  it("marks all tasks as failed when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }, { id: "r2" }], {
        signal: controller.signal,
      }),
    );

    expect(summary.results.every((r) => r.status === "failed")).toBe(true);
    expect(summary.results.every((r) => r.error === "Aborted")).toBe(true);
    expect(summary.failed).toBe(2);
  });
});

// ─── Batched subagent dispatch ──────────────────────────────────────────────

const BATCH_SCHEMA = {
  type: "object" as const,
  properties: { label: { type: "string" } },
  required: ["label"],
};

function makeBatchSubagent(
  batchResponses: Array<{ id: string; label: string }[]>,
) {
  let callIdx = 0;
  return {
    invoke: vi.fn(async () => {
      const batch = batchResponses[callIdx++] ?? [];
      return { structuredResponse: { results: batch } };
    }),
  } as any;
}

describe("executeSwarm — batched subagent dispatch", () => {
  it("groups rows into batches and returns correct results by ID", async () => {
    const batchSubagent = makeBatchSubagent([
      [
        { id: "r1", label: "A" },
        { id: "r2", label: "B" },
        { id: "r3", label: "C" },
        { id: "r4", label: "D" },
        { id: "r5", label: "E" },
      ],
      [
        { id: "r6", label: "F" },
        { id: "r7", label: "G" },
        { id: "r8", label: "H" },
        { id: "r9", label: "I" },
        { id: "r10", label: "J" },
      ],
    ]);
    const factory = vi.fn(() => batchSubagent) as unknown as SubagentFactory;

    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i + 1}`,
      text: `item ${i + 1}`,
    }));

    const summary = await executeSwarm({
      rows,
      instruction: "Classify: {text}",
      batchSize: 5,
      responseSchema: BATCH_SCHEMA,
      subagentGraphs: { "general-purpose": makeSubagent() },
      subagentFactories: { "general-purpose": factory },
      currentState: {},
    });

    expect(batchSubagent.invoke).toHaveBeenCalledTimes(2);
    expect(summary.total).toBe(10);
    expect(summary.completed).toBe(10);
    expect(summary.failed).toBe(0);
    expect(summary.rows[0].label).toBe("A");
    expect(summary.rows[9].label).toBe("J");
  });

  it("matches results by ID even when subagent returns shuffled order", async () => {
    const batchSubagent = makeBatchSubagent([
      [
        { id: "r3", label: "C" },
        { id: "r1", label: "A" },
        { id: "r5", label: "E" },
        { id: "r4", label: "D" },
        { id: "r2", label: "B" },
      ],
    ]);
    const factory = vi.fn(() => batchSubagent) as unknown as SubagentFactory;

    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i + 1}`,
      text: `item ${i + 1}`,
    }));

    const summary = await executeSwarm({
      rows,
      instruction: "Classify: {text}",
      batchSize: 5,
      responseSchema: BATCH_SCHEMA,
      subagentGraphs: { "general-purpose": makeSubagent() },
      subagentFactories: { "general-purpose": factory },
      currentState: {},
    });

    expect(summary.completed).toBe(5);
    expect(summary.rows[0].label).toBe("A");
    expect(summary.rows[1].label).toBe("B");
    expect(summary.rows[2].label).toBe("C");
    expect(summary.rows[3].label).toBe("D");
    expect(summary.rows[4].label).toBe("E");
  });

  it("marks only missing IDs as failed, not the rest of the batch", async () => {
    const batchSubagent = makeBatchSubagent([
      [
        { id: "r1", label: "A" },
        // r2 missing
        { id: "r3", label: "C" },
      ],
    ]);
    const factory = vi.fn(() => batchSubagent) as unknown as SubagentFactory;

    const summary = await executeSwarm(
      makeOptions(
        [
          { id: "r1", text: "a" },
          { id: "r2", text: "b" },
          { id: "r3", text: "c" },
        ],
        {
          instruction: "Classify: {text}",
          batchSize: 3,
          responseSchema: BATCH_SCHEMA,
          subagentFactories: { "general-purpose": factory },
        },
      ),
    );

    expect(summary.completed).toBe(2);
    expect(summary.failed).toBe(1);
    const r2 = summary.results.find((r) => r.id === "r2");
    expect(r2?.status).toBe("failed");
    expect(r2?.error).toMatch(/No result returned for id/);
    expect(summary.results.find((r) => r.id === "r1")?.status).toBe(
      "completed",
    );
  });

  it("marks all rows failed when the batch call errors", async () => {
    const failingSubagent = {
      invoke: vi.fn(async () => {
        throw new Error("API rate limit");
      }),
    } as any;
    const factory = vi.fn(() => failingSubagent) as unknown as SubagentFactory;

    const summary = await executeSwarm(
      makeOptions(
        [
          { id: "r1", text: "a" },
          { id: "r2", text: "b" },
        ],
        {
          instruction: "Classify: {text}",
          batchSize: 2,
          responseSchema: BATCH_SCHEMA,
          subagentFactories: { "general-purpose": factory },
        },
      ),
    );

    expect(summary.failed).toBe(2);
    expect(summary.results.every((r) => r.status === "failed")).toBe(true);
    expect(summary.results[0].error).toBe("API rate limit");
  });

  it("strips injected id from batch result and does not leak it as a new column", async () => {
    const batchSubagent = makeBatchSubagent([
      [
        { id: "r1", label: "good" },
        { id: "r2", label: "great" },
      ],
    ]);
    const factory = vi.fn(() => batchSubagent) as unknown as SubagentFactory;

    const summary = await executeSwarm({
      rows: [
        { id: "r1", text: "hello" },
        { id: "r2", text: "world" },
      ],
      instruction: "Classify: {text}",
      batchSize: 2,
      responseSchema: BATCH_SCHEMA,
      subagentGraphs: { "general-purpose": makeSubagent() },
      subagentFactories: { "general-purpose": factory },
      currentState: {},
    });

    expect(summary.rows[0].label).toBe("good");
    expect(summary.rows[1].label).toBe("great");
    expect(summary.rows[0].id).toBe("r1");
    expect(summary.rows[1].id).toBe("r2");
  });

  it("composes batch prompt with fully interpolated items", async () => {
    const batchSubagent = makeBatchSubagent([
      [
        { id: "r1", label: "A" },
        { id: "r2", label: "B" },
      ],
    ]);
    const factory = vi.fn(() => batchSubagent) as unknown as SubagentFactory;

    await executeSwarm({
      rows: [
        { id: "r1", question: "What is 1+1?" },
        { id: "r2", question: "What color is the sky?" },
      ],
      instruction:
        "Classify the answer type for: {question}\nRespond with the label.",
      batchSize: 2,
      responseSchema: BATCH_SCHEMA,
      subagentGraphs: { "general-purpose": makeSubagent() },
      subagentFactories: { "general-purpose": factory },
      currentState: {},
    });

    const invokedState = batchSubagent.invoke.mock.calls[0][0];
    const prompt = invokedState.messages[0].content;
    expect(prompt).toContain("[r1] Classify the answer type for: What is 1+1?");
    expect(prompt).toContain(
      "[r2] Classify the answer type for: What color is the sky?",
    );
    expect(prompt).toContain("Process 2 items");
    expect(prompt).not.toContain("{question}");
  });

  it("requires responseSchema when batchSize is set", async () => {
    await expect(
      executeSwarm(makeOptions([{ id: "r1" }], { batchSize: 5 })),
    ).rejects.toThrow("batchSize requires responseSchema");
  });
});
