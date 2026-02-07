import { describe, it, expect } from "vitest";
import type { SandboxInstance, StandardTestsConfig } from "../sandbox.js";

/**
 * Register detailed read() tests (basic, nonexistent, empty, offset, limit,
 * offset+limit, unicode, long lines, zero limit, offset beyond, chunked).
 */
export function registerReadTests<T extends SandboxInstance>(
  getShared: () => T,
  config: StandardTestsConfig<T>,
  timeout: number,
): void {
  describe("read", () => {
    it(
      "should read a file with line numbers",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("rd-basic.txt");
        await shared.write(filePath, "Line 1\nLine 2\nLine 3");

        const result = await shared.read(filePath);

        expect(result).not.toContain("Error:");
        expect(result).toContain("Line 1");
        expect(result).toContain("Line 2");
        expect(result).toContain("Line 3");
      },
      timeout,
    );

    it(
      "should return error for nonexistent file",
      async () => {
        const filePath = config.resolvePath("rd-nonexistent-xyz.txt");

        const result = await getShared().read(filePath);

        expect(result).toContain("Error:");
        expect(result.toLowerCase()).toContain("not found");
      },
      timeout,
    );

    it(
      "should handle reading an empty file",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("rd-empty.txt");
        await shared.write(filePath, "");

        const result = await shared.read(filePath);

        // Empty files should return empty or a system message
        expect(result.toLowerCase()).not.toContain("error:");
      },
      timeout,
    );

    it(
      "should read with offset parameter",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("rd-offset.txt");
        const content = Array.from(
          { length: 10 },
          (_, i) => `Row_${i + 1}_content`,
        ).join("\n");
        await shared.write(filePath, content);

        const result = await shared.read(filePath, 5);

        // offset=5 means skip first 5 lines → start from line 6
        expect(result).toContain("Row_6_content");
        expect(result).not.toContain("Row_1_content");
      },
      timeout,
    );

    it(
      "should read with limit parameter",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("rd-limit.txt");
        const content = Array.from(
          { length: 100 },
          (_, i) => `Row_${i + 1}_content`,
        ).join("\n");
        await shared.write(filePath, content);

        const result = await shared.read(filePath, 0, 5);

        expect(result).toContain("Row_1_content");
        expect(result).toContain("Row_5_content");
        expect(result).not.toContain("Row_6_content");
      },
      timeout,
    );

    it(
      "should read with both offset and limit",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("rd-offset-limit.txt");
        const content = Array.from(
          { length: 20 },
          (_, i) => `Row_${i + 1}_content`,
        ).join("\n");
        await shared.write(filePath, content);

        const result = await shared.read(filePath, 10, 5);

        // Should have lines 11–15
        expect(result).toContain("Row_11_content");
        expect(result).toContain("Row_15_content");
        expect(result).not.toContain("Row_10_content");
        expect(result).not.toContain("Row_16_content");
      },
      timeout,
    );

    it(
      "should read unicode content",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("rd-unicode.txt");
        const content =
          "Hello \u{1F44B} \u4E16\u754C\n\u041F\u0440\u0438\u0432\u0435\u0442 \u043C\u0438\u0440\n\u0645\u0631\u062D\u0628\u0627 \u0627\u0644\u0639\u0627\u0644\u0645";
        await shared.write(filePath, content);

        const result = await shared.read(filePath);

        expect(result).not.toContain("Error:");
        expect(result).toContain("\u{1F44B}");
        expect(result).toContain("\u4E16\u754C");
        expect(result).toContain("\u041F\u0440\u0438\u0432\u0435\u0442");
      },
      timeout,
    );

    it(
      "should handle files with very long lines",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("rd-long-lines.txt");
        const longLine = "x".repeat(3000);
        const content = `Short line\n${longLine}\nAnother short line`;
        await shared.write(filePath, content);

        const result = await shared.read(filePath);

        // Should still read successfully (implementation may truncate)
        expect(result).not.toContain("Error:");
        expect(result).toContain("Short line");
      },
      timeout,
    );

    it(
      "should return nothing with limit=0",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("rd-zero-limit.txt");
        await shared.write(filePath, "Line 1\nLine 2\nLine 3");

        const result = await shared.read(filePath, 0, 0);

        // Should return empty or no content lines
        expect(result).not.toContain("Line 1");
      },
      timeout,
    );

    it(
      "should handle offset beyond file length",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("rd-offset-beyond.txt");
        await shared.write(filePath, "Line 1\nLine 2\nLine 3");

        const result = await shared.read(filePath, 100, 10);

        expect(result).not.toContain("Line 1");
        expect(result).not.toContain("Line 2");
        expect(result).not.toContain("Line 3");
      },
      timeout,
    );

    it(
      "should handle offset exactly at file length",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("rd-offset-exact.txt");
        // 5 lines
        const content = Array.from(
          { length: 5 },
          (_, i) => `Line ${i + 1}`,
        ).join("\n");
        await shared.write(filePath, content);

        const result = await shared.read(filePath, 5, 10);

        // offset=5 means skip all 5 lines → nothing left
        expect(result).not.toContain("Line 1");
        expect(result).not.toContain("Line 5");
      },
      timeout,
    );

    it(
      "should read a large file in chunks",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("rd-chunked.txt");
        const content = Array.from(
          { length: 1000 },
          (_, i) => `Line_${String(i).padStart(4, "0")}_content`,
        ).join("\n");
        await shared.write(filePath, content);

        // Read first chunk
        const chunk1 = await shared.read(filePath, 0, 100);
        expect(chunk1).toContain("Line_0000_content");
        expect(chunk1).toContain("Line_0099_content");
        expect(chunk1).not.toContain("Line_0100_content");

        // Read middle chunk
        const chunk2 = await shared.read(filePath, 500, 100);
        expect(chunk2).toContain("Line_0500_content");
        expect(chunk2).toContain("Line_0599_content");
        expect(chunk2).not.toContain("Line_0499_content");

        // Read last chunk
        const chunk3 = await shared.read(filePath, 900, 100);
        expect(chunk3).toContain("Line_0900_content");
        expect(chunk3).toContain("Line_0999_content");
      },
      timeout,
    );
  });
}
