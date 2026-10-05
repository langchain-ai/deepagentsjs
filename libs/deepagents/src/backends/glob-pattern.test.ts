import { describe, it, expect } from "vitest";
import {
  MAX_GLOB_NESTING_DEPTH,
  MAX_GLOB_PATTERN_LENGTH,
  isGlobMatch,
  validateGlobPattern,
} from "./glob-pattern.js";
import { globSearchFiles } from "./utils.js";

const nestedBraces = (depth: number) =>
  `${"{a,".repeat(depth)}b${"}".repeat(depth)}`;
const nestedExtglob = (depth: number) =>
  `${"@(a|".repeat(depth)}b${")".repeat(depth)}`;

describe("validateGlobPattern", () => {
  it.each([
    "**/*.ts",
    "*.{ts,tsx,md}",
    "src/**/{a,b}/*.{js,cjs,mjs}",
    "!(*.d).ts",
    "[abc]*.txt",
    nestedBraces(MAX_GLOB_NESTING_DEPTH),
  ])("accepts %s", (pattern) => {
    expect(validateGlobPattern(pattern)).toBeUndefined();
  });

  it("rejects patterns longer than the limit", () => {
    expect(validateGlobPattern("a".repeat(MAX_GLOB_PATTERN_LENGTH))).toBe(
      undefined,
    );
    expect(
      validateGlobPattern("a".repeat(MAX_GLOB_PATTERN_LENGTH + 1)),
    ).toMatch(/too long/);
  });

  it("rejects brace nesting beyond the limit", () => {
    expect(
      validateGlobPattern(nestedBraces(MAX_GLOB_NESTING_DEPTH + 1)),
    ).toMatch(/too deeply/);
  });

  it("rejects extglob nesting beyond the limit", () => {
    expect(
      validateGlobPattern(nestedExtglob(MAX_GLOB_NESTING_DEPTH + 1)),
    ).toMatch(/too deeply/);
  });

  it("does not count escaped braces as nesting", () => {
    expect(validateGlobPattern("\\{".repeat(100))).toBeUndefined();
  });
});

describe("isGlobMatch", () => {
  it("matches like picomatch for accepted patterns", () => {
    expect(isGlobMatch("a.ts", "*.{ts,md}")).toBe(true);
    expect(isGlobMatch("a.js", "*.{ts,md}")).toBe(false);
  });

  it("matches nothing for a pattern that would abort the process", () => {
    // ~32 KB of nested alternation; picomatch would crash V8 compiling it.
    expect(isGlobMatch("a", nestedBraces(8000))).toBe(false);
    expect(isGlobMatch("a", nestedExtglob(8000))).toBe(false);
  });
});

describe("globSearchFiles", () => {
  it("does not crash on a hostile glob pattern", () => {
    const files = {
      "/a.ts": {
        content: ["x"],
        created_at: "2024-01-01T00:00:00Z",
        modified_at: "2024-01-01T00:00:00Z",
      },
    };
    expect(globSearchFiles(files, nestedBraces(8000))).toBe("No files found");
    expect(globSearchFiles(files, "*.ts")).toContain("/a.ts");
  });
});
