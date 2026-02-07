import { describe, it, expect } from "vitest";
import type { SandboxInstance, StandardTestsConfig } from "../sandbox.js";

/**
 * Register lsInfo() tests (absolute paths, files + subdirs, empty dir,
 * nonexistent dir, hidden files, spaces, unicode, large dir, trailing slash,
 * special characters).
 */
export function registerLsInfoTests<T extends SandboxInstance>(
  getShared: () => T,
  config: StandardTestsConfig<T>,
  timeout: number,
): void {
  describe("lsInfo", () => {
    it(
      "should return absolute paths",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("li-absolute");
        await shared.write(`${baseDir}/file.txt`, "content");

        const result = await shared.lsInfo(baseDir);

        expect(result.length).toBe(1);
        expect(result[0].path).toBe(`${baseDir}/file.txt`);
      },
      timeout,
    );

    it(
      "should list files and subdirectories",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("li-basic");
        await shared.write(`${baseDir}/file1.txt`, "content1");
        await shared.write(`${baseDir}/file2.txt`, "content2");
        await shared.execute(`mkdir -p '${baseDir}/subdir'`);

        const result = await shared.lsInfo(baseDir);

        expect(result.length).toBe(3);
        const paths = result.map((info) => info.path.replace(/\/$/, ""));
        expect(paths).toContain(`${baseDir}/file1.txt`);
        expect(paths).toContain(`${baseDir}/file2.txt`);
        expect(paths).toContain(`${baseDir}/subdir`);

        // Check is_dir flag
        for (const info of result) {
          if (info.path.replace(/\/$/, "").endsWith("/subdir")) {
            expect(info.is_dir).toBe(true);
          } else {
            expect(info.is_dir).toBe(false);
          }
        }
      },
      timeout,
    );

    it(
      "should return empty list for empty directory",
      async () => {
        const shared = getShared();
        const emptyDir = config.resolvePath("li-empty-dir");
        await shared.execute(`mkdir -p '${emptyDir}'`);

        const result = await shared.lsInfo(emptyDir);

        expect(result).toEqual([]);
      },
      timeout,
    );

    it(
      "should return empty list for nonexistent directory",
      async () => {
        const nonexistentDir = config.resolvePath(
          "li-does-not-exist-12345",
        );

        const result = await getShared().lsInfo(nonexistentDir);

        expect(result).toEqual([]);
      },
      timeout,
    );

    it(
      "should include hidden files",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("li-hidden");
        await shared.write(`${baseDir}/.hidden`, "hidden content");
        await shared.write(`${baseDir}/visible.txt`, "visible content");

        const result = await shared.lsInfo(baseDir);

        const paths = result.map((info) => info.path);
        expect(paths).toContain(`${baseDir}/.hidden`);
        expect(paths).toContain(`${baseDir}/visible.txt`);
      },
      timeout,
    );

    it(
      "should handle directories with spaces in names",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("li-spaces");
        await shared.write(
          `${baseDir}/file with spaces.txt`,
          "content",
        );
        await shared.execute(`mkdir -p '${baseDir}/dir with spaces'`);

        const result = await shared.lsInfo(baseDir);

        const paths = result.map((info) => info.path.replace(/\/$/, ""));
        expect(paths).toContain(`${baseDir}/file with spaces.txt`);
        expect(paths).toContain(`${baseDir}/dir with spaces`);
      },
      timeout,
    );

    it(
      "should handle unicode filenames",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("li-unicode");
        await shared.write(
          `${baseDir}/\u6D4B\u8BD5\u6587\u4EF6.txt`,
          "content",
        );
        await shared.write(
          `${baseDir}/\u0444\u0430\u0439\u043B.txt`,
          "content",
        );

        const result = await shared.lsInfo(baseDir);

        expect(result.length).toBe(2);
      },
      timeout,
    );

    it(
      "should handle large directories",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("li-large");
        // Create 50 files in a single command for speed
        await shared.execute(
          `mkdir -p '${baseDir}' && cd '${baseDir}' && ` +
            "for i in $(seq 0 49); do " +
            "echo 'content' > file_$(printf '%03d' $i).txt; done",
        );

        const result = await shared.lsInfo(baseDir);

        expect(result.length).toBe(50);
        const paths = result.map((info) => info.path);
        expect(paths).toContain(`${baseDir}/file_000.txt`);
        expect(paths).toContain(`${baseDir}/file_049.txt`);
      },
      timeout,
    );

    it(
      "should handle trailing slash in path",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("li-trailing");
        await shared.write(`${baseDir}/file.txt`, "content");

        // List with trailing slash
        const result = await shared.lsInfo(`${baseDir}/`);

        // Should work the same as without trailing slash
        expect(result.length).toBeGreaterThanOrEqual(1);
      },
      timeout,
    );

    it(
      "should handle special characters in filenames",
      async () => {
        const shared = getShared();
        const baseDir = config.resolvePath("li-special-chars");
        await shared.write(`${baseDir}/file(1).txt`, "content");
        await shared.write(`${baseDir}/file-3.txt`, "content");

        const result = await shared.lsInfo(baseDir);

        const paths = result.map((info) => info.path);
        expect(paths).toContain(`${baseDir}/file(1).txt`);
        expect(paths).toContain(`${baseDir}/file-3.txt`);
      },
      timeout,
    );
  });
}
