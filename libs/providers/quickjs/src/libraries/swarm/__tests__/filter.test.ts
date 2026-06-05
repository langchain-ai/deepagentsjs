import { describe, it, expect } from "vitest";
import { evaluateFilter } from "../source/filter.js";
import type { SwarmFilter } from "../source/types.js";

const row = {
  id: "row1",
  status: "done",
  score: 85,
  tags: ["a", "b"],
  meta: { level: 3, flag: null },
  empty: null,
};

describe("evaluateFilter", () => {
  describe("equals", () => {
    it("matches a string value", () => {
      expect(evaluateFilter({ column: "status", equals: "done" }, row)).toBe(
        true,
      );
    });

    it("rejects a non-matching value", () => {
      expect(evaluateFilter({ column: "status", equals: "pending" }, row)).toBe(
        false,
      );
    });

    it("matches a number", () => {
      expect(evaluateFilter({ column: "score", equals: 85 }, row)).toBe(true);
    });

    it("matches an array by deep equality", () => {
      expect(evaluateFilter({ column: "tags", equals: ["a", "b"] }, row)).toBe(
        true,
      );
    });

    it("matches null", () => {
      expect(evaluateFilter({ column: "empty", equals: null }, row)).toBe(true);
    });
  });

  describe("notEquals", () => {
    it("matches when values differ", () => {
      expect(
        evaluateFilter({ column: "status", notEquals: "pending" }, row),
      ).toBe(true);
    });

    it("rejects when values match", () => {
      expect(evaluateFilter({ column: "status", notEquals: "done" }, row)).toBe(
        false,
      );
    });
  });

  describe("in", () => {
    it("matches when value is in the list", () => {
      expect(
        evaluateFilter(
          { column: "status", in: ["pending", "done", "failed"] },
          row,
        ),
      ).toBe(true);
    });

    it("rejects when value is not in the list", () => {
      expect(
        evaluateFilter({ column: "status", in: ["pending", "failed"] }, row),
      ).toBe(false);
    });
  });

  describe("exists", () => {
    it("matches a present non-null value", () => {
      expect(evaluateFilter({ column: "status", exists: true }, row)).toBe(
        true,
      );
    });

    it("rejects a null value with exists: true", () => {
      expect(evaluateFilter({ column: "empty", exists: true }, row)).toBe(
        false,
      );
    });

    it("matches a null value with exists: false", () => {
      expect(evaluateFilter({ column: "empty", exists: false }, row)).toBe(
        true,
      );
    });

    it("matches a missing column with exists: false", () => {
      expect(
        evaluateFilter({ column: "nonexistent", exists: false }, row),
      ).toBe(true);
    });

    it("rejects a present value with exists: false", () => {
      expect(evaluateFilter({ column: "status", exists: false }, row)).toBe(
        false,
      );
    });
  });

  describe("dot-path columns", () => {
    it("reads nested values", () => {
      expect(evaluateFilter({ column: "meta.level", equals: 3 }, row)).toBe(
        true,
      );
    });

    it("handles nested null", () => {
      expect(evaluateFilter({ column: "meta.flag", exists: false }, row)).toBe(
        true,
      );
    });
  });

  describe("and combinator", () => {
    it("matches when all sub-filters match", () => {
      const filter: SwarmFilter = {
        and: [
          { column: "status", equals: "done" },
          { column: "score", equals: 85 },
        ],
      };
      expect(evaluateFilter(filter, row)).toBe(true);
    });

    it("rejects when any sub-filter fails", () => {
      const filter: SwarmFilter = {
        and: [
          { column: "status", equals: "done" },
          { column: "score", equals: 99 },
        ],
      };
      expect(evaluateFilter(filter, row)).toBe(false);
    });

    it("matches with an empty sub-filter list", () => {
      expect(evaluateFilter({ and: [] }, row)).toBe(true);
    });
  });

  describe("or combinator", () => {
    it("matches when at least one sub-filter matches", () => {
      const filter: SwarmFilter = {
        or: [
          { column: "status", equals: "pending" },
          { column: "score", equals: 85 },
        ],
      };
      expect(evaluateFilter(filter, row)).toBe(true);
    });

    it("rejects when no sub-filter matches", () => {
      const filter: SwarmFilter = {
        or: [
          { column: "status", equals: "pending" },
          { column: "score", equals: 99 },
        ],
      };
      expect(evaluateFilter(filter, row)).toBe(false);
    });

    it("rejects with an empty sub-filter list", () => {
      expect(evaluateFilter({ or: [] }, row)).toBe(false);
    });
  });

  describe("nested combinators", () => {
    it("handles or inside and", () => {
      const filter: SwarmFilter = {
        and: [
          { column: "status", equals: "done" },
          {
            or: [
              { column: "score", equals: 100 },
              { column: "score", equals: 85 },
            ],
          },
        ],
      };
      expect(evaluateFilter(filter, row)).toBe(true);
    });
  });
});
