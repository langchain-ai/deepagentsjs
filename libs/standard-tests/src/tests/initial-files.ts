import { withRetry } from "../sandbox.js";
import type { SandboxInstance, StandardTestsConfig } from "../types.js";

/**
 * Register initialFiles tests (basic, deeply nested, empty).
 *
 * These tests create temporary sandboxes and tear them down immediately.
 */
export function registerInitialFilesTests<T extends SandboxInstance>(
  config: StandardTestsConfig<T>,
  timeout: number,
): void {
  const { describe, it, expect } = config.runner;

  describe("initialFiles", () => {
    it(
      "should create sandbox with initial files",
      async () => {
        const initPath = config.resolvePath("init-test.txt");
        const nestedPath = config.resolvePath("nested/dir/file.txt");

        const tmp = await withRetry(() =>
          config.createSandbox({
            initialFiles: {
              [initPath]: "Hello from initial file!",
              [nestedPath]: "Nested content",
            },
          }),
        );

        try {
          expect(tmp.isRunning).toBe(true);

          // Verify files exist using cat
          const result1 = await tmp.execute(`cat ${initPath}`);
          expect(result1.exitCode).toBe(0);
          expect(result1.output.trim()).toBe("Hello from initial file!");

          const result2 = await tmp.execute(`cat ${nestedPath}`);
          expect(result2.exitCode).toBe(0);
          expect(result2.output.trim()).toBe("Nested content");
        } finally {
          await config.closeSandbox?.(tmp);
        }
      },
      timeout,
    );

    it(
      "should create sandbox with deeply nested initial files",
      async () => {
        const buttonPath = config.resolvePath(
          "src/components/Button/index.tsx",
        );
        const helperPath = config.resolvePath("src/utils/helpers/string.ts");

        const tmp = await withRetry(() =>
          config.createSandbox({
            initialFiles: {
              [buttonPath]:
                "export const Button = () => <button>Click</button>;",
              [helperPath]:
                "export const capitalize = (s: string) => s.toUpperCase();",
            },
          }),
        );

        try {
          expect(tmp.isRunning).toBe(true);

          // Verify file contents
          const buttonContent = await tmp.execute(`cat ${buttonPath}`);
          expect(buttonContent.output).toContain("Button");

          const helperContent = await tmp.execute(`cat ${helperPath}`);
          expect(helperContent.output).toContain("capitalize");
        } finally {
          await config.closeSandbox?.(tmp);
        }
      },
      timeout,
    );

    it(
      "should create sandbox with empty initialFiles object",
      async () => {
        const tmp = await withRetry(() =>
          config.createSandbox({ initialFiles: {} }),
        );

        try {
          expect(tmp.isRunning).toBe(true);

          // Sandbox should work normally
          const result = await tmp.execute('echo "Works!"');
          expect(result.exitCode).toBe(0);
          expect(result.output).toContain("Works!");
        } finally {
          await config.closeSandbox?.(tmp);
        }
      },
      timeout,
    );

    it(
      "should make initialFiles accessible via read()",
      async () => {
        const filePath = config.resolvePath("init-read-test.txt");
        const tmp = await withRetry(() =>
          config.createSandbox({
            initialFiles: {
              [filePath]: "Content for read test",
            },
          }),
        );

        try {
          const content = await tmp.read(filePath);
          expect(content).toContain("Content for read test");
        } finally {
          await config.closeSandbox?.(tmp);
        }
      },
      timeout,
    );

    it(
      "should make initialFiles accessible via downloadFiles()",
      async () => {
        const filePath = config.resolvePath("init-download-test.txt");
        const tmp = await withRetry(() =>
          config.createSandbox({
            initialFiles: {
              [filePath]: "Content for download test",
            },
          }),
        );

        try {
          const results = await tmp.downloadFiles([filePath]);
          expect(results[0].error).toBeNull();
          expect(results[0].content).not.toBeNull();
          const content = new TextDecoder().decode(results[0].content!);
          expect(content).toContain("Content for download test");
        } finally {
          await config.closeSandbox?.(tmp);
        }
      },
      timeout,
    );

    it(
      "should execute a script created via initialFiles",
      async () => {
        const scriptPath = config.resolvePath("init-script.sh");
        const tmp = await withRetry(() =>
          config.createSandbox({
            initialFiles: {
              [scriptPath]: '#!/bin/sh\necho "Hello from initialFiles script"',
            },
          }),
        );

        try {
          const result = await tmp.execute(`sh ${scriptPath}`);
          expect(result.exitCode).toBe(0);
          expect(result.output.trim()).toBe("Hello from initialFiles script");
        } finally {
          await config.closeSandbox?.(tmp);
        }
      },
      timeout,
    );

    it(
      "should make initialFiles in subdirectories visible via lsInfo()",
      async () => {
        const dirPath = config.resolvePath("init-ls-dir");
        const filePath = `${dirPath}/file.txt`;
        const tmp = await withRetry(() =>
          config.createSandbox({
            initialFiles: {
              [filePath]: "ls test content",
            },
          }),
        );

        try {
          const entries = await tmp.lsInfo(dirPath);
          const paths = entries.map((e) => e.path.replace(/\/$/, ""));
          expect(paths).toContain(filePath);
        } finally {
          await config.closeSandbox?.(tmp);
        }
      },
      timeout,
    );
  });
}
