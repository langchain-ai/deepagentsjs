import { describe, it, expect, beforeEach, vi } from "vitest";
import { create, run, rows } from "./index.js";
import { _resetForTesting } from "./table.js";

// ---------------------------------------------------------------------------
// In-memory file system + task stub for all PTC tools
// ---------------------------------------------------------------------------

let files: Map<string, string>;

const resultSchema = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
};

function setupTools() {
  files = new Map();
  (globalThis as Record<string, unknown>).tools = {
    glob: vi.fn(async ({ pattern }: { pattern: string }) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp("^" + escaped.replace(/\*/g, "[^/]*") + "$");
      const matched = [...files.keys()].filter((f) => regex.test(f));
      return JSON.stringify(matched);
    }),
    readFile: vi.fn(async ({ file_path }: { file_path: string }) => {
      const content = files.get(file_path);
      if (content === undefined)
        throw new Error(`File not found: ${file_path}`);
      return content;
    }),
    writeFile: vi.fn(
      async ({
        file_path,
        content,
      }: {
        file_path: string;
        content: string;
      }) => {
        files.set(file_path, content);
        return "ok";
      },
    ),
    swarmTask: vi.fn(async ({ description }: { description: string }) =>
      JSON.stringify({ result: `Result for: ${description}` }),
    ),
  };
}

