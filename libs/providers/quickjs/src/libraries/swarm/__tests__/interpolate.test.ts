import { describe, it, expect } from "vitest";
import { interpolate } from "../source/interpolate.js";

describe("interpolate", () => {
  it("replaces a single placeholder", () => {
    expect(interpolate("Review {file}", { file: "index.ts" })).toBe(
      "Review index.ts",
    );
  });

  it("replaces multiple placeholders", () => {
    expect(
      interpolate("{greeting}, {name}!", { greeting: "Hello", name: "world" }),
    ).toBe("Hello, world!");
  });

  it("resolves dot-path placeholders", () => {
    const row = { meta: { score: 95 } };
    expect(interpolate("Score: {meta.score}", row)).toBe("Score: 95");
  });

  it("trims whitespace inside braces", () => {
    expect(interpolate("{ file }", { file: "a.ts" })).toBe("a.ts");
  });

  it("stringifies numbers", () => {
    expect(interpolate("count={count}", { count: 42 })).toBe("count=42");
  });

  it("stringifies booleans", () => {
    expect(interpolate("ok={ok}", { ok: true })).toBe("ok=true");
  });

  it("JSON-serializes objects", () => {
    const row = { data: { x: 1 } };
    expect(interpolate("data={data}", row)).toBe('data={"x":1}');
  });

  it("JSON-serializes arrays", () => {
    const row = { items: [1, 2, 3] };
    expect(interpolate("items={items}", row)).toBe("items=[1,2,3]");
  });

  it("throws listing all missing columns at once", () => {
    expect(() => interpolate("{a} and {b}", { c: 1 })).toThrow(
      "missing columns: a, b",
    );
  });

  it("throws for a single missing column", () => {
    expect(() => interpolate("Review {file}", {})).toThrow(
      "missing columns: file",
    );
  });

  it("returns the template unchanged when no placeholders exist", () => {
    expect(interpolate("no placeholders here", { file: "a.ts" })).toBe(
      "no placeholders here",
    );
  });

  it("handles empty template", () => {
    expect(interpolate("", { file: "a.ts" })).toBe("");
  });
});
