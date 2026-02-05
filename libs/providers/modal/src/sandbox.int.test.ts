/**
 * Integration tests for ModalSandbox class.
 *
 * These tests require valid Modal credentials to run. They create real
 * sandbox instances and will be skipped if MODAL_TOKEN_ID and MODAL_TOKEN_SECRET
 * are not set.
 *
 * To run these tests:
 * 1. Set up Modal authentication:
 *    - Go to https://modal.com/settings/tokens
 *    - Create a token and export:
 *      export MODAL_TOKEN_ID=your_token_id
 *      export MODAL_TOKEN_SECRET=your_token_secret
 * 2. Run tests: `pnpm test:int` or `pnpm vitest run sandbox.int.test.ts`
 *
 * Note: These tests may incur Modal usage costs and take longer to run.
 */

import { describe, it, expect, afterAll } from "vitest";
import { ModalSandbox } from "./sandbox.js";

// Check if integration tests should run
const MODAL_TOKEN_ID = process.env.MODAL_TOKEN_ID;
const MODAL_TOKEN_SECRET = process.env.MODAL_TOKEN_SECRET;
const hasCredentials = MODAL_TOKEN_ID && MODAL_TOKEN_SECRET;

/**
 * Track sandboxes for cleanup
 */
const sandboxesToCleanup: ModalSandbox[] = [];

/**
 * Cleanup all sandboxes after tests complete
 */
afterAll(async () => {
  for (const sandbox of sandboxesToCleanup) {
    try {
      await sandbox.close();
    } catch {
      // Ignore cleanup errors
    }
  }
});

