import { describe, it, expect } from "vitest";
import { readColumn, evaluateFilter, type SwarmFilter } from "./filter.js";

// ─── readColumn ─────────────────────────────────────────────────────────────

describe("readColumn", () => {
  it("reads a top-level key", () => {
    expect(readColumn({ name: "acme" }, "name")).toBe("acme");
  });

  it("reads a two-level dotted path", () => {
    expect(readColumn({ meta: { score: 0.9 } }, "meta.score")).toBe(0.9);
  });

  it("reads a three-level dotted path", () => {
    const row = { a: { b: { c: "deep" } } };
    expect(readColumn(row, "a.b.c")).toBe("deep");
  });

  it("returns undefined for a missing top-level key", () => {
    expect(readColumn({}, "missing")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment is absent", () => {
    expect(readColumn({ a: {} }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment is not an object", () => {
    expect(readColumn({ a: "string" }, "a.b")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment is null", () => {
    expect(readColumn({ a: null }, "a.b")).toBeUndefined();
  });

  it("returns null at the leaf", () => {
    expect(readColumn({ status: null }, "status")).toBeNull();
  });

  it("returns 0 (falsy number) at the leaf", () => {
    expect(readColumn({ count: 0 }, "count")).toBe(0);
  });

  it("returns false (falsy boolean) at the leaf", () => {
    expect(readColumn({ flag: false }, "flag")).toBe(false);
  });

  it("returns empty string (falsy string) at the leaf", () => {
    expect(readColumn({ label: "" }, "label")).toBe("");
  });

  it("returns an object at the leaf (no deep copy)", () => {
    const inner = { x: 1 };
    expect(readColumn({ meta: inner }, "meta")).toBe(inner);
  });
});

// ─── evaluateFilter ──────────────────────────────────────────────────────────

describe("evaluateFilter", () => {
  // -- equals --

  describe("equals", () => {
    it("matches a string value", () => {
      const f: SwarmFilter = { column: "status", equals: "pending" };
      expect(evaluateFilter(f, { status: "pending" })).toBe(true);
    });

    it("does not match a different string", () => {
      const f: SwarmFilter = { column: "status", equals: "pending" };
      expect(evaluateFilter(f, { status: "done" })).toBe(false);
    });

    it("matches a number value", () => {
      const f: SwarmFilter = { column: "score", equals: 42 };
      expect(evaluateFilter(f, { score: 42 })).toBe(true);
    });

    it("matches structurally equal objects", () => {
      const f: SwarmFilter = { column: "meta", equals: { tier: "A" } };
      expect(evaluateFilter(f, { meta: { tier: "A" } })).toBe(true);
    });

    it("does not match objects with different shapes", () => {
      const f: SwarmFilter = { column: "meta", equals: { tier: "A" } };
      expect(evaluateFilter(f, { meta: { tier: "B" } })).toBe(false);
    });

    it("matches null", () => {
      const f: SwarmFilter = { column: "result", equals: null };
      expect(evaluateFilter(f, { result: null })).toBe(true);
    });

    it("does not match an absent key", () => {
      const f: SwarmFilter = { column: "x", equals: "y" };
      expect(evaluateFilter(f, {})).toBe(false);
    });

    it("follows a dotted path", () => {
      const f: SwarmFilter = { column: "sentiment.class", equals: "positive" };
      expect(evaluateFilter(f, { sentiment: { class: "positive" } })).toBe(
        true,
      );
    });
  });

  // -- notEquals --

  describe("notEquals", () => {
    it("returns true when values differ", () => {
      const f: SwarmFilter = { column: "status", notEquals: "done" };
      expect(evaluateFilter(f, { status: "pending" })).toBe(true);
    });

    it("returns false when values are equal", () => {
      const f: SwarmFilter = { column: "status", notEquals: "done" };
      expect(evaluateFilter(f, { status: "done" })).toBe(false);
    });

    it("returns true for an absent key compared to a defined value", () => {
      const f: SwarmFilter = { column: "x", notEquals: "something" };
      expect(evaluateFilter(f, {})).toBe(true);
    });
  });

  // -- in --

  describe("in", () => {
    it("returns true when value is in the array", () => {
      const f: SwarmFilter = { column: "cat", in: ["A", "B", "C"] };
      expect(evaluateFilter(f, { cat: "B" })).toBe(true);
    });

    it("returns false when value is not in the array", () => {
      const f: SwarmFilter = { column: "cat", in: ["A", "B", "C"] };
      expect(evaluateFilter(f, { cat: "D" })).toBe(false);
    });

    it("returns false for an absent key", () => {
      const f: SwarmFilter = { column: "cat", in: ["A"] };
      expect(evaluateFilter(f, {})).toBe(false);
    });

    it("matches objects structurally", () => {
      const f: SwarmFilter = {
        column: "meta",
        in: [{ tier: "A" }, { tier: "B" }],
      };
      expect(evaluateFilter(f, { meta: { tier: "A" } })).toBe(true);
    });

    it("returns false for an empty array", () => {
      const f: SwarmFilter = { column: "x", in: [] };
      expect(evaluateFilter(f, { x: "anything" })).toBe(false);
    });
  });

  // -- exists --

  describe("exists", () => {
    it("exists: true is satisfied when the value is present and non-null", () => {
      const f: SwarmFilter = { column: "result", exists: true };
      expect(evaluateFilter(f, { result: "some output" })).toBe(true);
    });

    it("exists: true is satisfied for falsy-but-defined values", () => {
      const f: SwarmFilter = { column: "count", exists: true };
      expect(evaluateFilter(f, { count: 0 })).toBe(true);
    });

    it("exists: true is not satisfied when the key is absent", () => {
      const f: SwarmFilter = { column: "result", exists: true };
      expect(evaluateFilter(f, {})).toBe(false);
    });

    it("exists: true is not satisfied when value is null", () => {
      const f: SwarmFilter = { column: "result", exists: true };
      expect(evaluateFilter(f, { result: null })).toBe(false);
    });

    it("exists: false is satisfied when the key is absent", () => {
      const f: SwarmFilter = { column: "result", exists: false };
      expect(evaluateFilter(f, {})).toBe(true);
    });

    it("exists: false is satisfied when the value is null", () => {
      const f: SwarmFilter = { column: "result", exists: false };
      expect(evaluateFilter(f, { result: null })).toBe(true);
    });

    it("exists: false is not satisfied when value is present", () => {
      const f: SwarmFilter = { column: "result", exists: false };
      expect(evaluateFilter(f, { result: "output" })).toBe(false);
    });
  });

  // -- and --

  describe("and", () => {
    it("returns true when all clauses match", () => {
      const f: SwarmFilter = {
        and: [
          { column: "status", equals: "pending" },
          { column: "result", exists: false },
        ],
      };
      expect(evaluateFilter(f, { status: "pending" })).toBe(true);
    });

    it("returns false when any clause does not match", () => {
      const f: SwarmFilter = {
        and: [
          { column: "status", equals: "pending" },
          { column: "result", exists: false },
        ],
      };
      expect(evaluateFilter(f, { status: "done" })).toBe(false);
    });

    it("returns false when second clause fails", () => {
      const f: SwarmFilter = {
        and: [
          { column: "status", equals: "pending" },
          { column: "result", exists: false },
        ],
      };
      expect(evaluateFilter(f, { status: "pending", result: "done" })).toBe(
        false,
      );
    });

    it("returns true for an empty and (vacuously true)", () => {
      const f: SwarmFilter = { and: [] };
      expect(evaluateFilter(f, {})).toBe(true);
    });
  });

  // -- or --

  describe("or", () => {
    it("returns true when at least one clause matches", () => {
      const f: SwarmFilter = {
        or: [
          { column: "status", equals: "pending" },
          { column: "status", equals: "retry" },
        ],
      };
      expect(evaluateFilter(f, { status: "retry" })).toBe(true);
    });

    it("returns false when no clause matches", () => {
      const f: SwarmFilter = {
        or: [
          { column: "status", equals: "pending" },
          { column: "status", equals: "retry" },
        ],
      };
      expect(evaluateFilter(f, { status: "done" })).toBe(false);
    });

    it("returns false for an empty or (vacuously false)", () => {
      const f: SwarmFilter = { or: [] };
      expect(evaluateFilter(f, {})).toBe(false);
    });
  });

  // -- nested combinators --

  describe("nested combinators", () => {
    it("handles and with or inside", () => {
      const f: SwarmFilter = {
        and: [
          { column: "active", equals: true },
          {
            or: [
              { column: "tier", equals: "A" },
              { column: "tier", equals: "B" },
            ],
          },
        ],
      };
      expect(evaluateFilter(f, { active: true, tier: "A" })).toBe(true);
      expect(evaluateFilter(f, { active: true, tier: "C" })).toBe(false);
      expect(evaluateFilter(f, { active: false, tier: "A" })).toBe(false);
    });

    it("handles or with and inside", () => {
      const f: SwarmFilter = {
        or: [
          {
            and: [
              { column: "a", equals: 1 },
              { column: "b", equals: 2 },
            ],
          },
          { column: "c", equals: 3 },
        ],
      };
      expect(evaluateFilter(f, { a: 1, b: 2 })).toBe(true);
      expect(evaluateFilter(f, { c: 3 })).toBe(true);
      expect(evaluateFilter(f, { a: 1 })).toBe(false);
    });
  });
});
