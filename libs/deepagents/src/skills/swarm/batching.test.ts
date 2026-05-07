import { describe, it, expect } from "vitest";
import {
  createBatches,
  resolveBatchGroups,
  MAX_BATCH_SIZE,
  wrapSchema,
  buildBatchPrompt,
  unpackBatchResults,
} from "./batching.js";

// ---------------------------------------------------------------------------
// createBatches
// ---------------------------------------------------------------------------

describe("createBatches", () => {
  it("splits evenly when items divide by batchSize", () => {
    const batches = createBatches([1, 2, 3, 4], 2);
    expect(batches).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("produces a smaller final batch for uneven splits", () => {
    const batches = createBatches([1, 2, 3, 4, 5], 2);
    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single batch when batchSize >= items.length", () => {
    const batches = createBatches([1, 2, 3], 10);
    expect(batches).toEqual([[1, 2, 3]]);
  });

  it("returns empty array for empty input", () => {
    expect(createBatches([], 5)).toEqual([]);
  });

  it("returns one item per batch when batchSize is 1", () => {
    const batches = createBatches(["a", "b", "c"], 1);
    expect(batches).toEqual([["a"], ["b"], ["c"]]);
  });
});

// ---------------------------------------------------------------------------
// resolveBatchGroups
// ---------------------------------------------------------------------------

function makeRows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
}

describe("resolveBatchGroups", () => {
  it("returns empty array for empty input", () => {
    expect(resolveBatchGroups([], 10)).toEqual([]);
  });

  it("auto-batches to size 1 when rows <= maxSubagents", () => {
    const rows = makeRows(5);
    const batches = resolveBatchGroups(rows, 10);
    expect(batches).toHaveLength(5);
    for (const batch of batches) {
      expect(batch).toHaveLength(1);
    }
  });

  it("auto-batches to ceil(rows/maxSubagents) when rows > maxSubagents", () => {
    const rows = makeRows(25);
    const batches = resolveBatchGroups(rows, 10);
    // ceil(25/10) = 3 → batches of 3, ceil(25/3) = 9 batches
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(3);
    }
    const totalRows = batches.reduce((sum, b) => sum + b.length, 0);
    expect(totalRows).toBe(25);
  });

  it("caps auto-batch size at MAX_BATCH_SIZE", () => {
    const rows = makeRows(10_000);
    const batches = resolveBatchGroups(rows, 2);
    // ceil(10000/2) = 5000, capped at MAX_BATCH_SIZE (50)
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_BATCH_SIZE);
    }
    const totalRows = batches.reduce((sum, b) => sum + b.length, 0);
    expect(totalRows).toBe(10_000);
  });

  it("uniform: batches all rows at given size", () => {
    const rows = makeRows(12);
    const batches = resolveBatchGroups(rows, 10, 5);
    expect(batches).toHaveLength(3); // 5+5+2
    expect(batches[0]).toHaveLength(5);
    expect(batches[1]).toHaveLength(5);
    expect(batches[2]).toHaveLength(2);
  });

  it("uniform: batchSize 1 produces per-row dispatch", () => {
    const rows = makeRows(4);
    const batches = resolveBatchGroups(rows, 10, 1);
    expect(batches).toHaveLength(4);
    for (const batch of batches) {
      expect(batch).toHaveLength(1);
    }
  });

  it("clamps batchSize 0 to 1", () => {
    const rows = makeRows(3);
    const batches = resolveBatchGroups(rows, 10, 0);
    expect(batches).toHaveLength(3);
    for (const batch of batches) {
      expect(batch).toHaveLength(1);
    }
  });

  it("clamps batchSize exceeding MAX_BATCH_SIZE", () => {
    const rows = makeRows(100);
    const batches = resolveBatchGroups(rows, 10, 999);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_BATCH_SIZE);
    }
    const totalRows = batches.reduce((sum, b) => sum + b.length, 0);
    expect(totalRows).toBe(100);
  });

  it("function: groups rows by returned batch size", () => {
    const rows = [
      { id: "r1", size: "small" },
      { id: "r2", size: "large" },
      { id: "r3", size: "small" },
      { id: "r4", size: "large" },
      { id: "r5", size: "small" },
    ];
    const batches = resolveBatchGroups(rows, 10, (row) =>
      row.size === "small" ? 3 : 1,
    );
    // small rows (r1, r3, r5) → batch size 3 → 1 batch of 3
    // large rows (r2, r4) → batch size 1 → 2 batches of 1
    expect(batches).toHaveLength(3);
    const batchOf3 = batches.find((b) => b.length === 3);
    expect(batchOf3).toBeDefined();
    expect(batchOf3!.map((r) => r.id)).toEqual(["r1", "r3", "r5"]);
  });

  it("function: same size for all rows is equivalent to uniform", () => {
    const rows = makeRows(7);
    const fnBatches = resolveBatchGroups(rows, 10, () => 3);
    const uniformBatches = resolveBatchGroups(rows, 10, 3);
    expect(fnBatches).toEqual(uniformBatches);
  });

  it("function: receives correct rowCount as second argument", () => {
    const rows = makeRows(8);
    const receivedCounts: number[] = [];
    resolveBatchGroups(rows, 10, (_row, rowCount) => {
      receivedCounts.push(rowCount);
      return 1;
    });
    expect(receivedCounts).toHaveLength(8);
    for (const count of receivedCounts) {
      expect(count).toBe(8);
    }
  });

  it("function: clamps returned values", () => {
    const rows = makeRows(3);
    const batches = resolveBatchGroups(rows, 10, () => 0);
    // 0 clamped to 1
    expect(batches).toHaveLength(3);
    for (const batch of batches) {
      expect(batch).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// wrapSchema
// ---------------------------------------------------------------------------

describe("wrapSchema", () => {
  it("merges itemSchema properties with id field", () => {
    const itemSchema = {
      type: "object",
      properties: {
        sentiment: { type: "string" },
        confidence: { type: "number" },
      },
      required: ["sentiment"],
    };
    const schema = wrapSchema(itemSchema);
    const items = (schema.properties as Record<string, unknown>)
      .results as Record<string, unknown>;
    const itemDef = items.items as Record<string, unknown>;
    const props = itemDef.properties as Record<string, unknown>;

    expect(props.id).toEqual({ type: "string" });
    expect(props.sentiment).toEqual({ type: "string" });
    expect(props.confidence).toEqual({ type: "number" });
    expect(itemDef.required).toEqual(["id", "sentiment"]);
  });

  it("handles itemSchema with no properties or required", () => {
    const schema = wrapSchema({ type: "object" });
    const items = (schema.properties as Record<string, unknown>)
      .results as Record<string, unknown>;
    const itemDef = items.items as Record<string, unknown>;

    expect(itemDef.properties).toEqual({ id: { type: "string" } });
    expect(itemDef.required).toEqual(["id"]);
  });
});

// ---------------------------------------------------------------------------
// buildBatchPrompt
// ---------------------------------------------------------------------------

describe("buildBatchPrompt", () => {
  it("rewrites {col} to backtick-quoted name in task block", () => {
    const prompt = buildBatchPrompt("Review {file}", [
      { id: "r1", file: "a.ts" },
    ]);
    expect(prompt).toContain("# Task");
    expect(prompt).toContain("Review `file`");
    expect(prompt).not.toContain("{file}");
  });

  it("renders single-column items as flat [id] value", () => {
    const prompt = buildBatchPrompt("Review {file}", [
      { id: "r1", file: "a.ts" },
      { id: "r2", file: "b.ts" },
    ]);
    expect(prompt).toContain("[r1] a.ts");
    expect(prompt).toContain("[r2] b.ts");
    expect(prompt).toContain("Each item below is the value of `file`.");
  });

  it("renders multi-column items as labeled blocks", () => {
    const prompt = buildBatchPrompt("Classify {text} for {cat}", [
      { id: "r1", text: "hi", cat: "A" },
    ]);
    expect(prompt).toContain("[r1]");
    expect(prompt).toContain("  text: hi");
    expect(prompt).toContain("  cat: A");
    expect(prompt).toContain("Each item below provides `text`, `cat`.");
  });

  it("renders id-only rows when instruction has no placeholders", () => {
    const prompt = buildBatchPrompt("Do the task.", [{ id: "r1", text: "hi" }]);
    expect(prompt).toContain("[r1]");
    expect(prompt).not.toContain("Each item below");
  });

  it("prepends context when provided", () => {
    const prompt = buildBatchPrompt(
      "Review {file}",
      [{ id: "r1", file: "a.ts" }],
      "TypeScript project",
    );
    expect(prompt.startsWith("TypeScript project")).toBe(true);
  });

  it("starts with # Task when no context", () => {
    const prompt = buildBatchPrompt("Review {file}", [
      { id: "r1", file: "a.ts" },
    ]);
    expect(prompt.startsWith("# Task")).toBe(true);
  });

  it("includes items count in header", () => {
    const prompt = buildBatchPrompt("task", [{ id: "r1" }, { id: "r2" }]);
    expect(prompt).toContain("# Items (2)");
  });

  it("includes batch result instructions", () => {
    const prompt = buildBatchPrompt("task", [{ id: "r1" }]);
    expect(prompt).toContain("'results' array");
    expect(prompt).toContain("'id'");
  });
});

// ---------------------------------------------------------------------------
// unpackBatchResults
// ---------------------------------------------------------------------------

describe("unpackBatchResults", () => {
  it("unpacks structured results by id", () => {
    const response = JSON.stringify({
      results: [
        { id: "r1", sentiment: "positive", confidence: 0.9 },
        { id: "r2", sentiment: "negative", confidence: 0.7 },
      ],
    });
    const { results, missing } = unpackBatchResults(response, ["r1", "r2"]);
    expect(missing).toEqual([]);
    expect(results.get("r1")).toEqual({
      sentiment: "positive",
      confidence: 0.9,
    });
    expect(results.get("r2")).toEqual({
      sentiment: "negative",
      confidence: 0.7,
    });
  });

  it("keeps single-field objects as objects", () => {
    const response = JSON.stringify({
      results: [
        { id: "r1", summary: "looks good" },
        { id: "r2", summary: "needs work" },
      ],
    });
    const { results } = unpackBatchResults(response, ["r1", "r2"]);
    expect(results.get("r1")).toEqual({ summary: "looks good" });
    expect(results.get("r2")).toEqual({ summary: "needs work" });
  });

  it("reports missing IDs", () => {
    const response = JSON.stringify({
      results: [{ id: "r1", result: "ok" }],
    });
    const { results, missing } = unpackBatchResults(response, [
      "r1",
      "r2",
      "r3",
    ]);
    expect(results.has("r1")).toBe(true);
    expect(missing).toEqual(["r2", "r3"]);
  });

  it("treats all IDs as missing on parse failure", () => {
    const { results, missing } = unpackBatchResults("not json", ["r1", "r2"]);
    expect(results.size).toBe(0);
    expect(missing).toEqual(["r1", "r2"]);
  });

  it("treats all IDs as missing when results key is absent", () => {
    const { results, missing } = unpackBatchResults("{}", ["r1"]);
    expect(results.size).toBe(0);
    expect(missing).toEqual(["r1"]);
  });

  it("skips items without a string id", () => {
    const response = JSON.stringify({
      results: [
        { id: "r1", summary: "ok" },
        { summary: "no id" },
        { id: 123, summary: "numeric id" },
      ],
    });
    const { results } = unpackBatchResults(response, ["r1"]);
    expect(results.size).toBe(1);
    expect(results.get("r1")).toEqual({ summary: "ok" });
  });
});