// Skip all tests if no Modal credentials are available
describe.skipIf(!hasCredentials)("ModalSandbox Integration Tests", () => {
  // Increase timeout for integration tests (sandbox creation can take 10-60 seconds)
  const TEST_TIMEOUT = 180_000; // 3 minutes

  describe("sandbox lifecycle", () => {
    it(
      "should create sandbox via ModalSandbox.create()",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
          timeoutMs: 300_000,
        });

        sandboxesToCleanup.push(sandbox);

        expect(sandbox).toBeInstanceOf(ModalSandbox);
        expect(sandbox.id).toBeDefined();
        expect(sandbox.id).not.toMatch(/^modal-sandbox-\d+$/); // Should have real ID
      },
      TEST_TIMEOUT,
    );

    it(
      "should have isRunning as true after creation",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        expect(sandbox.isRunning).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      "should close sandbox successfully",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        // Don't add to cleanup - we're testing close() explicitly
        expect(sandbox.isRunning).toBe(true);

        await sandbox.close();

        expect(sandbox.isRunning).toBe(false);
      },
      TEST_TIMEOUT,
    );

    it(
      "should work with two-step initialization",
      async () => {
        const sandbox = new ModalSandbox({
          imageName: "alpine:3.21",
        });

        expect(sandbox.isRunning).toBe(false);

        await sandbox.initialize();

        sandboxesToCleanup.push(sandbox);

        expect(sandbox.isRunning).toBe(true);
        expect(sandbox.id).not.toMatch(/^modal-sandbox-\d+$/);
      },
      TEST_TIMEOUT,
    );
  });

  describe("initialFiles", () => {
    it(
      "should populate initial files during creation",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
          initialFiles: {
            "/tmp/init-test.txt": "Hello from initial file!",
            "/tmp/nested/dir/file.txt": "Nested content",
          },
        });

        sandboxesToCleanup.push(sandbox);

        // Verify files exist using cat
        const result1 = await sandbox.execute("cat /tmp/init-test.txt");
        expect(result1.exitCode).toBe(0);
        expect(result1.output.trim()).toBe("Hello from initial file!");

        const result2 = await sandbox.execute("cat /tmp/nested/dir/file.txt");
        expect(result2.exitCode).toBe(0);
        expect(result2.output.trim()).toBe("Nested content");
      },
      TEST_TIMEOUT,
    );

    it(
      "should populate initial files with Uint8Array content",
      async () => {
        const encoder = new TextEncoder();
        const content = encoder.encode("Binary content test");

        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
          initialFiles: {
            "/tmp/binary-init.txt": content,
          },
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute("cat /tmp/binary-init.txt");
        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe("Binary content test");
      },
      TEST_TIMEOUT,
    );

    it(
      "should allow downloading initial files after creation",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
          initialFiles: {
            "/tmp/download-init.txt": "Content to download",
          },
        });

        sandboxesToCleanup.push(sandbox);

        // Download the file we initialized with
        const results = await sandbox.downloadFiles(["/tmp/download-init.txt"]);

        expect(results.length).toBe(1);
        expect(results[0].error).toBeNull();
        expect(results[0].content).not.toBeNull();

        const content = new TextDecoder().decode(results[0].content!);
        expect(content).toBe("Content to download");
      },
      TEST_TIMEOUT,
    );

    it(
      "should work with Python image and initial Python files",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "python:3.12-slim",
          initialFiles: {
            "/app/hello.py": 'print("Hello from Python!")',
          },
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute("python /app/hello.py");
        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe("Hello from Python!");
      },
      TEST_TIMEOUT,
    );

    it(
      "should work with Node.js image and initial JS files",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "node:20-slim",
          initialFiles: {
            "/app/hello.js": 'console.log("Hello from Node.js!");',
          },
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute("node /app/hello.js");
        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe("Hello from Node.js!");
      },
      TEST_TIMEOUT,
    );

    it(
      "should handle JSON configuration files",
      async () => {
        const configContent = JSON.stringify(
          { name: "test-app", version: "1.0.0" },
          null,
          2,
        );

        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
          initialFiles: {
            "/app/config.json": configContent,
          },
        });

        sandboxesToCleanup.push(sandbox);

        // Read the JSON file and verify it's valid
        const result = await sandbox.execute("cat /app/config.json");
        expect(result.exitCode).toBe(0);

        const parsed = JSON.parse(result.output);
        expect(parsed.name).toBe("test-app");
        expect(parsed.version).toBe("1.0.0");
      },
      TEST_TIMEOUT,
    );
  });

  describe("command execution", () => {
    it(
      "should run simple echo command",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute('echo "hello"');

        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe("hello");
        expect(result.truncated).toBe(false);
      },
      TEST_TIMEOUT,
    );

    it(
      "should capture non-zero exit code",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute("exit 42");

        expect(result.exitCode).toBe(42);
      },
      TEST_TIMEOUT,
    );

    it(
      "should capture command output correctly",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        // Test multiline output
        const result = await sandbox.execute(
          'echo "line1" && echo "line2" && echo "line3"',
        );

        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("line1");
        expect(result.output).toContain("line2");
        expect(result.output).toContain("line3");
      },
      TEST_TIMEOUT,
    );

    it(
      "should capture stderr output",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute('echo "error message" >&2');

        // stderr should be included in output
        expect(result.output).toContain("error message");
      },
      TEST_TIMEOUT,
    );

    it(
      "should handle command with environment variables",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute(
          'export MY_VAR="test_value" && echo $MY_VAR',
        );

        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe("test_value");
      },
      TEST_TIMEOUT,
    );
  });

  describe("file operations", () => {
    it(
      "should upload files to sandbox",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        const content = new TextEncoder().encode("Hello from test file!");
        const results = await sandbox.uploadFiles([
          ["/tmp/test-upload.txt", content],
        ]);

        expect(results.length).toBe(1);
        expect(results[0].path).toBe("/tmp/test-upload.txt");
        expect(results[0].error).toBeNull();

        // Verify file exists using execute
        const checkResult = await sandbox.execute("cat /tmp/test-upload.txt");
        expect(checkResult.output.trim()).toBe("Hello from test file!");
      },
      TEST_TIMEOUT,
    );

    it(
      "should download files from sandbox",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        // First create a file using execute
        await sandbox.execute(
          'echo "Download test content" > /tmp/test-download.txt',
        );

        // Now download it
        const results = await sandbox.downloadFiles(["/tmp/test-download.txt"]);

        expect(results.length).toBe(1);
        expect(results[0].path).toBe("/tmp/test-download.txt");
        expect(results[0].error).toBeNull();
        expect(results[0].content).not.toBeNull();

        const content = new TextDecoder().decode(results[0].content!);
        expect(content.trim()).toBe("Download test content");
      },
      TEST_TIMEOUT,
    );

    it(
      "should handle file not found on download",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        const results = await sandbox.downloadFiles([
          "/tmp/nonexistent-file-12345.txt",
        ]);

        expect(results.length).toBe(1);
        expect(results[0].content).toBeNull();
        expect(results[0].error).toBe("file_not_found");
      },
      TEST_TIMEOUT,
    );

    it(
      "should use inherited read method from BaseSandbox",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        // Create a file first
        await sandbox.execute('echo "Read test content" > /tmp/read-test.txt');

        // Use inherited read method
        const content = await sandbox.read("/tmp/read-test.txt");

        expect(content).toContain("Read test content");
      },
      TEST_TIMEOUT,
    );

    it(
      "should use inherited write method from BaseSandbox",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        // Use inherited write method
        await sandbox.write("/tmp/write-test.txt", "Written via BaseSandbox");

        // Verify using execute
        const result = await sandbox.execute("cat /tmp/write-test.txt");
        expect(result.output.trim()).toBe("Written via BaseSandbox");
      },
      TEST_TIMEOUT,
    );

    it(
      "should use inherited edit method from BaseSandbox",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        // Create initial file
        await sandbox.write("/tmp/edit-test.txt", "Hello World");

        // Use inherited edit method
        await sandbox.edit(
          "/tmp/edit-test.txt",
          "Hello World",
          "Hello Edited World",
        );

        // Verify the edit
        const result = await sandbox.execute("cat /tmp/edit-test.txt");
        expect(result.output.trim()).toBe("Hello Edited World");
      },
      TEST_TIMEOUT,
    );

    it(
      "should upload multiple files at once",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
        });

        sandboxesToCleanup.push(sandbox);

        const encoder = new TextEncoder();
        const results = await sandbox.uploadFiles([
          ["/tmp/multi1.txt", encoder.encode("Content 1")],
          ["/tmp/multi2.txt", encoder.encode("Content 2")],
          ["/tmp/multi3.txt", encoder.encode("Content 3")],
        ]);

        expect(results.length).toBe(3);
        expect(results.every((r) => r.error === null)).toBe(true);

        // Verify all files exist
        const checkResult = await sandbox.execute(
          "cat /tmp/multi1.txt /tmp/multi2.txt /tmp/multi3.txt",
        );
        expect(checkResult.output).toContain("Content 1");
        expect(checkResult.output).toContain("Content 2");
        expect(checkResult.output).toContain("Content 3");
      },
      TEST_TIMEOUT,
    );
  });

  describe("reconnect to existing sandbox", () => {
    it(
      "should reconnect to existing sandbox via ModalSandbox.fromId()",
      async () => {
        // Create a sandbox with longer timeout so it persists
        const originalSandbox = await ModalSandbox.create({
          imageName: "alpine:3.21",
          timeoutMs: 600_000, // 10 minute timeout
        });

        const sandboxId = originalSandbox.id;

        // Create a file to verify later
        await originalSandbox.execute(
          'echo "Reconnect test" > /tmp/reconnect.txt',
        );

        // Reconnect using ModalSandbox.fromId()
        const reconnectedSandbox = await ModalSandbox.fromId(sandboxId);

        sandboxesToCleanup.push(reconnectedSandbox);

        expect(reconnectedSandbox.id).toBe(sandboxId);
        expect(reconnectedSandbox.isRunning).toBe(true);

        // Verify we can still access the file
        const result = await reconnectedSandbox.execute(
          "cat /tmp/reconnect.txt",
        );
        expect(result.output.trim()).toBe("Reconnect test");

        // Terminate the original reference
        await originalSandbox.terminate();
      },
      TEST_TIMEOUT * 2, // Double timeout for reconnect test
    );
  });

  describe("Python image support", () => {
    it(
      "should work with Python image",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "python:3.12-slim",
          timeoutMs: 300_000,
        });

        sandboxesToCleanup.push(sandbox);

        // Test Python is available and working
        const result = await sandbox.execute("python --version");

        expect(result.exitCode).toBe(0);
        expect(result.output).toMatch(/Python 3\.\d+\.\d+/);
      },
      TEST_TIMEOUT,
    );

    it(
      "should execute Python code",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "python:3.12-slim",
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute(
          'python -c "print(sum(range(10)))"',
        );

        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe("45");
      },
      TEST_TIMEOUT,
    );
  });

  describe("Node.js image support", () => {
    it(
      "should work with Node.js image",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "node:20-slim",
          timeoutMs: 300_000,
        });

        sandboxesToCleanup.push(sandbox);

        // Test Node.js is available and working
        const result = await sandbox.execute("node --version");

        expect(result.exitCode).toBe(0);
        expect(result.output).toMatch(/v\d+\.\d+\.\d+/);
      },
      TEST_TIMEOUT,
    );

    it(
      "should execute JavaScript code",
      async () => {
        const sandbox = await ModalSandbox.create({
          imageName: "node:20-slim",
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute(
          'node -e "console.log(Array.from({length: 5}, (_, i) => i * 2).reduce((a, b) => a + b))"',
        );

        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe("20");
      },
      TEST_TIMEOUT,
    );
  });
});
