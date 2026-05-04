import { describe, it, expect } from "vitest";
import { readColumn } from "./utils.js";

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
