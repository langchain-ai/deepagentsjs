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
