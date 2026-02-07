import { describe, it, expect } from "vitest";

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
          await config.closeSandbox(tmp);
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
          await config.closeSandbox(tmp);
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
          await config.closeSandbox(tmp);
        }
      },
      timeout,
    );
  });
}
