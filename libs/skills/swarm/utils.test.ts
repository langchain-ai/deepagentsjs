import { describe, it, expect } from "vitest";
import { readColumn, normalizeSchema } from "./utils.js";

describe("normalizeSchema", () => {
  it("adds additionalProperties: false to a top-level object", () => {
    const result = normalizeSchema({
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
    });
    expect(result.additionalProperties).toBe(false);
  });

  it("preserves an existing additionalProperties: false", () => {
    const result = normalizeSchema({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    expect(result.additionalProperties).toBe(false);
  });

  it("recurses into nested object properties", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        counts: {
          type: "object",
          properties: { a: { type: "number" } },
          required: ["a"],
        },
      },
      required: ["counts"],
    };
    const result = normalizeSchema(schema);
    const counts = (result.properties as Record<string, unknown>)
      .counts as Record<string, unknown>;
    expect(counts.additionalProperties).toBe(false);
  });

  it("recurses into array items", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    };
    const result = normalizeSchema(schema);
    const items = result.items as Record<string, unknown>;
    expect(items.additionalProperties).toBe(false);
  });

  it("handles deeply nested objects", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              counts: {
                type: "object",
                properties: { a: { type: "number" } },
              },
            },
          },
        },
      },
    };
    const result = normalizeSchema(schema);
    const items = (
      (result.properties as Record<string, unknown>).results as Record<
        string,
        unknown
      >
    ).items as Record<string, unknown>;
    const counts = (items.properties as Record<string, unknown>)
      .counts as Record<string, unknown>;
    expect(counts.additionalProperties).toBe(false);
  });

  it("passes through non-object/array types unchanged", () => {
    const schema = { type: "string" };
    expect(normalizeSchema(schema)).toEqual({ type: "string" });
  });
});

describe("readColumn", () => {
  it("reads a top-level key", () => {
    expect(readColumn({ name: "alice" }, "name")).toBe("alice");
  });

  it("reads a dot-separated nested path", () => {
    const row = { meta: { score: 42, nested: { deep: true } } };
    expect(readColumn(row, "meta.score")).toBe(42);
    expect(readColumn(row, "meta.nested.deep")).toBe(true);
  });

  it("returns undefined for a missing top-level key", () => {
    expect(readColumn({ a: 1 }, "b")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment is missing", () => {
    expect(readColumn({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment is null", () => {
    expect(readColumn({ a: null }, "a.b")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment is an array", () => {
    expect(readColumn({ a: [1, 2] }, "a.b")).toBeUndefined();
  });

  it("returns null values at the final segment", () => {
    expect(readColumn({ a: null }, "a")).toBeNull();
  });

  it("returns 0 and empty string without treating them as missing", () => {
    expect(readColumn({ count: 0 }, "count")).toBe(0);
    expect(readColumn({ label: "" }, "label")).toBe("");
  });

  it("returns objects and arrays at the final segment", () => {
    const obj = { nested: { x: 1 } };
    expect(readColumn(obj, "nested")).toEqual({ x: 1 });

    const arr = { items: [1, 2, 3] };
    expect(readColumn(arr, "items")).toEqual([1, 2, 3]);
  });
});
