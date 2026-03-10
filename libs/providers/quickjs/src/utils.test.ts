import { describe, it, expect } from "vitest";
import { formatReplResult, toCamelCase } from "./utils.js";
import type { ReplResult } from "./types.js";

describe("formatReplResult", () => {
  it("should format successful results", () => {
    const result: ReplResult = { ok: true, value: 42, logs: [] };
    expect(formatReplResult(result)).toBe("→ 42");
  });

  it("should format string results", () => {
    const result: ReplResult = { ok: true, value: "hello", logs: [] };
    expect(formatReplResult(result)).toBe("→ hello");
  });

  it("should format object results", () => {
    const result: ReplResult = { ok: true, value: { a: 1 }, logs: [] };
    const formatted = formatReplResult(result);
    expect(formatted).toContain("→");
    expect(formatted).toContain('"a": 1');
  });

  it("should include logs", () => {
    const result: ReplResult = { ok: true, value: 42, logs: ["log1", "log2"] };
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
    };
    expect(formatReplResult(result)).toContain("TypeError: is not a function");
  });

  it("should return '(no output)' for undefined results with no logs", () => {
    const result: ReplResult = { ok: true, value: undefined, logs: [] };
    expect(formatReplResult(result)).toBe("(no output)");
  });

  it("should include state hint when availableNames is present", () => {
    const result: ReplResult = {
      ok: true,
      value: 42,
      logs: [],
      availableNames: ["x", "y"],
    };
    const formatted = formatReplResult(result);
    expect(formatted).toContain("→ 42");
    expect(formatted).toContain("↳ State: x, y (available in next cell)");
  });

  it("should omit state hint when availableNames is empty", () => {
    const result: ReplResult = {
      ok: true,
      value: 42,
      logs: [],
      availableNames: [],
    };
    expect(formatReplResult(result)).toBe("→ 42");
  });

  it("should include state hint even on errors", () => {
    const result: ReplResult = {
      ok: false,
      error: { name: "ReferenceError", message: "x is not defined" },
      logs: [],
      availableNames: ["prevVar"],
    };
    const formatted = formatReplResult(result);
    expect(formatted).toContain("ReferenceError");
    expect(formatted).toContain("↳ State: prevVar (available in next cell)");
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
