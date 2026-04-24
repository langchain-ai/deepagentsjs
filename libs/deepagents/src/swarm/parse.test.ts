import { describe, it, expect } from "vitest";
import { parseTableJsonl, serializeTableJsonl } from "./parse.js";

// ─── parseTableJsonl ─────────────────────────────────────────────────────────

describe("parseTableJsonl", () => {
  it("returns an empty array for an empty string", () => {
    expect(parseTableJsonl("")).toEqual([]);
  });

  it("returns an empty array for whitespace-only content", () => {
    expect(parseTableJsonl("   \n  \n  ")).toEqual([]);
  });

  it("parses a single JSON object line", () => {
    expect(parseTableJsonl('{"id":"r1","text":"hello"}\n')).toEqual([
      { id: "r1", text: "hello" },
    ]);
  });

  it("parses multiple JSON object lines", () => {
    const input = ['{"id":"r1"}', '{"id":"r2"}', '{"id":"r3"}'].join("\n");
    const rows = parseTableJsonl(input);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ id: "r1" });
    expect(rows[2]).toEqual({ id: "r3" });
  });

  it("handles a trailing newline without creating an extra row", () => {
    const rows = parseTableJsonl('{"id":"r1"}\n');
    expect(rows).toHaveLength(1);
  });

  it("skips blank lines between records", () => {
    const input = '{"id":"r1"}\n\n\n{"id":"r2"}\n';
    expect(parseTableJsonl(input)).toHaveLength(2);
  });

  it("preserves all column types: string, number, boolean, null, array, object", () => {
    const row = {
      s: "hello",
      n: 42,
      b: true,
      nil: null,
      arr: [1, 2],
      nested: { x: 1 },
    };
    const input = JSON.stringify(row) + "\n";
    expect(parseTableJsonl(input)).toEqual([row]);
  });

  it("throws on invalid JSON with a line-numbered message", () => {
    const input = '{"id":"r1"}\nnot json\n';
    expect(() => parseTableJsonl(input)).toThrow("Line 2: invalid JSON");
  });

  it("throws when a line is a JSON array", () => {
    const input = '{"id":"r1"}\n["array"]\n';
    expect(() => parseTableJsonl(input)).toThrow(
      "Line 2: expected a JSON object, got array",
    );
  });

  it("throws when a line is JSON null", () => {
    const input = '{"id":"r1"}\nnull\n';
    expect(() => parseTableJsonl(input)).toThrow(
      "Line 2: expected a JSON object",
    );
  });

  it("throws when a line is a JSON primitive string", () => {
    const input = '"just a string"\n';
    expect(() => parseTableJsonl(input)).toThrow(
      "Line 1: expected a JSON object, got string",
    );
  });

  it("throws when a line is a JSON number", () => {
    const input = "42\n";
    expect(() => parseTableJsonl(input)).toThrow(
      "Line 1: expected a JSON object, got number",
    );
  });

  it("collects all errors before throwing (does not stop at first)", () => {
    const input = ["not json", "also not json", '{"id":"r1"}'].join("\n");
    let caught: Error | undefined;
    try {
      parseTableJsonl(input);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("Line 1:");
    expect(caught!.message).toContain("Line 2:");
    expect(caught!.message).not.toContain("Line 3:");
  });

  it("error message starts with 'Table parse failed:'", () => {
    expect(() => parseTableJsonl("bad json\n")).toThrow(/^Table parse failed:/);
  });

  it("line numbers count non-blank lines, not raw file lines", () => {
    // blank line between two records, then a bad line
    // after filtering blanks: good(1), good(2), bad(3)
    const input = '{"a":1}\n\n{"b":2}\nbad\n';
    expect(() => parseTableJsonl(input)).toThrow("Line 3: invalid JSON");
  });

  it("allows rows without an id field", () => {
    const rows = parseTableJsonl('{"text":"no id"}\n');
    expect(rows).toEqual([{ text: "no id" }]);
  });

  it("allows duplicate id values across rows", () => {
    const input = '{"id":"dup","v":1}\n{"id":"dup","v":2}\n';
    expect(parseTableJsonl(input)).toHaveLength(2);
  });
});

// ─── serializeTableJsonl ─────────────────────────────────────────────────────

describe("serializeTableJsonl", () => {
  it("returns an empty string for an empty array", () => {
    expect(serializeTableJsonl([])).toBe("");
  });

  it("serializes a single row with a trailing newline", () => {
    const out = serializeTableJsonl([{ id: "r1", val: 42 }]);
    expect(out).toBe('{"id":"r1","val":42}\n');
  });

  it("serializes multiple rows, one per line with a trailing newline", () => {
    const rows = [{ id: "r1" }, { id: "r2" }];
    const out = serializeTableJsonl(rows);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3); // 2 data lines + trailing empty
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0]!)).toEqual({ id: "r1" });
    expect(JSON.parse(lines[1]!)).toEqual({ id: "r2" });
  });

  it("always ends with a newline for non-empty input", () => {
    const out = serializeTableJsonl([{ id: "x" }]);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("preserves nested objects", () => {
    const rows = [{ id: "r1", meta: { score: 0.9, label: "good" } }];
    const parsed = JSON.parse(serializeTableJsonl(rows).trim());
    expect(parsed.meta).toEqual({ score: 0.9, label: "good" });
  });

  it("round-trips through parseTableJsonl", () => {
    const rows = [
      { id: "a", text: "alpha", score: 1 },
      { id: "b", text: "beta", score: 2 },
    ];
    expect(parseTableJsonl(serializeTableJsonl(rows))).toEqual(rows);
  });

  it("round-trips for rows without an id", () => {
    const rows = [{ text: "no id", val: true }];
    expect(parseTableJsonl(serializeTableJsonl(rows))).toEqual(rows);
  });
});
