import { describe, it, expect } from "vitest";
import type { SandboxInstance, StandardTestsConfig } from "../types.js";

/**
 * Register integration workflow tests that combine multiple operations.
 */
export function registerIntegrationTests<T extends SandboxInstance>(
  getShared: () => T,
  config: StandardTestsConfig<T>,
  timeout: number,
): void {
  describe("integration workflows", () => {
    it(
      "should complete a write-read-edit-read workflow",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("intg-workflow.txt");

        // Write initial content
        const writeResult = await shared.write(filePath, "Original content");
        expect(writeResult.error).toBeUndefined();

        // Read it back
        const content = await shared.read(filePath);
        expect(content).toContain("Original content");

        // Edit it
        const editResult = await shared.edit(filePath, "Original", "Modified");
        expect(editResult.error).toBeUndefined();

        // Read again to verify
        const updatedContent = await shared.read(filePath);
        expect(updatedContent).toContain("Modified content");
        expect(updatedContent).not.toContain("Original");
      },
      timeout,
    );

    it(
      "should handle complex directory operations",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("intg-complex");

        // Create directory structure with files
        await shared.write(`${baseDir}/root.txt`, "root file");
        await shared.write(`${baseDir}/subdir1/file1.txt`, "file 1");
        await shared.write(`${baseDir}/subdir1/file2.py`, "file 2");
        await shared.write(`${baseDir}/subdir2/file3.txt`, "file 3");

        // List root directory
        const lsResult = await shared.lsInfo(baseDir);
        const lsPaths = lsResult.map((info) => info.path.replace(/\/$/, ""));
        expect(lsPaths).toContain(`${baseDir}/root.txt`);
        expect(lsPaths).toContain(`${baseDir}/subdir1`);
        expect(lsPaths).toContain(`${baseDir}/subdir2`);

        // Glob for txt files
        const globResult = await shared.globInfo("**/*.txt", baseDir);
        expect(globResult.length).toBe(3);

        // Grep for a pattern
        const grepResult = await shared.grepRaw("file", baseDir);
        expect(Array.isArray(grepResult)).toBe(true);
        expect(
          (
            grepResult as Array<{
              path: string;
              line: number;
              text: string;
            }>
          ).length,
        ).toBeGreaterThanOrEqual(3);
      },
      timeout,
    );
  });
}
