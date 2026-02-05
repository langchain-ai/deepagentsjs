/**
 * Integration tests for DenoSandbox class.
 *
 * These tests require a valid Deno Deploy token to run. They create real
 * sandbox instances and will be skipped if DENO_DEPLOY_TOKEN is not set.
 *
 * To run these tests:
 * 1. Set up Deno Deploy authentication:
 *    - Go to https://app.deno.com -> Settings -> Organization Tokens
 *    - Create a token and export DENO_DEPLOY_TOKEN=your_token
 * 2. Run tests: `pnpm test:int` or `pnpm vitest run sandbox.int.test.ts`
 *
 * Note: These tests may incur Deno Deploy usage costs and take longer to run.
 */

import { describe, it, expect, afterAll } from "vitest";
import { DenoSandbox } from "/home/app/sandbox.js";

// Check if integration tests should run
const DENO_TOKEN = process.env.DENO_DEPLOY_TOKEN;

/**
 * Track sandboxes for cleanup
 */
const sandboxesToCleanup: DenoSandbox[] = [];

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

// Skip all tests if no Deno token is available
describe.skipIf(!DENO_TOKEN)("DenoSandbox Integration Tests", () => {
  // Increase timeout for integration tests (sandbox creation can take 10-30 seconds)
  const TEST_TIMEOUT = 120_000; // 2 minutes

  // ============================================================================
  // Test sandbox lifecycle
  // ============================================================================

  describe("sandbox lifecycle", () => {
    it(
      "should create sandbox via DenoSandbox.create()",
      async () => {
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
          lifetime: "session",
        });

        sandboxesToCleanup.push(sandbox);

        expect(sandbox).toBeInstanceOf(DenoSandbox);
        expect(sandbox.id).toBeDefined();
        expect(sandbox.id).not.toMatch(/^deno-sandbox-\d+$/); // Should have real ID
      },
      TEST_TIMEOUT,
    );

    it(
      "should have isRunning as true after creation",
      async () => {
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
        });

        sandboxesToCleanup.push(sandbox);

        expect(sandbox.isRunning).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      "should close sandbox successfully",
      async () => {
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
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
        const sandbox = new DenoSandbox({
          memoryMb: 768,
        });

        expect(sandbox.isRunning).toBe(false);

        await sandbox.initialize();

        sandboxesToCleanup.push(sandbox);

        expect(sandbox.isRunning).toBe(true);
        expect(sandbox.id).not.toMatch(/^deno-sandbox-\d+$/);
      },
      TEST_TIMEOUT,
    );
  });

  // ============================================================================
  // Test command execution
  // ============================================================================

  describe("command execution", () => {
    it(
      "should run simple echo command",
      async () => {
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
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
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
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
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
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
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute('echo "error message" >&2');

        // stderr should be included in output
        expect(result.output).toContain("error message");
      },
      TEST_TIMEOUT,
    );

    it(
      "should have Deno available",
      async () => {
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
        });

        sandboxesToCleanup.push(sandbox);

        // Test Deno is available and working
        const result = await sandbox.execute("deno --version");

        expect(result.exitCode).toBe(0);
        expect(result.output).toMatch(/deno \d+\.\d+\.\d+/);
      },
      TEST_TIMEOUT,
    );

    it(
      "should handle command with environment variables",
      async () => {
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
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

  // ============================================================================
  // Test file operations
  // ============================================================================

  describe("file operations", () => {
    it(
      "should upload files to sandbox",
      async () => {
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
        });

        sandboxesToCleanup.push(sandbox);

        const content = new TextEncoder().encode("Hello from test file!");
        const results = await sandbox.uploadFiles([
          ["/home/app/test-upload.txt", content],
        ]);

        expect(results.length).toBe(1);
        expect(results[0].path).toBe("/home/app/test-upload.txt");
        expect(results[0].error).toBeNull();

        // Verify file exists using execute
        const checkResult = await sandbox.execute(
          "cat /home/app/test-upload.txt",
        );
        expect(checkResult.output.trim()).toBe("Hello from test file!");
      },
      TEST_TIMEOUT,
    );

    it(
      "should download files from sandbox",
      async () => {
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
        });

        sandboxesToCleanup.push(sandbox);

        // First create a file using execute
        await sandbox.execute(
          'echo "Download test content" > /home/app/test-download.txt',
        );

        // Now download it
        const results = await sandbox.downloadFiles([
          "/home/app/test-download.txt",
        ]);

        expect(results.length).toBe(1);
        expect(results[0].path).toBe("/home/app/test-download.txt");
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
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
        });

        sandboxesToCleanup.push(sandbox);

        const results = await sandbox.downloadFiles([
          "/home/app/nonexistent-file-12345.txt",
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
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
        });

        sandboxesToCleanup.push(sandbox);

        // Create a file first
        await sandbox.execute(
          'echo "Read test content" > /home/app/read-test.txt',
        );

        // Use inherited read method
        const content = await sandbox.read("/home/app/read-test.txt");

        expect(content).toContain("Read test content");
      },
      TEST_TIMEOUT,
    );

    it(
      "should use inherited write method from BaseSandbox",
      async () => {
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
        });

        sandboxesToCleanup.push(sandbox);

        // Use inherited write method
        await sandbox.write(
          "/home/app/write-test.txt",
          "Written via BaseSandbox",
        );

        // Verify using execute
        const result = await sandbox.execute("cat /home/app/write-test.txt");
        expect(result.output.trim()).toBe("Written via BaseSandbox");
      },
      TEST_TIMEOUT,
    );

    it(
      "should use inherited edit method from BaseSandbox",
      async () => {
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
        });

        sandboxesToCleanup.push(sandbox);

        // Create initial file
        await sandbox.write("/home/app/edit-test.txt", "Hello World");

        // Use inherited edit method
        await sandbox.edit(
          "/home/app/edit-test.txt",
          "Hello World",
          "Hello Edited World",
        );

        // Verify the edit
        const result = await sandbox.execute("cat /home/app/edit-test.txt");
        expect(result.output.trim()).toBe("Hello Edited World");
      },
      TEST_TIMEOUT,
    );

    it(
      "should upload multiple files at once",
      async () => {
        const sandbox = await DenoSandbox.create({
          memoryMb: 768,
        });

        sandboxesToCleanup.push(sandbox);

        const encoder = new TextEncoder();
        const results = await sandbox.uploadFiles([
          ["/home/app/multi1.txt", encoder.encode("Content 1")],
          ["/home/app/multi2.txt", encoder.encode("Content 2")],
          ["/home/app/multi3.txt", encoder.encode("Content 3")],
        ]);

        expect(results.length).toBe(3);
        expect(results.every((r) => r.error === null)).toBe(true);

        // Verify all files exist
        const checkResult = await sandbox.execute(
          "cat /home/app/multi1.txt /home/app/multi2.txt /home/app/multi3.txt",
        );
        expect(checkResult.output).toContain("Content 1");
        expect(checkResult.output).toContain("Content 2");
        expect(checkResult.output).toContain("Content 3");
      },
      TEST_TIMEOUT,
    );
  });

  // ============================================================================
  // Test reconnect to existing sandbox
  // ============================================================================

  describe("reconnect to existing sandbox", () => {
    it.skip(
      "should reconnect to existing sandbox via DenoSandbox.connect()",
      async () => {
        // Create a sandbox with duration lifetime so it persists
        const originalSandbox = await DenoSandbox.create({
          memoryMb: 768,
          lifetime: "5m", // 5 minute lifetime
        });

        const sandboxId = originalSandbox.id;

        // Create a file to verify later
        await originalSandbox.execute(
          'echo "Reconnect test" > /home/app/reconnect.txt',
        );

        // Close the connection (but sandbox keeps running due to duration lifetime)
        await originalSandbox.close();

        // Reconnect using DenoSandbox.connect()
        const reconnectedSandbox = await DenoSandbox.connect(sandboxId);

        sandboxesToCleanup.push(reconnectedSandbox);

        expect(reconnectedSandbox.id).toBe(sandboxId);
        expect(reconnectedSandbox.isRunning).toBe(true);

        // Verify we can still access the file
        const result = await reconnectedSandbox.execute(
          "cat /home/app/reconnect.txt",
        );
        expect(result.output.trim()).toBe("Reconnect test");

        // Kill the sandbox to clean up
        await reconnectedSandbox.kill();
      },
      TEST_TIMEOUT * 2, // Double timeout for reconnect test
    );
  });
});
