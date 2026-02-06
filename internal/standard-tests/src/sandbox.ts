/**
 * Standard integration test suite for sandbox providers.
 *
 * This module provides a reusable set of integration tests that verify
 * common sandbox behavior across all provider implementations. Each provider
 * calls `sandboxStandardTests()` with its own configuration to run these
 * tests against its sandbox implementation.
 *
 * **Design**: A single shared sandbox is created once (in `beforeAll`) and
 * reused across all command-execution and file-operation tests. Only
 * lifecycle tests that verify create/close behaviour and initialFiles tests
 * that require a fresh sandbox spin up a temporary instance — and they tear
 * it down immediately inside the test so the concurrent sandbox count never
 * exceeds 2.
 *
 * Tests cover:
 * - Sandbox lifecycle (create, isRunning, close, two-step initialization)
 * - Command execution (echo, exit codes, multiline output, stderr, env vars)
 * - File operations (upload, download, read, write, edit, multiple files)
 * - Initial files support (basic, nested, empty)
 * - Error handling (file not found, non-existent command)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal interface matching what BaseSandbox provides.
 * Uses duck typing so any sandbox implementation that matches will work.
 *
 * Return types are intentionally loose (`Promise<any>`) for `write` and
 * `edit` so that concrete implementations with richer return types (e.g.
 * `WriteResult`) are assignable without requiring index signatures.
 */
export interface SandboxInstance {
  readonly id: string;
  readonly isRunning: boolean;
  execute(
    command: string,
  ): Promise<{ output: string; exitCode: number | null; truncated?: boolean }>;
  uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<Array<{ path: string; error: string | null }>>;
  downloadFiles(
    paths: string[],
  ): Promise<
    Array<{ path: string; content: Uint8Array | null; error: string | null }>
  >;
  read(filePath: string, offset?: number, limit?: number): Promise<string>;
  write(filePath: string, content: string): Promise<any>;
  edit(filePath: string, oldString: string, newString: string): Promise<any>;
  initialize?(): Promise<void>;
}

/**
 * Configuration for the standard sandbox test suite.
 *
 * @typeParam T - The concrete sandbox type (e.g., ModalSandbox, DenoSandbox)
 */
export interface StandardTestsConfig<
  T extends SandboxInstance = SandboxInstance,
