import { describe, it, expect } from "vitest";
import type { SandboxInstance, StandardTestsConfig } from "../sandbox.js";

/**
 * Register detailed edit() tests (single/multi occurrence, replaceAll,
 * not found, special chars, multiline, delete, identical, unicode,
 * whitespace, long strings, line endings, partial match).
 */
export function registerEditTests<T extends SandboxInstance>(
  getShared: () => T,
  config: StandardTestsConfig<T>,
  timeout: number,
): void {
  describe("edit", () => {
    it(
      "should edit a single occurrence",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-single.txt");
        await shared.write(
          filePath,
          "Hello world\nGoodbye world\nHello again",
        );

        const result = await shared.edit(filePath, "Goodbye", "Farewell");

        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(1);

        const content = await shared.read(filePath);
        expect(content).toContain("Farewell world");
        expect(content).not.toContain("Goodbye");
      },
      timeout,
    );

    it(
      "should fail with multiple occurrences without replaceAll",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-multi-fail.txt");
        await shared.write(
          filePath,
          "apple\nbanana\napple\norange\napple",
        );

        const result = await shared.edit(filePath, "apple", "pear", false);

        expect(result.error).toBeDefined();
        expect(result.error!.toLowerCase()).toContain("multiple");

        // Verify file unchanged
        const content = await shared.read(filePath);
        expect(content).toContain("apple");
        expect(content).not.toContain("pear");
      },
      timeout,
    );

    it(
      "should replace all occurrences with replaceAll=true",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-replace-all.txt");
        await shared.write(
          filePath,
          "apple\nbanana\napple\norange\napple",
        );

        const result = await shared.edit(filePath, "apple", "pear", true);

        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(3);

        // Verify all replaced
        const execResult = await shared.execute(`cat ${filePath}`);
        expect(execResult.output).not.toContain("apple");
        const pearCount = execResult.output.split("pear").length - 1;
        expect(pearCount).toBe(3);
      },
      timeout,
    );

    it(
      "should return error when string is not found",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-not-found.txt");
        await shared.write(filePath, "Hello world");

        const result = await shared.edit(
          filePath,
          "nonexistent",
          "replacement",
        );

        expect(result.error).toBeDefined();
        expect(result.error!.toLowerCase()).toContain("not found");
      },
      timeout,
    );

    it(
      "should return error for nonexistent file",
      async () => {
        const filePath = config.resolvePath("ed-nonexistent-xyz.txt");

        const result = await getShared().edit(filePath, "old", "new");

        expect(result.error).toBeDefined();
        expect(result.error!.toLowerCase()).toContain("not found");
      },
      timeout,
    );

    it(
      "should handle special characters and regex metacharacters",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-special.txt");
        await shared.write(
          filePath,
          "Price: $100.00\nPattern: [a-z]*\nPath: /usr/bin",
        );

        // Test with dollar signs
        const result1 = await shared.edit(filePath, "$100.00", "$200.00");
        expect(result1.error).toBeUndefined();

        // Test with regex metacharacters
        const result2 = await shared.edit(filePath, "[a-z]*", "[0-9]+");
        expect(result2.error).toBeUndefined();

        // Verify changes
        const content = await shared.read(filePath);
        expect(content).toContain("$200.00");
        expect(content).toContain("[0-9]+");
      },
      timeout,
    );

    it(
      "should handle multiline string replacement",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-multiline.txt");
        await shared.write(filePath, "Line 1\nLine 2\nLine 3");

        const result = await shared.edit(
          filePath,
          "Line 1\nLine 2",
          "Combined",
        );

        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(1);

        const content = await shared.read(filePath);
        expect(content).toContain("Combined");
        expect(content).toContain("Line 3");
        expect(content).not.toContain("Line 1");
      },
      timeout,
    );

    it(
      "should delete content by replacing with empty string",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-delete.txt");
        await shared.write(
          filePath,
          "Keep this\nDelete this part\nKeep this too",
        );

        const result = await shared.edit(
          filePath,
          "Delete this part\n",
          "",
        );

        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(1);

        const content = await shared.read(filePath);
        expect(content).toContain("Keep this");
        expect(content).toContain("Keep this too");
        expect(content).not.toContain("Delete this part");
      },
      timeout,
    );

    it(
      "should handle identical old and new strings",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-identical.txt");
        await shared.write(filePath, "Same text");

        const result = await shared.edit(filePath, "Same text", "Same text");

        // Should succeed with 1 occurrence
        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(1);

        const content = await shared.read(filePath);
        expect(content).toContain("Same text");
      },
      timeout,
    );

    it(
      "should handle unicode content",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-unicode.txt");
        await shared.write(
          filePath,
          "Hello \u{1F44B} world\n\u4E16\u754C is beautiful",
        );

        const result = await shared.edit(
          filePath,
          "\u{1F44B}",
          "\u{1F30D}",
        );

        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(1);

        const content = await shared.read(filePath);
        expect(content).toContain("\u{1F30D}");
        expect(content).not.toContain("\u{1F44B}");
      },
      timeout,
    );

    it(
      "should handle whitespace-only strings",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-whitespace.txt");
        await shared.write(filePath, "Line1    Line2"); // 4 spaces

        const result = await shared.edit(filePath, "    ", " "); // 4→1 space

        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(1);

        const content = await shared.read(filePath);
        expect(content).toContain("Line1 Line2");
      },
      timeout,
    );

    it(
      "should handle very long old and new strings",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-long.txt");
        const oldString = "x".repeat(1000);
        const newString = "y".repeat(1000);
        await shared.write(filePath, `Start\n${oldString}\nEnd`);

        const result = await shared.edit(filePath, oldString, newString);

        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(1);

        const content = await shared.read(filePath);
        expect(content).toContain("y".repeat(100)); // partial check
        expect(content).not.toContain("x".repeat(100));
      },
      timeout,
    );

    it(
      "should preserve line endings correctly",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-line-endings.txt");
        await shared.write(filePath, "Line 1\nLine 2\nLine 3\n");

        const result = await shared.edit(
          filePath,
          "Line 2",
          "Modified Line 2",
        );

        expect(result.error).toBeUndefined();

        const content = await shared.read(filePath);
        expect(content).toContain("Line 1");
        expect(content).toContain("Modified Line 2");
        expect(content).toContain("Line 3");
      },
      timeout,
    );

    it(
      "should edit a substring within a line",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("ed-partial.txt");
        await shared.write(
          filePath,
          "The quick brown fox jumps over the lazy dog",
        );

        const result = await shared.edit(filePath, "brown fox", "red cat");

        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(1);

        const execResult = await shared.execute(`cat ${filePath}`);
        expect(execResult.output).toContain("The quick red cat jumps");
      },
      timeout,
    );
  });
}
