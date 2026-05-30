import { describe, it, expect } from "vitest";
import { formatReplResult, toCamelCase } from "./utils.js";
import type { ReplResult } from "./types.js";

describe("formatReplResult", () => {
  it("should format successful results", () => {
    const result: ReplResult = {
      ok: true,
      value: 42,
      logs: [],
      logsDroppedChars: 0,
    };
    expect(formatReplResult(result)).toBe("→ 42");
  });

  it("should format string results", () => {
    const result: ReplResult = {
      ok: true,
      value: "hello",
      logs: [],
      logsDroppedChars: 0,
    };
    expect(formatReplResult(result)).toBe("→ hello");
  });

  it("should format object results", () => {
    const result: ReplResult = {
      ok: true,
      value: { a: 1 },
      logs: [],
      logsDroppedChars: 0,
    };
    const formatted = formatReplResult(result);
    expect(formatted).toContain("→");
    expect(formatted).toContain('"a": 1');
  });

  it("should format successful results containing bigint", () => {
    const result: ReplResult = {
      ok: true,
      value: 9007199254740993n,
      logs: [],
      logsDroppedChars: 0,
    };
    expect(formatReplResult(result)).toBe("→ 9007199254740993");
  });

  it("should format object results containing nested bigint", () => {
    const result: ReplResult = {
      ok: true,
      value: { count: 12345678901234567890n, nested: [2n, 3n] },
      logs: [],
      logsDroppedChars: 0,
    };
    const formatted = formatReplResult(result);
    expect(formatted).toContain("→");
    expect(formatted).toContain('"count": "12345678901234567890"');
    expect(formatted).toContain('"nested": [\n    "2",\n    "3"\n  ]');
  });

  it("should include logs", () => {
    const result: ReplResult = {
      ok: true,
      value: 42,
      logs: ["log1", "log2"],
      logsDroppedChars: 0,
    };
    const formatted = formatReplResult(result);
    expect(formatted).toContain("log1");
    expect(formatted).toContain("log2");
    expect(formatted).toContain("→ 42");
  });

  it("should format errors", () => {
    const result: ReplResult = {
      ok: false,
      error: { name: "TypeError", message: "is not a function" },
      logs: [],
      logsDroppedChars: 0,
    };
    expect(formatReplResult(result)).toContain("TypeError: is not a function");
  });

  it("should return '(no output)' for undefined results with no logs", () => {
    const result: ReplResult = {
      ok: true,
      value: undefined,
      logs: [],
      logsDroppedChars: 0,
    };
    expect(formatReplResult(result)).toBe("(no output)");
  });
});

describe("toCamelCase", () => {
  it("should convert snake_case to camelCase", () => {
    expect(toCamelCase("web_search")).toBe("webSearch");
    expect(toCamelCase("read_file")).toBe("readFile");
    expect(toCamelCase("http_request")).toBe("httpRequest");
  });

  it("should handle multiple underscores", () => {
    expect(toCamelCase("get_user_name")).toBe("getUserName");
  });

  it("should leave already camelCase names unchanged", () => {
    expect(toCamelCase("grep")).toBe("grep");
    expect(toCamelCase("task")).toBe("task");
    expect(toCamelCase("webSearch")).toBe("webSearch");
  });

  it("should handle kebab-case", () => {
    expect(toCamelCase("web-search")).toBe("webSearch");
  });
});
