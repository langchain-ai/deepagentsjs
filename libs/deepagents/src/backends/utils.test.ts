import { describe, it, expect } from "vitest";
import {
  validatePath,
  validateFilePath,
  sanitizeToolCallId,
  formatContentWithLineNumbers,
  createFileData,
  updateFileData,
  fileDataToString,
  checkEmptyContent,
  performStringReplacement,
  truncateIfTooLong,
  TOOL_RESULT_TOKEN_LIMIT,
} from "./utils.js";

describe("validatePath", () => {
  it("should add leading slash if missing", () => {
    expect(validatePath("foo/bar")).toBe("/foo/bar/");
  });

  it("should add trailing slash if missing", () => {
    expect(validatePath("/foo/bar")).toBe("/foo/bar/");
  });

  it("should handle root path", () => {
    expect(validatePath("/")).toBe("/");
  });

  it("should handle null path", () => {
    expect(validatePath(null)).toBe("/");
  });

  it("should handle undefined path", () => {
    expect(validatePath(undefined)).toBe("/");
  });

  it("should handle empty string", () => {
    expect(validatePath("")).toBe("/");
  });
});

describe("validateFilePath", () => {
  it("should normalize paths without leading slash", () => {
    expect(validateFilePath("foo/bar")).toBe("/foo/bar");
  });

  it("should normalize paths with redundant slashes", () => {
    expect(validateFilePath("/foo//bar")).toBe("/foo/bar");
  });

  it("should remove dot components", () => {
    expect(validateFilePath("/./foo/./bar")).toBe("/foo/bar");
  });

  it("should reject path traversal with ..", () => {
    expect(() => validateFilePath("../etc/passwd")).toThrow(
      "Path traversal not allowed",
    );
  });

  it("should reject path traversal with .. in middle", () => {
    expect(() => validateFilePath("/foo/../bar")).toThrow(
      "Path traversal not allowed",
    );
  });

  it("should reject tilde paths", () => {
    expect(() => validateFilePath("~/secret")).toThrow(
      "Path traversal not allowed",
    );
  });

  it("should reject Windows absolute paths with backslash", () => {
    expect(() => validateFilePath("C:\\Users\\file.txt")).toThrow(
      "Windows absolute paths are not supported",
    );
  });

  it("should reject Windows absolute paths with forward slash", () => {
    expect(() => validateFilePath("C:/Users/file.txt")).toThrow(
      "Windows absolute paths are not supported",
    );
  });

  it("should reject lowercase Windows paths", () => {
    expect(() => validateFilePath("c:/users/file.txt")).toThrow(
      "Windows absolute paths are not supported",
    );
  });

  it("should normalize backslashes to forward slashes", () => {
    expect(validateFilePath("/foo\\bar")).toBe("/foo/bar");
  });

  it("should validate allowed prefixes when provided", () => {
    expect(validateFilePath("/data/file.txt", ["/data/"])).toBe(
      "/data/file.txt",
    );
  });

  it("should reject paths not starting with allowed prefixes", () => {
    expect(() => validateFilePath("/etc/passwd", ["/data/"])).toThrow(
      'Path must start with one of ["/data/"]',
    );
  });

  it("should accept any of multiple allowed prefixes", () => {
    expect(validateFilePath("/data/file.txt", ["/tmp/", "/data/"])).toBe(
      "/data/file.txt",
    );
    expect(validateFilePath("/tmp/file.txt", ["/tmp/", "/data/"])).toBe(
      "/tmp/file.txt",
    );
  });

  it("should handle root path", () => {
    expect(validateFilePath("/")).toBe("/");
  });
});

describe("sanitizeToolCallId", () => {
  it("should replace dots with underscores", () => {
    expect(sanitizeToolCallId("call.123")).toBe("call_123");
  });

  it("should replace forward slashes with underscores", () => {
    expect(sanitizeToolCallId("call/123")).toBe("call_123");
  });

  it("should replace backslashes with underscores", () => {
    expect(sanitizeToolCallId("call\\123")).toBe("call_123");
  });

  it("should handle multiple replacements", () => {
    expect(sanitizeToolCallId("call.foo/bar\\baz")).toBe("call_foo_bar_baz");
  });

  it("should leave safe strings unchanged", () => {
    expect(sanitizeToolCallId("call_123_abc")).toBe("call_123_abc");
  });
});

describe("formatContentWithLineNumbers", () => {
  it("should format string content with line numbers", () => {
    const result = formatContentWithLineNumbers("line1\nline2");
    expect(result).toContain("1");
    expect(result).toContain("line1");
    expect(result).toContain("2");
    expect(result).toContain("line2");
  });

  it("should format array content with line numbers", () => {
    const result = formatContentWithLineNumbers(["line1", "line2"]);
    expect(result).toContain("1");
    expect(result).toContain("line1");
    expect(result).toContain("2");
    expect(result).toContain("line2");
  });

  it("should use custom start line", () => {
    const result = formatContentWithLineNumbers("line1", 10);
    expect(result).toContain("10");
    expect(result).toContain("line1");
  });

  it("should handle empty trailing newline", () => {
    const result = formatContentWithLineNumbers("line1\nline2\n");
    const lines = result.split("\n");
    expect(lines.length).toBe(2);
  });
});

