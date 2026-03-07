import type { SandboxInstance, StandardTestsConfig } from "../types.js";

/**
 * Register globInfo() tests (wildcard, recursive, no matches, directories,
 * extension filter, hidden files, character classes, question mark,
 * multiple extensions, deeply nested).
 */
export function registerGlobInfoTests<T extends SandboxInstance>(
  getShared: () => T,
  config: StandardTestsConfig<T>,
  timeout: number,
): void {
  const { describe, it, expect } = config.runner;

  describe("globInfo", () => {
    it(
      "should match basic wildcard pattern",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("gl-basic");
        await shared.write(`${baseDir}/file1.txt`, "content");
        await shared.write(`${baseDir}/file2.txt`, "content");
        await shared.write(`${baseDir}/file3.py`, "content");

        const result = await shared.globInfo("*.txt", baseDir);

        expect(result.length).toBe(2);
        const paths = result.map((info) => info.path);
        expect(paths).toContain("file1.txt");
        expect(paths).toContain("file2.txt");
        expect(paths.every((p) => !p.endsWith(".py"))).toBe(true);
      },
      timeout,
    );

    it(
      "should match recursive pattern (**)",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("gl-recursive");
        await shared.write(`${baseDir}/root.txt`, "content");
        await shared.write(`${baseDir}/subdir1/nested1.txt`, "content");
        await shared.write(`${baseDir}/subdir2/nested2.txt`, "content");

        const result = await shared.globInfo("**/*.txt", baseDir);

        expect(result.length).toBeGreaterThanOrEqual(2);
        const paths = result.map((info) => info.path);
        expect(paths.some((p) => p.includes("nested1.txt"))).toBe(true);
        expect(paths.some((p) => p.includes("nested2.txt"))).toBe(true);
      },
      timeout,
    );

    it(
      "should return empty array when no matches",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("gl-no-match");
        await shared.write(`${baseDir}/file.txt`, "content");

        const result = await shared.globInfo("*.py", baseDir);

        expect(result).toEqual([]);
      },
      timeout,
    );

    it(
      "should include directories in results",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("gl-dirs");
        await shared.execute(`mkdir -p '${baseDir}/dir1' '${baseDir}/dir2'`);
        await shared.write(`${baseDir}/file.txt`, "content");

        const result = await shared.globInfo("*", baseDir);

        expect(result.length).toBe(3);

        const dirCount = result.filter((info) => info.is_dir).length;
        const fileCount = result.filter((info) => !info.is_dir).length;
        expect(dirCount).toBe(2);
        expect(fileCount).toBe(1);
      },
      timeout,
    );

    it(
      "should match specific file extensions",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("gl-ext");
        await shared.write(`${baseDir}/test.py`, "content");
        await shared.write(`${baseDir}/test.txt`, "content");
        await shared.write(`${baseDir}/test.md`, "content");

        const result = await shared.globInfo("*.py", baseDir);

        expect(result.length).toBe(1);
        expect(result[0].path).toContain("test.py");
      },
      timeout,
    );

    it(
      "should match hidden files explicitly",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("gl-hidden");
        await shared.write(`${baseDir}/.hidden1`, "content");
        await shared.write(`${baseDir}/.hidden2`, "content");
        await shared.write(`${baseDir}/visible.txt`, "content");

        const result = await shared.globInfo(".*", baseDir);

        const paths = result.map((info) => info.path);
        expect(
          paths.some((p) => p.includes(".hidden1") || p.includes(".hidden2")),
        ).toBe(true);
        // Should not match visible.txt
        expect(paths.every((p) => !p.includes("visible"))).toBe(true);
      },
      timeout,
    );

    it(
      "should match character class patterns",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("gl-charclass");
        await shared.write(`${baseDir}/file1.txt`, "content");
        await shared.write(`${baseDir}/file2.txt`, "content");
        await shared.write(`${baseDir}/file3.txt`, "content");
        await shared.write(`${baseDir}/fileA.txt`, "content");

        const result = await shared.globInfo("file[1-2].txt", baseDir);

        expect(result.length).toBe(2);
        const paths = result.map((info) => info.path);
        expect(paths).toContain("file1.txt");
        expect(paths).toContain("file2.txt");
        expect(paths).not.toContain("file3.txt");
        expect(paths).not.toContain("fileA.txt");
      },
      timeout,
    );

    it(
      "should match single character wildcard (?)",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("gl-question");
        await shared.write(`${baseDir}/file1.txt`, "content");
        await shared.write(`${baseDir}/file2.txt`, "content");
        await shared.write(`${baseDir}/file10.txt`, "content");

        const result = await shared.globInfo("file?.txt", baseDir);

        // Should match file1.txt and file2.txt, but not file10.txt
        expect(result.length).toBe(2);
        const paths = result.map((info) => info.path);
        expect(paths).not.toContain("file10.txt");
      },
      timeout,
    );

    it(
      "should match multiple extensions separately",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("gl-multi-ext");
        await shared.write(`${baseDir}/file.txt`, "content");
        await shared.write(`${baseDir}/file.py`, "content");
        await shared.write(`${baseDir}/file.md`, "content");
        await shared.write(`${baseDir}/file.js`, "content");

        const resultTxt = await shared.globInfo("*.txt", baseDir);
        const resultPy = await shared.globInfo("*.py", baseDir);

        expect(resultTxt.length).toBe(1);
        expect(resultPy.length).toBe(1);
      },
      timeout,
    );

    it(
      "should match deeply nested patterns",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("gl-deep");
        await shared.write(`${baseDir}/a/b/c/d/deep.txt`, "content");
        await shared.write(`${baseDir}/a/b/other.txt`, "content");

        const result = await shared.globInfo("**/deep.txt", baseDir);

        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result.some((info) => info.path.includes("deep.txt"))).toBe(
          true,
        );
      },
      timeout,
    );
  });
}
