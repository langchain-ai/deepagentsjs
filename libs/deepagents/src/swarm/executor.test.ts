import { describe, it, expect, vi } from "vitest";
import { executeSwarm, type SwarmExecutionOptions } from "./executor.js";
import { serializeTableJsonl, parseTableJsonl } from "./parse.js";
import type { SubagentFactory } from "../symbols.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSubagent(resultText = "done") {
  return {
    invoke: vi.fn(async () => ({ messages: [{ content: resultText }] })),
  } as any;
}

function makeReadWrite(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const read = async (path: string) => store.get(path) ?? "";
  const write = vi.fn((path: string, content: string) =>
    store.set(path, content),
  );
  return { read, write, store };
}

function makeOptions(
  rows: Record<string, unknown>[],
  overrides: Partial<SwarmExecutionOptions> = {},
): SwarmExecutionOptions {
  const { read, write } = makeReadWrite({
    "/t.jsonl": serializeTableJsonl(rows),
  });
  return {
    file: "/t.jsonl",
    instruction: "Process {id}",
    subagentGraphs: { "general-purpose": makeSubagent() },
    currentState: {},
    read,
    write,
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

  it("writes result column back to the table on completion", async () => {
    const { read, write, store } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl([{ id: "r1", text: "hello" }]),
    });
    await executeSwarm({
      file: "/t.jsonl",
      instruction: "Process {text}",
      subagentGraphs: { "general-purpose": makeSubagent("done") },
      currentState: {},
      read,
      write,
      column: "result",
    });

    const written = parseTableJsonl(store.get("/t.jsonl") ?? "");
    expect(written[0].result).toBe("done");
  });

  it("uses 'result' as the default column name", async () => {
    const { read, write, store } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl([{ id: "r1" }]),
    });
    await executeSwarm({
      file: "/t.jsonl",
      instruction: "Process {id}",
      subagentGraphs: { "general-purpose": makeSubagent("out") },
      currentState: {},
      read,
      write,
    });

    const written = parseTableJsonl(store.get("/t.jsonl") ?? "");
    expect(written[0].result).toBe("out");
  });

  it("writes results for every row (rowIndexById is populated)", async () => {
    const { read, write, store } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl([{ id: "a" }, { id: "b" }, { id: "c" }]),
    });
    await executeSwarm({
      file: "/t.jsonl",
      instruction: "Process {id}",
      subagentGraphs: { "general-purpose": makeSubagent("ok") },
      currentState: {},
      read,
      write,
    });

    const rows = parseTableJsonl(store.get("/t.jsonl") ?? "");
    expect(rows.every((r) => r.result === "ok")).toBe(true);
  });

  it("records column name in summary", async () => {
    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }], { column: "output" }),
    );
    expect(summary.column).toBe("output");
    expect(summary.file).toBe("/t.jsonl");
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

  it("does not modify skipped rows in the table", async () => {
    const { read, write, store } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl([
        { id: "r1", status: "done" },
        { id: "r2", status: "pending" },
      ]),
    });
    await executeSwarm({
      file: "/t.jsonl",
      instruction: "Process {id}",
      filter: { column: "status", equals: "pending" },
      subagentGraphs: { "general-purpose": makeSubagent("ok") },
      currentState: {},
      read,
      write,
    });

    const rows = parseTableJsonl(store.get("/t.jsonl") ?? "");
    const skipped = rows.find((r) => r.id === "r1");
    expect(skipped?.result).toBeUndefined();
    const dispatched = rows.find((r) => r.id === "r2");
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

    const { read, write, store } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl([{ id: "r1", text: "great" }]),
    });

    await executeSwarm({
      file: "/t.jsonl",
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
      currentState: {},
      read,
      write,
    });

    const rows = parseTableJsonl(store.get("/t.jsonl") ?? "");
    expect(rows[0].label).toBe("positive");
    expect(rows[0].confidence).toBe(0.95);
    expect(rows[0].result).toBeUndefined();
  });

  it("does not flatten plain text results", async () => {
    const { read, write, store } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl([{ id: "r1" }]),
    });

    await executeSwarm({
      file: "/t.jsonl",
      instruction: "Process {id}",
      subagentGraphs: { "general-purpose": makeSubagent("plain text") },
      currentState: {},
      read,
      write,
    });

    const rows = parseTableJsonl(store.get("/t.jsonl") ?? "");
    expect(rows[0].result).toBe("plain text");
    expect(Object.keys(rows[0])).toEqual(["id", "result"]);
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
    const { read, write, store } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl(rows),
    });

    const summary = await executeSwarm({
      file: "/t.jsonl",
      instruction: "Classify: {text}",
      batchSize: 5,
      responseSchema: BATCH_SCHEMA,
      subagentGraphs: { "general-purpose": makeSubagent() },
      subagentFactories: { "general-purpose": factory },
      currentState: {},
      read,
      write,
    });

    expect(batchSubagent.invoke).toHaveBeenCalledTimes(2);
    expect(summary.total).toBe(10);
    expect(summary.completed).toBe(10);
    expect(summary.failed).toBe(0);

    const written = parseTableJsonl(store.get("/t.jsonl") ?? "");
    expect(written[0].label).toBe("A");
    expect(written[9].label).toBe("J");
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
    const { read, write, store } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl(rows),
    });

    const summary = await executeSwarm({
      file: "/t.jsonl",
      instruction: "Classify: {text}",
      batchSize: 5,
      responseSchema: BATCH_SCHEMA,
      subagentGraphs: { "general-purpose": makeSubagent() },
      subagentFactories: { "general-purpose": factory },
      currentState: {},
      read,
      write,
    });

    expect(summary.completed).toBe(5);
    const written = parseTableJsonl(store.get("/t.jsonl") ?? "");
    expect(written[0].label).toBe("A");
    expect(written[1].label).toBe("B");
    expect(written[2].label).toBe("C");
    expect(written[3].label).toBe("D");
    expect(written[4].label).toBe("E");
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

  it("strips injected id field from results before writing to row", async () => {
    const batchSubagent = makeBatchSubagent([
      [
        { id: "r1", label: "good" },
        { id: "r2", label: "great" },
      ],
    ]);
    const factory = vi.fn(() => batchSubagent) as unknown as SubagentFactory;

    const { read, write, store } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl([
        { id: "r1", text: "hello" },
        { id: "r2", text: "world" },
      ]),
    });

    await executeSwarm({
      file: "/t.jsonl",
      instruction: "Classify: {text}",
      batchSize: 2,
      responseSchema: BATCH_SCHEMA,
      subagentGraphs: { "general-purpose": makeSubagent() },
      subagentFactories: { "general-purpose": factory },
      currentState: {},
      read,
      write,
    });

    const written = parseTableJsonl(store.get("/t.jsonl") ?? "");
    expect(written[0].label).toBe("good");
    expect(written[1].label).toBe("great");
    // id from the batch result should not leak onto the row
    expect(written[0].id).toBe("r1");
    expect(written[1].id).toBe("r2");
  });

  it("composes compact batch prompt — instruction once, items listed by variable values", async () => {
    const batchSubagent = makeBatchSubagent([
      [
        { id: "r1", label: "A" },
        { id: "r2", label: "B" },
      ],
    ]);
    const factory = vi.fn(() => batchSubagent) as unknown as SubagentFactory;

    const { read, write } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl([
        { id: "r1", question: "What is 1+1?" },
        { id: "r2", question: "What color is the sky?" },
      ]),
    });

    await executeSwarm({
      file: "/t.jsonl",
      instruction:
        "Classify the answer type for: {question}\nRespond with the label.",
      batchSize: 2,
      responseSchema: BATCH_SCHEMA,
      subagentGraphs: { "general-purpose": makeSubagent() },
      subagentFactories: { "general-purpose": factory },
      currentState: {},
      read,
      write,
    });

    const invokedState = batchSubagent.invoke.mock.calls[0][0];
    const prompt = invokedState.messages[0].content;
    expect(prompt).toContain("Classify the answer type for: {question}");
    expect(prompt).toContain("Each item below provides a value for {question}");
    expect(prompt).toContain("[r1] What is 1+1?");
    expect(prompt).toContain("[r2] What color is the sky?");
    const instructionCount = (prompt.match(/Respond with the label/g) || [])
      .length;
    expect(instructionCount).toBe(1);
  });

  it("requires responseSchema", async () => {
    await expect(
      executeSwarm(makeOptions([{ id: "r1" }], { batchSize: 5 })),
    ).rejects.toThrow("batchSize requires responseSchema");
  });
});