> {
  /**
   * Display name for the test suite (e.g., "ModalSandbox", "DenoSandbox").
   */
  name: string;

  /**
   * Skip all tests when true (e.g., when credentials are missing).
   */
  skip?: boolean;

  /**
   * Run tests sequentially to avoid concurrency limits.
   */
  sequential?: boolean;

  /**
   * Timeout for each test in milliseconds.
   * @default 120_000
   */
  timeout?: number;

  /**
   * Factory function to create a new sandbox instance.
   *
   * The test suite passes `initialFiles` with paths already resolved via
   * `resolvePath`. The implementation should pass them through to the
   * provider's create method.
   *
   * `initialFiles` values are always strings (not Uint8Array) in the
   * standard tests.
   */
  createSandbox: (options?: {
    initialFiles?: Record<string, string>;
  }) => Promise<T>;

  /**
   * Optional factory for creating an uninitialized sandbox for the
   * two-step initialization test. If omitted, the test is skipped.
   */
  createUninitializedSandbox?: () => T;

  /**
   * Close / cleanup a sandbox instance.
   */
  closeSandbox: (sandbox: T) => Promise<void>;

  /**
   * Convert a relative file path (e.g., `"test-file.txt"`) to the
   * provider-specific absolute or working-directory path
   * (e.g., `"/tmp/test-file.txt"` or just `"test-file.txt"`).
   */
  resolvePath: (relativePath: string) => string;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

/**
 * Run the standard sandbox integration tests against a provider.
 *
 * A single shared sandbox is created in `beforeAll` and reused for the
 * majority of tests (command execution, file operations). Tests that
 * inherently need their own sandbox (lifecycle close/init, initialFiles)
 * create a temporary one and destroy it immediately, so the concurrent
 * sandbox count never exceeds **2** (shared + 1 temporary).
 *
 * @example
 * ```ts
 * import { sandboxStandardTests } from "@langchain/standard-tests";
 * import { ModalSandbox } from "./sandbox.js";
 *
 * sandboxStandardTests({
 *   name: "ModalSandbox",
 *   skip: !process.env.MODAL_TOKEN_ID,
 *   timeout: 180_000,
 *   createSandbox: (opts) =>
 *     ModalSandbox.create({ imageName: "alpine:3.21", ...opts }),
 *   createUninitializedSandbox: () =>
 *     new ModalSandbox({ imageName: "alpine:3.21" }),
 *   closeSandbox: (sb) => sb.close(),
 *   resolvePath: (name) => `/tmp/${name}`,
 * });
 * ```
 */
export function sandboxStandardTests<T extends SandboxInstance>(
  config: StandardTestsConfig<T>,
): void {
  const timeout = config.timeout ?? 120_000;

  // Choose the right describe variant based on config
  const outerDescribe = config.skip
    ? describe.skip
    : config.sequential
      ? describe.sequential
      : describe;

  outerDescribe(`${config.name} Standard Tests`, () => {
    // The single shared sandbox reused across most tests
    let shared: T;

    beforeAll(async () => {
      shared = await config.createSandbox();
    }, timeout);

    afterAll(async () => {
      try {
        await config.closeSandbox(shared);
      } catch {
        // Ignore cleanup errors
      }
    }, timeout);

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    describe("sandbox lifecycle", () => {
      it(
        "should create sandbox and have a valid id",
        () => {
          expect(shared).toBeDefined();
          expect(shared.id).toBeDefined();
          expect(typeof shared.id).toBe("string");
          expect(shared.id.length).toBeGreaterThan(0);
        },
        timeout,
      );

      it(
        "should have isRunning as true after creation",
        () => {
          expect(shared.isRunning).toBe(true);
        },
        timeout,
      );

      describe("close", () => {
        let tmp: T;

        beforeAll(async () => {
          tmp = await config.createSandbox();
        }, timeout);

        afterAll(async () => {
          try {
            await config.closeSandbox(tmp);
          } catch {
            // Ignore cleanup errors
          }
        }, timeout);

        it(
          "should close sandbox successfully",
          async () => {
            expect(tmp.isRunning).toBe(true);

            await config.closeSandbox(tmp);

            expect(tmp.isRunning).toBe(false);
          },
          timeout,
        );
      });

      describe("two-step initialization", () => {
        let tmp: T;

        afterAll(async () => {
          try {
            if (tmp) await config.closeSandbox(tmp);
          } catch {
            // Ignore cleanup errors
          }
        }, timeout);

        it.skipIf(!config.createUninitializedSandbox)(
          "should work with two-step initialization",
          async () => {
            tmp = config.createUninitializedSandbox!();

            expect(tmp.isRunning).toBe(false);

            await tmp.initialize!();

            expect(tmp.isRunning).toBe(true);
            expect(tmp.id).toBeDefined();
          },
          timeout,
        );
      });
    });

    // -----------------------------------------------------------------------
    // Command execution  (all use the shared sandbox)
    // -----------------------------------------------------------------------

    describe("command execution", () => {
      it(
        "should run a simple echo command",
        async () => {
          const result = await shared.execute('echo "hello"');

          expect(result.exitCode).toBe(0);
          expect(result.output.trim()).toBe("hello");
          expect(result.truncated).toBe(false);
        },
        timeout,
      );

      it(
        "should capture non-zero exit code",
        async () => {
          const result = await shared.execute("exit 42");

          expect(result.exitCode).toBe(42);
        },
        timeout,
      );

      it(
        "should capture multiline output",
        async () => {
          const result = await shared.execute(
            'echo "line1" && echo "line2" && echo "line3"',
          );

          expect(result.exitCode).toBe(0);
          expect(result.output).toContain("line1");
          expect(result.output).toContain("line2");
          expect(result.output).toContain("line3");
        },
        timeout,
      );

      it(
        "should capture stderr output",
        async () => {
          const result = await shared.execute('echo "error message" >&2');

          // stderr should be included in output
          expect(result.output).toContain("error message");
        },
        timeout,
      );

      it(
        "should handle command with environment variables",
        async () => {
          const result = await shared.execute(
            'export MY_VAR="test_value" && echo $MY_VAR',
          );

          expect(result.exitCode).toBe(0);
          expect(result.output.trim()).toBe("test_value");
        },
        timeout,
      );

      it(
        "should handle non-existent command",
        async () => {
          const result = await shared.execute("nonexistent_command_12345");

          expect(result.exitCode).not.toBe(0);
        },
        timeout,
      );
    });

    describe("file operations", () => {
      it(
        "should upload files to sandbox",
        async () => {
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

          const results = await shared.downloadFiles([filePath]);

          expect(results.length).toBe(1);
          expect(results[0].content).toBeNull();
          expect(results[0].error).toBe("file_not_found");
        },
        timeout,
      );

      it(
        "should use inherited read method from BaseSandbox",
        async () => {
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

    describe("initialFiles", () => {
      it(
        "should create sandbox with initial files",
        async () => {
          const initPath = config.resolvePath("init-test.txt");
          const nestedPath = config.resolvePath("nested/dir/file.txt");

          const tmp = await config.createSandbox({
            initialFiles: {
              [initPath]: "Hello from initial file!",
              [nestedPath]: "Nested content",
            },
          });

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

          const tmp = await config.createSandbox({
            initialFiles: {
              [buttonPath]:
                "export const Button = () => <button>Click</button>;",
              [helperPath]:
                "export const capitalize = (s: string) => s.toUpperCase();",
            },
          });

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
          const tmp = await config.createSandbox({ initialFiles: {} });

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
  });
}
