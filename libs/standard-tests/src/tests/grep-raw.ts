import { adaptSandboxInstance } from "../adapter.js";
import type { AnySandboxInstance, StandardTestsConfig } from "../types.js";

/**
 * Register grep() tests (basic search, glob filter, no matches,
 * multi matches, literal matching, unicode, case sensitivity, special chars,
 * empty dir, nested dirs, line numbers).
 */
export function registerGrepRawTests<T extends AnySandboxInstance>(
  getShared: () => T,
  config: StandardTestsConfig<T>,
  timeout: number,
): void {
  const { describe, it, expect } = config.runner;

  describe("grep", () => {
    it(
      "should find basic literal pattern matches",
      async () => {
        const shared = adaptSandboxInstance(getShared());
        const baseDir = config.resolvePath("gr-basic");
        await shared.write(
          `${baseDir}/file1.txt`,
          "Hello world\nGoodbye world",
        );
        await shared.write(
          `${baseDir}/file2.txt`,
          "Hello there\nGoodbye friend",
        );

        const result = await shared.grep("Hello", baseDir);

        expect(result.error).toBeUndefined();
        const matches = result.matches!;
        expect(matches.length).toBe(2);

        const paths = matches.map((m) => m.path);
        expect(paths.some((p) => p.includes("file1.txt"))).toBe(true);
        expect(paths.some((p) => p.includes("file2.txt"))).toBe(true);

        for (const match of matches) {
          expect(match.line).toBe(1);
          expect(match.text).toContain("Hello");
        }
      },
      timeout,
    );

    it(
      "should filter files with glob pattern",
      async () => {
        const shared = adaptSandboxInstance(getShared());
        const baseDir = config.resolvePath("gr-glob");
        await shared.write(`${baseDir}/test.txt`, "pattern_match");
        await shared.write(`${baseDir}/test.py`, "pattern_match");
        await shared.write(`${baseDir}/test.md`, "pattern_match");

        const result = await shared.grep("pattern_match", baseDir, "*.py");

        expect(result.error).toBeUndefined();
        const matches = result.matches!;
        expect(matches.length).toBe(1);
        expect(matches[0].path).toContain("test.py");
      },
      timeout,
    );

    it(
      "should return empty matches when no matches found",
      async () => {
        const shared = adaptSandboxInstance(getShared());
        const baseDir = config.resolvePath("gr-no-match");
        await shared.write(`${baseDir}/file.txt`, "Hello world");

        const result = await shared.grep("nonexistent_str", baseDir);

        expect(result.error).toBeUndefined();
        expect(result.matches!.length).toBe(0);
      },
      timeout,
    );

    it(
      "should find multiple matches in a single file",
      async () => {
        const shared = adaptSandboxInstance(getShared());
        const baseDir = config.resolvePath("gr-multi");
        await shared.write(
          `${baseDir}/fruits.txt`,
          "apple\nbanana\napple\norange\napple",
        );

        const result = await shared.grep("apple", baseDir);

        expect(result.error).toBeUndefined();
        const matches = result.matches!;
        expect(matches.length).toBe(3);

        const lineNumbers = matches.map((m) => m.line);
        expect(lineNumbers).toEqual([1, 3, 5]);
      },
      timeout,
    );

    it(
      "should match literal strings not regex",
      async () => {
        const shared = adaptSandboxInstance(getShared());
        const baseDir = config.resolvePath("gr-literal");
        await shared.write(
          `${baseDir}/numbers.txt`,
          "test123\ntest456\nabcdef",
        );

        const result = await shared.grep("test123", baseDir);

        expect(result.error).toBeUndefined();
        const matches = result.matches!;
        expect(matches.length).toBe(1);
        expect(matches[0].text).toContain("test123");
      },
      timeout,
    );

    it(
      "should find unicode patterns",
      async () => {
        const shared = adaptSandboxInstance(getShared());
        const baseDir = config.resolvePath("gr-unicode");
        await shared.write(
          `${baseDir}/unicode.txt`,
          "Hello \u4E16\u754C\n\u041F\u0440\u0438\u0432\u0435\u0442 \u043C\u0438\u0440\n\u6D4B\u8BD5 pattern",
        );

        const result = await shared.grep("\u4E16\u754C", baseDir);

        expect(result.error).toBeUndefined();
        const matches = result.matches!;
        expect(matches.length).toBe(1);
        expect(matches[0].text).toContain("\u4E16\u754C");
      },
      timeout,
    );

    it(
      "should be case-sensitive by default",
      async () => {
        const shared = adaptSandboxInstance(getShared());
        const baseDir = config.resolvePath("gr-case");
        await shared.write(`${baseDir}/case.txt`, "Hello\nhello\nHELLO");

        const result = await shared.grep("Hello", baseDir);

        expect(result.error).toBeUndefined();
        const matches = result.matches!;
        // Should only match "Hello", not "hello" or "HELLO"
        expect(matches.length).toBe(1);
        expect(matches[0].text).toContain("Hello");
      },
      timeout,
    );

    it(
      "should handle special characters as literals",
      async () => {
        const shared = adaptSandboxInstance(getShared());
        const baseDir = config.resolvePath("gr-special");
        await shared.write(
          `${baseDir}/special.txt`,
          "Price: $100\nPath: /usr/bin\nPattern: [a-z]*",
        );

        // Test with dollar sign (literal)
        const result1 = await shared.grep("$100", baseDir);
        expect(result1.error).toBeUndefined();
        const matches1 = result1.matches!;
        expect(matches1.length).toBe(1);
        expect(matches1[0].text).toContain("$100");

        // Test with brackets (literal)
        const result2 = await shared.grep("[a-z]*", baseDir);
        expect(result2.error).toBeUndefined();
        const matches2 = result2.matches!;
        expect(matches2.length).toBe(1);
        expect(matches2[0].text).toContain("[a-z]*");
      },
      timeout,
    );

    it(
      "should return empty matches for empty directory",
      async () => {
        const shared = adaptSandboxInstance(getShared());
        const baseDir = config.resolvePath("gr-empty-dir");
        await shared.execute(`mkdir -p '${baseDir}'`);

        const result = await shared.grep("anything", baseDir);

        expect(result.error).toBeUndefined();
        expect(result.matches!.length).toBe(0);
      },
      timeout,
    );

    it(
      "should search recursively across nested directories",
      async () => {
        const shared = adaptSandboxInstance(getShared());
        const baseDir = config.resolvePath("gr-nested");
        await shared.write(`${baseDir}/root.txt`, "target_nested here");
        await shared.write(`${baseDir}/sub1/level1.txt`, "target_nested here");
        await shared.write(
          `${baseDir}/sub1/sub2/level2.txt`,
          "target_nested here",
        );

        const result = await shared.grep("target_nested", baseDir);

        expect(result.error).toBeUndefined();
        const matches = result.matches!;
        expect(matches.length).toBe(3);
      },
      timeout,
    );

    it(
      "should report correct line numbers",
      async () => {
        const shared = adaptSandboxInstance(getShared());
        const baseDir = config.resolvePath("gr-line-nums");
        const content = Array.from(
          { length: 100 },
          (_, i) => `Line ${i + 1}`,
        ).join("\n");
        await shared.write(`${baseDir}/long.txt`, content);

        const result = await shared.grep("Line 50", baseDir);

        expect(result.error).toBeUndefined();
        const matches = result.matches!;
        expect(matches.length).toBe(1);
        expect(matches[0].line).toBe(50);
      },
      timeout,
    );
  });
}