describe("createFileData", () => {
  it("should create FileData with content split into lines", () => {
    const result = createFileData("line1\nline2");
    expect(result.content).toEqual(["line1", "line2"]);
  });

  it("should set created_at and modified_at timestamps", () => {
    const result = createFileData("content");
    expect(result.created_at).toBeDefined();
    expect(result.modified_at).toBeDefined();
    expect(new Date(result.created_at).getTime()).toBeGreaterThan(0);
  });

  it("should use provided createdAt timestamp", () => {
    const timestamp = "2023-01-01T00:00:00.000Z";
    const result = createFileData("content", timestamp);
    expect(result.created_at).toBe(timestamp);
  });
});

describe("updateFileData", () => {
  it("should update content while preserving created_at", () => {
    const original = createFileData("old content");
    const originalCreatedAt = original.created_at;

    const updated = updateFileData(original, "new content");
    expect(updated.content).toEqual(["new content"]);
    expect(updated.created_at).toBe(originalCreatedAt);
  });

  it("should update modified_at timestamp", () => {
    const original = createFileData("old content");

    // Small delay to ensure different timestamp
    const updated = updateFileData(original, "new content");
    expect(updated.modified_at).toBeDefined();
  });
});

describe("fileDataToString", () => {
  it("should join lines with newlines", () => {
    const fileData = createFileData("line1\nline2\nline3");
    const result = fileDataToString(fileData);
    expect(result).toBe("line1\nline2\nline3");
  });
});

describe("checkEmptyContent", () => {
  it("should return warning for empty string", () => {
    expect(checkEmptyContent("")).not.toBeNull();
  });

  it("should return warning for whitespace-only string", () => {
    expect(checkEmptyContent("   \n\t  ")).not.toBeNull();
  });

  it("should return null for non-empty content", () => {
    expect(checkEmptyContent("hello")).toBeNull();
  });
});

describe("performStringReplacement", () => {
  it("should replace string and return new content with occurrence count", () => {
    const result = performStringReplacement(
      "hello world",
      "world",
      "there",
      false,
    );
    expect(result).toEqual(["hello there", 1]);
  });

  it("should return error if string not found", () => {
    const result = performStringReplacement("hello world", "foo", "bar", false);
    expect(typeof result).toBe("string");
    expect(result).toContain("not found");
  });

  it("should return error if multiple occurrences and replaceAll is false", () => {
    const result = performStringReplacement("foo foo foo", "foo", "bar", false);
    expect(typeof result).toBe("string");
    expect(result).toContain("appears 3 times");
  });

  it("should replace all occurrences when replaceAll is true", () => {
    const result = performStringReplacement("foo foo foo", "foo", "bar", true);
    expect(result).toEqual(["bar bar bar", 3]);
  });

  it("should return error if oldString is empty with non-empty content", () => {
    const result = performStringReplacement("hello world", "", "bar", false);
    expect(typeof result).toBe("string");
    expect(result).toContain("oldString cannot be empty");
  });

  it("should set initial content when both content and oldString are empty", () => {
    const result = performStringReplacement("", "", "initial content", false);
    expect(result).toEqual(["initial content", 0]);
  });

  it("should set initial content when both content and oldString are empty with replaceAll", () => {
    const result = performStringReplacement("", "", "initial content", true);
    expect(result).toEqual(["initial content", 0]);
  });

  it("should return error if oldString is empty with replaceAll true and non-empty content", () => {
    const result = performStringReplacement("hello", "", "bar", true);
    expect(typeof result).toBe("string");
    expect(result).toContain("oldString cannot be empty");
  });

  it("should allow setting empty content on empty file", () => {
    const result = performStringReplacement("", "", "", false);
    expect(result).toEqual(["", 0]);
  });
});

describe("truncateIfTooLong", () => {
  it("should return array unchanged if under limit", () => {
    const input = ["short", "lines"];
    expect(truncateIfTooLong(input)).toEqual(input);
  });

  it("should return string unchanged if under limit", () => {
    const input = "short string";
    expect(truncateIfTooLong(input)).toBe(input);
  });

  it("should truncate long strings", () => {
    const input = "x".repeat(TOOL_RESULT_TOKEN_LIMIT * 5);
    const result = truncateIfTooLong(input);
    expect(result.length).toBeLessThan(input.length);
    expect(result).toContain("truncated");
  });

  it("should truncate long arrays", () => {
    const input = Array(1000).fill("a".repeat(100));
    const result = truncateIfTooLong(input) as string[];
    expect(result.length).toBeLessThan(input.length);
    expect(result[result.length - 1]).toContain("truncated");
  });
});
