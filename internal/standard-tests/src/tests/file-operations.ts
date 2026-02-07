import { describe, it, expect } from "vitest";

import type { SandboxInstance, StandardTestsConfig } from "../types.js";

/**
 * Register basic file operation tests (upload, download, read, write, edit, multiple files).
 */
export function registerFileOperationTests<T extends SandboxInstance>(
  getShared: () => T,
  config: StandardTestsConfig<T>,
  timeout: number,
): void {
  describe("file operations", () => {
    it(
      "should upload files to sandbox",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("test-upload.txt");

        const content = new TextEncoder().encode("Hello from test file!");
        const results = await shared.uploadFiles([[filePath, content]]);

        expect(results.length).toBe(1);
        expect(results[0].path).toBe(filePath);
        expect(results[0].error).toBeNull();

        // Verify file exists using execute
        const checkResult = await shared.execute(`cat ${filePath}`);
        expect(checkResult.output.trim()).toBe("Hello from test file!");
      },
      timeout,
    );

    it(
      "should download files from sandbox",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("test-download.txt");

        // First create a file
        const encoder = new TextEncoder();
        await shared.uploadFiles([
          [filePath, encoder.encode("Download test content")],
        ]);

        // Now download it
        const results = await shared.downloadFiles([filePath]);

        expect(results.length).toBe(1);
        expect(results[0].error).toBeNull();
        expect(results[0].content).not.toBeNull();

        const content = new TextDecoder().decode(results[0].content!);
        expect(content.trim()).toBe("Download test content");
      },
      timeout,
    );

    it(
      "should handle file not found on download",
      async () => {
        const filePath = config.resolvePath("nonexistent-file-12345.txt");

        const results = await getShared().downloadFiles([filePath]);

        expect(results.length).toBe(1);
        expect(results[0].content).toBeNull();
        expect(results[0].error).toBe("file_not_found");
      },
      timeout,
    );

    it(
      "should use inherited read method from BaseSandbox",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("read-test.txt");

        // Create a file first
        const encoder = new TextEncoder();
        await shared.uploadFiles([
          [filePath, encoder.encode("Read test content")],
        ]);

        // Use inherited read method
        const content = await shared.read(filePath);

        expect(content).toContain("Read test content");
      },
      timeout,
    );

    it(
      "should use inherited write method from BaseSandbox",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("write-test.txt");

        // Use inherited write method
        await shared.write(filePath, "Written via BaseSandbox");

        // Verify using execute
        const result = await shared.execute(`cat ${filePath}`);
        expect(result.output.trim()).toBe("Written via BaseSandbox");
      },
      timeout,
    );

    it(
      "should use inherited edit method from BaseSandbox",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("edit-test.txt");

        // Create initial file
        await shared.write(filePath, "Hello World");

        // Use inherited edit method
        await shared.edit(filePath, "Hello World", "Hello Edited World");

        // Verify the edit
        const result = await shared.execute(`cat ${filePath}`);
        expect(result.output.trim()).toBe("Hello Edited World");
      },
      timeout,
    );

    it(
      "should upload multiple files at once",
      async () => {
        const shared = getShared();
        const path1 = config.resolvePath("multi1.txt");
        const path2 = config.resolvePath("multi2.txt");
        const path3 = config.resolvePath("multi3.txt");

        const encoder = new TextEncoder();
        const results = await shared.uploadFiles([
          [path1, encoder.encode("Content 1")],
          [path2, encoder.encode("Content 2")],
          [path3, encoder.encode("Content 3")],
        ]);

        expect(results.length).toBe(3);
        expect(results.every((r) => r.error === null)).toBe(true);

        // Verify all files exist
        const checkResult = await shared.execute(
          `cat ${path1} ${path2} ${path3}`,
        );
        expect(checkResult.output).toContain("Content 1");
        expect(checkResult.output).toContain("Content 2");
        expect(checkResult.output).toContain("Content 3");
      },
      timeout,
    );
  });
}
