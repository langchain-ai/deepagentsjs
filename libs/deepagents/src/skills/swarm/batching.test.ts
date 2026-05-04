import { describe, it, expect } from "vitest";
import {
  createBatches,
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
// wrapSchema
// ---------------------------------------------------------------------------

describe("wrapSchema", () => {
  it("auto-generates id+result schema when no itemSchema provided", () => {
    const schema = wrapSchema();
    expect(schema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              result: { type: "string" },
            },
            required: ["id", "result"],
          },
        },
      },
      required: ["results"],
    });
  });

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
  it("includes instruction and row data", () => {
    const prompt = buildBatchPrompt("Review {file}", [
      { id: "r1", file: "a.ts" },
      { id: "r2", file: "b.ts" },
    ]);
    expect(prompt).toContain("Instruction: Review {file}");
    expect(prompt).toContain('[r1]: {"file":"a.ts"}');
    expect(prompt).toContain('[r2]: {"file":"b.ts"}');
  });

  it("prepends context when provided", () => {
    const prompt = buildBatchPrompt(
      "Review {file}",
      [{ id: "r1", file: "a.ts" }],
      "TypeScript project",
    );
    expect(prompt.startsWith("TypeScript project")).toBe(true);
  });

  it("omits context section when not provided", () => {
    const prompt = buildBatchPrompt("Review {file}", [
      { id: "r1", file: "a.ts" },
    ]);
    expect(prompt.startsWith("Instruction:")).toBe(true);
  });

  it("excludes id from row data JSON", () => {
    const prompt = buildBatchPrompt("Check {file}", [
      { id: "r1", file: "a.ts", score: 5 },
    ]);
    expect(prompt).toContain('[r1]: {"file":"a.ts","score":5}');
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

  it("unwraps single 'result' field in text mode", () => {
    const response = JSON.stringify({
      results: [
        { id: "r1", result: "looks good" },
        { id: "r2", result: "needs work" },
      ],
    });
    const { results } = unpackBatchResults(response, ["r1", "r2"]);
    expect(results.get("r1")).toBe("looks good");
    expect(results.get("r2")).toBe("needs work");
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
        { id: "r1", result: "ok" },
        { result: "no id" },
        { id: 123, result: "numeric id" },
      ],
    });
    const { results } = unpackBatchResults(response, ["r1"]);
    expect(results.size).toBe(1);
    expect(results.get("r1")).toBe("ok");
  });
});
