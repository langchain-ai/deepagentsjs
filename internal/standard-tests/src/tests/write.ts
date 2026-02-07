import { describe, it, expect } from "vitest";
import type { SandboxInstance, StandardTestsConfig } from "../sandbox.js";

/**
 * Register detailed write() tests (new file, parent dirs, existing file,
 * special chars, empty, spaces, unicode, slashes, long content, newlines).
 */
export function registerWriteTests<T extends SandboxInstance>(
  getShared: () => T,
  config: StandardTestsConfig<T>,
  timeout: number,
): void {
  describe("write", () => {
    it(
      "should write a new file with basic content",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("wt-new.txt");
        const content = "Hello, sandbox!\nLine 2\nLine 3";

        const result = await shared.write(filePath, content);

        expect(result.error).toBeUndefined();
        expect(result.path).toBe(filePath);

        // Verify file was created
        const execResult = await shared.execute(`cat ${filePath}`);
        expect(execResult.output.trim()).toBe(content);
      },
      timeout,
    );

    it(
      "should create parent directories automatically",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath(
          "wt-parents/deep/nested/dir/file.txt",
        );
        const content = "Nested file content";

        const result = await shared.write(filePath, content);

        expect(result.error).toBeUndefined();

        const execResult = await shared.execute(`cat ${filePath}`);
        expect(execResult.output.trim()).toBe(content);
      },
      timeout,
    );

    it(
      "should fail when writing to an existing file",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("wt-existing.txt");

        // Create file first
        await shared.write(filePath, "First content");

        // Try to write again
        const result = await shared.write(filePath, "Second content");

        expect(result.error).toBeDefined();
        expect(result.error!.toLowerCase()).toContain("already exists");

        // Verify original content unchanged
        const execResult = await shared.execute(`cat ${filePath}`);
        expect(execResult.output.trim()).toBe("First content");
      },
      timeout,
    );

    it(
      "should handle special characters and escape sequences",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("wt-special.txt");
        const content =
          "Special chars: $VAR, `command`, $(subshell)\nTab\there\nBackslash: \\";

        const result = await shared.write(filePath, content);

        expect(result.error).toBeUndefined();

        // Verify content is preserved exactly
        const execResult = await shared.execute(`cat ${filePath}`);
        expect(execResult.output.trim()).toBe(content);
      },
      timeout,
    );

    it(
      "should write an empty file",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("wt-empty.txt");

        const result = await shared.write(filePath, "");

        expect(result.error).toBeUndefined();

        // Verify file exists
        const execResult = await shared.execute(
          `[ -f ${filePath} ] && echo 'exists' || echo 'missing'`,
        );
        expect(execResult.output).toContain("exists");
      },
      timeout,
    );

    it(
      "should write a file with spaces in the path",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath(
          "wt-spaces/dir with spaces/file name.txt",
        );
        const content = "Content in file with spaces";

        const result = await shared.write(filePath, content);

        expect(result.error).toBeUndefined();

        // Verify file was created (quote path for shell)
        const execResult = await shared.execute(`cat '${filePath}'`);
        expect(execResult.output.trim()).toBe(content);
      },
      timeout,
    );

    it(
      "should write unicode content",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("wt-unicode.txt");
        const content =
          "Hello \u{1F44B} \u4E16\u754C \u0645\u0631\u062D\u0628\u0627 \u041F\u0440\u0438\u0432\u0435\u0442 \u{1F30D}\nLine with \u00E9mojis \u{1F389}";

        const result = await shared.write(filePath, content);

        expect(result.error).toBeUndefined();

        const execResult = await shared.execute(`cat ${filePath}`);
        expect(execResult.output.trim()).toBe(content);
      },
      timeout,
    );

    it(
      "should handle consecutive slashes in path",
      async () => {
        const shared = getShared();
        const basePath = config.resolvePath("wt-slashes");
        // Use double slashes — the filesystem should normalize them
        const filePath = `${basePath}//subdir///file.txt`;
        const content = "Content";

        const result = await shared.write(filePath, content);

        expect(result.error).toBeUndefined();

        // Verify file exists via normalized path
        const execResult = await shared.execute(
          `cat ${basePath}/subdir/file.txt`,
        );
        expect(execResult.output.trim()).toBe(content);
      },
      timeout,
    );

    it(
      "should write very long content (1000 lines)",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("wt-long.txt");
        const lines = Array.from(
          { length: 1000 },
          (_, i) => `Line ${i} with some content here`,
        );
        const content = lines.join("\n");

        const result = await shared.write(filePath, content);

        expect(result.error).toBeUndefined();

        // Verify file has correct number of lines
        const execResult = await shared.execute(`wc -l < ${filePath}`);
        // wc -l counts newlines: 1000 lines joined by \n = 999 newlines
        expect(execResult.output.trim()).toMatch(/^(999|1000)$/);
      },
      timeout,
    );

    it(
      "should write content with only newlines",
      async () => {
        const shared = getShared();
        const filePath = config.resolvePath("wt-newlines.txt");
        const content = "\n\n\n\n\n";

        const result = await shared.write(filePath, content);

        expect(result.error).toBeUndefined();

        const execResult = await shared.execute(`wc -l < ${filePath}`);
        expect(execResult.output.trim()).toBe("5");
      },
      timeout,
    );
  });
}