beforeEach(() => {
  _resetForTesting();
  setupTools();
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("create", () => {
  it("returns a handle with id, count, and columns", async () => {
    const handle = await create({
      tasks: [
        { id: "r1", text: "hello" },
        { id: "r2", text: "world" },
      ],
    });
    expect(handle.id).toMatch(/^t_[a-f0-9]{6}$/);
    expect(handle.count).toBe(2);
    expect(handle.columns).toContain("id");
    expect(handle.columns).toContain("text");
  });
});

// ---------------------------------------------------------------------------
// run — single dispatch
// ---------------------------------------------------------------------------

describe("run (single dispatch)", () => {
  it("dispatches all rows and merges results", async () => {
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = vi.fn(async ({ description }: { description: string }) =>
      JSON.stringify({ review: `Result for: ${description}` }),
    );

    const handle = await create({
      tasks: [
        { id: "r1", file: "a.ts" },
        { id: "r2", file: "b.ts" },
      ],
    });

    const result = await run(handle.id, {
      instruction: "Review {file}",
      responseSchema: {
        type: "object",
        properties: { review: { type: "string" } },
        required: ["review"],
      },
    });

    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    const data = await rows(handle.id);
    expect(data[0].review).toBe("Result for: Review a.ts");
    expect(data[1].review).toBe("Result for: Review b.ts");
  });

  it("prepends context to each prompt", async () => {
    const taskFn = vi.fn(async (_args: Record<string, unknown>) =>
      JSON.stringify({ result: "ok" }),
    );
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = taskFn;

    const handle = await create({ tasks: [{ id: "r1", file: "a.ts" }] });
    await run(handle.id, {
      instruction: "Review {file}",
      context: "TypeScript project",
      responseSchema: resultSchema,
    });

    const prompt = taskFn.mock.calls[0][0].description as string;
    expect(prompt.startsWith("TypeScript project")).toBe(true);
    expect(prompt).toContain("Review a.ts");
  });

  it("merges responseSchema properties onto rows", async () => {
    const handle = await create({ tasks: [{ id: "r1", text: "hi" }] });
    await run(handle.id, {
      instruction: "Process {text}",
      responseSchema: resultSchema,
    });

    const data = await rows(handle.id);
    expect(data[0].result).toBeDefined();
  });

  it("rejects unknown column references before dispatch", async () => {
    const handle = await create({ tasks: [{ id: "r1", text: "hi" }] });
    await expect(
      run(handle.id, {
        instruction: "Review {nonexistent}",
        responseSchema: resultSchema,
      }),
    ).rejects.toThrow("instruction references unknown column(s): nonexistent");
  });

  it("counts task failures", async () => {
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = vi.fn(async () => {
      throw new Error("subagent timeout");
    });

    const handle = await create({ tasks: [{ id: "r1", text: "hi" }] });
    const result = await run(handle.id, {
      instruction: "Do {text}",
      responseSchema: resultSchema,
    });

    expect(result.failed).toBe(1);
    expect(result.completed).toBe(0);
    expect(result.failures[0].error).toBe("subagent timeout");
  });

  it("persists updated rows to backend", async () => {
    const handle = await create({ tasks: [{ id: "r1", text: "hi" }] });
    await run(handle.id, {
      instruction: "Do {text}",
      responseSchema: resultSchema,
    });

    const path = [...files.keys()].find((k) => k.includes(handle.id));
    expect(path).toBeDefined();
    const content = files.get(path as string) ?? "";
    expect(content).toContain('"result"');
  });
});

// ---------------------------------------------------------------------------
// run — filtering
// ---------------------------------------------------------------------------

describe("run (filtering)", () => {
  it("skips rows that do not match the filter", async () => {
    const handle = await create({
      tasks: [
        { id: "r1", status: "pending" },
        { id: "r2", status: "done" },
        { id: "r3", status: "pending" },
      ],
    });

    const result = await run(handle.id, {
      instruction: "Process {id}",
      responseSchema: resultSchema,
      filter: { column: "status", equals: "pending" },
    });

    expect(result.completed).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it("returns early when all rows are filtered out", async () => {
    const handle = await create({
      tasks: [{ id: "r1", status: "done" }],
    });

    const result = await run(handle.id, {
      instruction: "Process {id}",
      responseSchema: resultSchema,
      filter: { column: "status", equals: "pending" },
    });

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("supports retry-with-filter pattern", async () => {
    const outSchema = {
      type: "object",
      properties: { out: { type: "string" } },
      required: ["out"],
    };

    let callCount = 0;
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = vi.fn(async () => {
      callCount++;
      if (callCount <= 1) throw new Error("transient");
      return JSON.stringify({ out: "ok" });
    });

    const handle = await create({
      tasks: [
        { id: "r1", text: "a" },
        { id: "r2", text: "b" },
      ],
    });

    await run(handle.id, {
      instruction: "Do {text}",
      responseSchema: outSchema,
    });

    const retryResult = await run(handle.id, {
      instruction: "Do {text}",
      responseSchema: outSchema,
      filter: { column: "out", exists: false },
    });

    expect(retryResult.completed).toBe(1);
    expect(retryResult.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// run — structured output
// ---------------------------------------------------------------------------

describe("run (structured output)", () => {
  it("parses JSON and spreads properties onto rows", async () => {
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = vi.fn(async () =>
      JSON.stringify({ sentiment: "positive", confidence: 0.9 }),
    );

    const handle = await create({
      tasks: [{ id: "r1", text: "great product" }],
    });

    const result = await run(handle.id, {
      instruction: "Classify {text}",
      responseSchema: {
        type: "object",
        properties: {
          sentiment: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["sentiment", "confidence"],
      },
    });

    expect(result.completed).toBe(1);
    const data = await rows(handle.id);
    expect(data[0].sentiment).toBe("positive");
    expect(data[0].confidence).toBe(0.9);
  });

  it("counts JSON parse failures as failed", async () => {
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = vi.fn(async () => "not valid json");

    const handle = await create({ tasks: [{ id: "r1", text: "hi" }] });
    const result = await run(handle.id, {
      instruction: "Classify {text}",
      responseSchema: { type: "object" },
    });

    expect(result.failed).toBe(1);
    expect(result.completed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// run — batched dispatch
// ---------------------------------------------------------------------------

describe("run (batched dispatch)", () => {
  it("uses batch path when batchSize >= 2", async () => {
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = vi.fn(async () =>
      JSON.stringify({
        results: [
          { id: "r1", summary: "done-1" },
          { id: "r2", summary: "done-2" },
        ],
      }),
    );

    const handle = await create({
      tasks: [
        { id: "r1", text: "a" },
        { id: "r2", text: "b" },
      ],
    });

    const result = await run(handle.id, {
      instruction: "Process {text}",
      responseSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
      batchSize: 2,
    });

    expect(result.completed).toBe(2);
    const data = await rows(handle.id);
    expect(data[0].summary).toBe("done-1");
    expect(data[1].summary).toBe("done-2");
  });

  it("marks rows missing from batch response as failed", async () => {
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = vi.fn(async () =>
      JSON.stringify({
        results: [{ id: "r1", summary: "ok" }],
      }),
    );

    const handle = await create({
      tasks: [
        { id: "r1", text: "a" },
        { id: "r2", text: "b" },
      ],
    });

    const result = await run(handle.id, {
      instruction: "Process {text}",
      responseSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
      batchSize: 5,
    });

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// run — batch function
// ---------------------------------------------------------------------------

describe("run (batch function)", () => {
  it("dispatches mixed single and batched rows from the same run", async () => {
    const taskFn = vi.fn(async ({ description }: { description: string }) => {
      if (description.includes("# Items")) {
        // batch prompt
        return JSON.stringify({
          results: [
            { id: "r1", summary: "batch-1" },
            { id: "r2", summary: "batch-2" },
            { id: "r3", summary: "batch-3" },
          ],
        });
      }
      // single-row prompt
      return JSON.stringify({ summary: "single" });
    });
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = taskFn;

    const handle = await create({
      tasks: [
        { id: "r1", token_count: 100 },
        { id: "r2", token_count: 200 },
        { id: "r3", token_count: 300 },
        { id: "r4", token_count: 5000 },
      ],
    });

    const summarySchema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };

    const result = await run(handle.id, {
      instruction: "Analyze row {id}",
      responseSchema: summarySchema,
      batchSize: (row) => ((row.token_count as number) > 1000 ? 1 : 10),
    });

    expect(result.completed).toBe(4);
    expect(result.failed).toBe(0);

    const data = await rows(handle.id);
    const r4 = data.find((r) => r.id === "r4");
    expect(r4!.summary).toBe("single");
    const r1 = data.find((r) => r.id === "r1");
    expect(r1!.summary).toBe("batch-1");
  });

  it("only evaluates batch function on rows that pass the filter", async () => {
    const evaluatedIds: string[] = [];
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = vi.fn(async () => JSON.stringify({ out: "ok" }));

    const handle = await create({
      tasks: [
        { id: "r1", status: "pending" },
        { id: "r2", status: "done" },
        { id: "r3", status: "pending" },
      ],
    });

    const result = await run(handle.id, {
      instruction: "Process {id}",
      responseSchema: {
        type: "object",
        properties: { out: { type: "string" } },
        required: ["out"],
      },
      filter: { column: "status", equals: "pending" },
      batchSize: (row) => {
        evaluatedIds.push(row.id as string);
        return 1;
      },
    });

    expect(result.completed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(evaluatedIds).toEqual(["r1", "r3"]);
    expect(evaluatedIds).not.toContain("r2");
  });

  it("batch function reads row data to decide batch size", async () => {
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = vi.fn(async ({ description }: { description: string }) => {
      if (description.includes("# Items")) {
        return JSON.stringify({
          results: [
            { id: "r2", out: "batched" },
            { id: "r3", out: "batched" },
          ],
        });
      }
      return JSON.stringify({ out: "solo" });
    });

    const handle = await create({
      tasks: [
        { id: "r1", token_count: 5000 },
        { id: "r2", token_count: 100 },
        { id: "r3", token_count: 200 },
      ],
    });

    const result = await run(handle.id, {
      instruction: "Process {id}",
      responseSchema: {
        type: "object",
        properties: { out: { type: "string" } },
        required: ["out"],
      },
      batchSize: (row) => ((row.token_count as number) > 1000 ? 1 : 10),
    });

    expect(result.completed).toBe(3);
    const data = await rows(handle.id);
    expect(data.find((r) => r.id === "r1")!.out).toBe("solo");
    expect(data.find((r) => r.id === "r2")!.out).toBe("batched");
    expect(data.find((r) => r.id === "r3")!.out).toBe("batched");
  });

  it("counts interpolation errors in mixed dispatch", async () => {
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = vi.fn(async () => JSON.stringify({ out: "ok" }));

    const handle = await create({
      tasks: [
        { id: "r1", text: "hello" },
        { id: "r2", text: "world" },
      ],
    });

    const result = await run(handle.id, {
      instruction: "Process {text}",
      responseSchema: {
        type: "object",
        properties: { out: { type: "string" } },
        required: ["out"],
      },
      batchSize: () => 1,
    });

    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// run — mode derived from subagentType
// ---------------------------------------------------------------------------

describe("run (mode)", () => {
  it("uses invoke mode when subagentType is omitted", async () => {
    const taskFn = vi.fn(async (_args: Record<string, unknown>) =>
      JSON.stringify({ result: "ok" }),
    );
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = taskFn;

    const handle = await create({
      tasks: [
        { id: "r1", text: "a" },
        { id: "r2", text: "b" },
      ],
    });

    await run(handle.id, {
      instruction: "Classify {text}",
      responseSchema: resultSchema,
    });

    for (const call of taskFn.mock.calls) {
      expect(call[0].mode).toBe("invoke");
    }
  });

  it("uses agent mode when subagentType is specified", async () => {
    const taskFn = vi.fn(async (_args: Record<string, unknown>) =>
      JSON.stringify({ result: "ok" }),
    );
    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = taskFn;

    const handle = await create({ tasks: [{ id: "r1", text: "a" }] });

    await run(handle.id, {
      instruction: "Process {text}",
      responseSchema: resultSchema,
      subagentType: "screener",
    });

    expect(taskFn.mock.calls[0][0].mode).toBe("agent");
    expect(taskFn.mock.calls[0][0].subagent_type).toBe("screener");
  });
});

// ---------------------------------------------------------------------------
// run — concurrency clamping
// ---------------------------------------------------------------------------

describe("run (concurrency)", () => {
  it("clamps concurrency to minimum of 1", async () => {
    const handle = await create({ tasks: [{ id: "r1", text: "hi" }] });
    const result = await run(handle.id, {
      instruction: "Do {text}",
      responseSchema: resultSchema,
      concurrency: 0,
    });
    expect(result.completed).toBe(1);
  });

  it("clamps concurrency to maximum of 10", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    (
      (globalThis as Record<string, unknown>).tools as Record<string, unknown>
    ).swarmTask = vi.fn(async ({ description }: { description: string }) => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) {
        maxConcurrent = currentConcurrent;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      currentConcurrent--;
      return JSON.stringify({ result: `done: ${description}` });
    });

    const tasks = Array.from({ length: 15 }, (_, i) => ({
      id: `r${i}`,
      text: `item ${i}`,
    }));
    const handle = await create({ tasks });
    await run(handle.id, {
      instruction: "Do {text}",
      responseSchema: resultSchema,
      concurrency: 50,
    });
    expect(maxConcurrent).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

describe("rows", () => {
  it("returns all rows with no options", async () => {
    const handle = await create({
      tasks: [
        { id: "r1", text: "a" },
        { id: "r2", text: "b" },
      ],
    });
    const data = await rows(handle.id);
    expect(data).toHaveLength(2);
  });

  it("filters rows", async () => {
    const handle = await create({
      tasks: [
        { id: "r1", status: "done" },
        { id: "r2", status: "pending" },
      ],
    });
    const data = await rows(handle.id, {
      filter: { column: "status", equals: "done" },
    });
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("r1");
  });

  it("projects to specified columns", async () => {
    const handle = await create({
      tasks: [{ id: "r1", text: "hi", score: 5 }],
    });
    const data = await rows(handle.id, { columns: ["id", "score"] });
    expect(data[0]).toEqual({ id: "r1", score: 5 });
    expect(data[0]).not.toHaveProperty("text");
  });

  it("limits the number of rows", async () => {
    const handle = await create({
      tasks: [
        { id: "r1", text: "a" },
        { id: "r2", text: "b" },
        { id: "r3", text: "c" },
      ],
    });
    const data = await rows(handle.id, { limit: 2 });
    expect(data).toHaveLength(2);
  });

  it("combines filter, columns, and limit", async () => {
    const handle = await create({
      tasks: [
        { id: "r1", status: "done", score: 5 },
        { id: "r2", status: "done", score: 8 },
        { id: "r3", status: "pending", score: 3 },
        { id: "r4", status: "done", score: 9 },
      ],
    });
    const data = await rows(handle.id, {
      filter: { column: "status", equals: "done" },
      columns: ["id", "score"],
      limit: 2,
    });
    expect(data).toHaveLength(2);
    expect(Object.keys(data[0])).toEqual(["id", "score"]);
  });
});
