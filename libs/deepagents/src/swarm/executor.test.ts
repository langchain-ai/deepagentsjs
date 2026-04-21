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

// ─── Batch dispatch ─────────────────────────────────────────────────────────

function makeBatchSubagent(results: unknown[][]) {
  let callIdx = 0;
  return {
    invoke: vi.fn(async () => {
      const batch = results[callIdx++] ?? [];
      return { messages: [{ content: JSON.stringify(batch) }] };
    }),
  } as any;
}

describe("executeSwarm — batch dispatch", () => {
  it("groups rows and returns correct summary counts", async () => {
    const subagent = makeBatchSubagent([
      ["res1", "res2", "res3"],
      ["res4", "res5", "res6"],
    ]);
    const summary = await executeSwarm(
      makeOptions(
        [
          { id: "r1" },
          { id: "r2" },
          { id: "r3" },
          { id: "r4" },
          { id: "r5" },
          { id: "r6" },
        ],
        {
          subagentGraphs: { "general-purpose": subagent },
          batchSize: 3,
        },
      ),
    );

    expect(subagent.invoke).toHaveBeenCalledTimes(2);
    expect(summary.total).toBe(6);
    expect(summary.completed).toBe(6);
    expect(summary.failed).toBe(0);
  });

  it("handles remainder batch with fewer rows", async () => {
    const subagent = makeBatchSubagent([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
    const summary = await executeSwarm(
      makeOptions(
        [{ id: "r1" }, { id: "r2" }, { id: "r3" }, { id: "r4" }, { id: "r5" }],
        {
          subagentGraphs: { "general-purpose": subagent },
          batchSize: 3,
        },
      ),
    );

    expect(subagent.invoke).toHaveBeenCalledTimes(2);
    expect(summary.total).toBe(5);
    expect(summary.completed).toBe(5);
  });

  it("writes results back to individual rows in the table", async () => {
    const subagent = makeBatchSubagent([["out1", "out2"]]);
    const { read, write, store } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl([
        { id: "r1", text: "a" },
        { id: "r2", text: "b" },
      ]),
    });

    await executeSwarm({
      file: "/t.jsonl",
      instruction: "Process {text}",
      subagentGraphs: { "general-purpose": subagent },
      currentState: {},
      read,
      write,
      batchSize: 2,
    });

    const rows = parseTableJsonl(store.get("/t.jsonl") ?? "");
    expect(rows[0].result).toBe("out1");
    expect(rows[1].result).toBe("out2");
  });

  it("marks all rows failed when batch response is not valid JSON", async () => {
    const subagent = {
      invoke: vi.fn(async () => ({
        messages: [{ content: "not json at all" }],
      })),
    } as any;

    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }, { id: "r2" }], {
        subagentGraphs: { "general-purpose": subagent },
        batchSize: 2,
      }),
    );

    expect(summary.failed).toBe(2);
    expect(summary.results.every((r) => r.status === "failed")).toBe(true);
    expect(summary.results[0].error).toMatch(/not valid JSON/);
  });

  it("handles array length mismatch with best-effort assignment", async () => {
    const subagent = makeBatchSubagent([["res1", "res2"]]);
    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }, { id: "r2" }, { id: "r3" }], {
        subagentGraphs: { "general-purpose": subagent },
        batchSize: 3,
      }),
    );

    expect(summary.completed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.results[2].status).toBe("failed");
    expect(summary.results[2].error).toMatch(
      /returned 2 results but expected 3/,
    );
  });

  it("uses structured output with wrapped schema in batch mode", async () => {
    const structuredSubagent = {
      invoke: vi.fn(async () => ({
        structuredResponse: {
          results: [{ label: "good" }, { label: "also good" }],
        },
      })),
    } as any;
    const factory = vi.fn(
      () => structuredSubagent,
    ) as unknown as SubagentFactory;

    const schema = {
      type: "object" as const,
      properties: { label: { type: "string" } },
      required: ["label"],
    };

    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }, { id: "r2" }], {
        subagentGraphs: { "general-purpose": makeSubagent() },
        subagentFactories: { "general-purpose": factory },
        batchSize: 2,
        responseSchema: schema,
      }),
    );

    expect(factory).toHaveBeenCalledOnce();
    const calledSchema = factory.mock.calls[0][0] as Record<string, unknown>;
    expect(calledSchema.type).toBe("object");
    expect(calledSchema.required).toEqual(["results"]);
    const resultsProp = (calledSchema.properties as any).results;
    expect(resultsProp.type).toBe("array");
    expect(resultsProp.minItems).toBe(2);
    expect(resultsProp.maxItems).toBe(2);
    expect(resultsProp.items).toEqual(schema);

    expect(summary.completed).toBe(2);
    expect(summary.results[0].result).toBe('{"label":"good"}');
    expect(summary.results[1].result).toBe('{"label":"also good"}');
  });

  it("marks all batches as failed when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }, { id: "r2" }, { id: "r3" }], {
        signal: controller.signal,
        batchSize: 2,
      }),
    );

    expect(summary.results.every((r) => r.status === "failed")).toBe(true);
    expect(summary.results.every((r) => r.error === "Aborted")).toBe(true);
    expect(summary.failed).toBe(3);
  });

  it("strips markdown code fences from batch response (no schema)", async () => {
    const subagent = {
      invoke: vi.fn(async () => ({
        messages: [{ content: '```json\n["res1", "res2"]\n```' }],
      })),
    } as any;

    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }, { id: "r2" }], {
        subagentGraphs: { "general-purpose": subagent },
        batchSize: 2,
      }),
    );

    expect(summary.completed).toBe(2);
    expect(summary.results[0].result).toBe("res1");
    expect(summary.results[1].result).toBe("res2");
  });

  it("throws on invalid batchSize values", async () => {
    await expect(
      executeSwarm(makeOptions([{ id: "r1" }], { batchSize: 0 })),
    ).rejects.toThrow("batchSize must be a positive integer");

    await expect(
      executeSwarm(makeOptions([{ id: "r1" }], { batchSize: -1 })),
    ).rejects.toThrow("batchSize must be a positive integer");

    await expect(
      executeSwarm(makeOptions([{ id: "r1" }], { batchSize: 1.5 })),
    ).rejects.toThrow("batchSize must be a positive integer");
  });

  it("batchSize 1 behaves identically to default", async () => {
    const subagent = makeSubagent("done");
    const summary = await executeSwarm(
      makeOptions([{ id: "r1" }, { id: "r2" }], {
        subagentGraphs: { "general-purpose": subagent },
        batchSize: 1,
      }),
    );

    expect(subagent.invoke).toHaveBeenCalledTimes(2);
    expect(summary.total).toBe(2);
    expect(summary.completed).toBe(2);
  });

  it("sends compact batch prompt with template shown once", async () => {
    const subagent = makeBatchSubagent([["a", "b", "c"]]);
    const { read, write } = makeReadWrite({
      "/t.jsonl": serializeTableJsonl([
        { id: "r1", question: "What is X?" },
        { id: "r2", question: "What is Y?" },
        { id: "r3", question: "What is Z?" },
      ]),
    });

    await executeSwarm({
      file: "/t.jsonl",
      instruction: "Classify this: {question}\nPick one of: A, B, C",
      subagentGraphs: { "general-purpose": subagent },
      currentState: {},
      read,
      write,
      batchSize: 3,
    });

    const invokedState = subagent.invoke.mock.calls[0][0] as any;
    const prompt: string = invokedState.messages[0].content;

    expect(prompt).toContain("Classify this: {question}");
    expect(prompt).toContain("Pick one of: A, B, C");
    expect(prompt).toContain("What is X?");
    expect(prompt).toContain("What is Y?");
    expect(prompt).toContain("What is Z?");

    const templateOccurrences = prompt.split("Pick one of: A, B, C").length - 1;
    expect(templateOccurrences).toBe(1);
  });

  it("uses per-row schema in single-row mode, wrapped schema in batch mode", async () => {
    const schema = {
      type: "object" as const,
      properties: { label: { type: "string" } },
      required: ["label"],
    };

    // batchSize: 1 — factory called with the per-row schema directly
    const subagent1 = makeSubagent('{"label":"x"}');
    const factory = vi.fn(() => subagent1) as unknown as SubagentFactory;
    await executeSwarm(
      makeOptions([{ id: "r1" }], {
        subagentGraphs: { "general-purpose": subagent1 },
        subagentFactories: { "general-purpose": factory },
        batchSize: 1,
        responseSchema: schema,
      }),
    );
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0][0]).toEqual(schema);

    // batchSize > 1 — factory called with the wrapped array schema
    factory.mockClear();
    const structuredSubagent = {
      invoke: vi.fn(async () => ({
        structuredResponse: { results: [{ label: "y" }] },
      })),
    } as any;
    factory.mockReturnValue(structuredSubagent);
    await executeSwarm(
      makeOptions([{ id: "r1" }], {
        subagentGraphs: { "general-purpose": makeSubagent() },
        subagentFactories: { "general-purpose": factory },
        batchSize: 2,
        responseSchema: schema,
      }),
    );
    expect(factory).toHaveBeenCalledOnce();
    const wrappedSchema = factory.mock.calls[0][0] as Record<string, unknown>;
    expect((wrappedSchema as any).properties.results.items).toEqual(schema);
  });
});
