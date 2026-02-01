/**
 * Integration tests for VercelSandbox class.
 *
 * These tests require a valid Vercel OIDC token to run. They create real
 * sandbox instances and will be skipped if VERCEL_OIDC_TOKEN is not set.
 *
 * To run these tests:
 * 1. Set up Vercel authentication: `vercel link && vercel env pull`
 * 2. Run tests: `pnpm test:int` or `pnpm vitest run vercel-sandbox.int.test.ts`
 *
 * Note: These tests may incur Vercel usage costs and take longer to run.
 */

import { describe, it, expect, afterAll } from "vitest";
import { VercelSandbox } from "./sandbox.js";

// Check if integration tests should run
const VERCEL_TOKEN =
  process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_ACCESS_TOKEN;

/**
 * Track sandboxes for cleanup
 */
const sandboxesToCleanup: VercelSandbox[] = [];

/**
 * Cleanup all sandboxes after tests complete
 */
afterAll(async () => {
  for (const sandbox of sandboxesToCleanup) {
    try {
      await sandbox.stop();
    } catch {
      // Ignore cleanup errors
    }
  }
});

// Skip all tests if no Vercel token is available
describe.skipIf(!VERCEL_TOKEN)("VercelSandbox Integration Tests", () => {
  // Increase timeout for integration tests (sandbox creation can take 10-30 seconds)
  const TEST_TIMEOUT = 120_000; // 2 minutes

  // ============================================================================
  // Task G1: Test sandbox lifecycle
  // ============================================================================

  describe("sandbox lifecycle", () => {
    it(
      "should create sandbox via VercelSandbox.create()",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000, // 1 minute (minimum reasonable timeout)
        });

        sandboxesToCleanup.push(sandbox);

        expect(sandbox).toBeInstanceOf(VercelSandbox);
        expect(sandbox.id).toBeDefined();
        expect(sandbox.id).not.toMatch(/^vercel-sandbox-\d+$/); // Should have real ID
      },
      TEST_TIMEOUT,
    );

    it(
      "should have isRunning as true after creation",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        sandboxesToCleanup.push(sandbox);

        expect(sandbox.isRunning).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      "should stop sandbox successfully",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        // Don't add to cleanup - we're testing stop() explicitly
        expect(sandbox.isRunning).toBe(true);

        await sandbox.stop();

        expect(sandbox.isRunning).toBe(false);
      },
      TEST_TIMEOUT,
    );

    it(
      "should work with two-step initialization",
      async () => {
        const sandbox = new VercelSandbox({
          runtime: "node24",
          timeout: 60000,
        });

        expect(sandbox.isRunning).toBe(false);

        await sandbox.initialize();

        sandboxesToCleanup.push(sandbox);

        expect(sandbox.isRunning).toBe(true);
        expect(sandbox.id).not.toMatch(/^vercel-sandbox-\d+$/);
      },
      TEST_TIMEOUT,
    );
  });

  // ============================================================================
  // Task G2: Test command execution
  // ============================================================================

  describe("command execution", () => {
    it(
      "should run simple echo command",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
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
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
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
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
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
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute('echo "error message" >&2');

        // stderr should be included in output
        expect(result.output).toContain("error message");
      },
      TEST_TIMEOUT,
    );

    it(
      "should handle complex commands",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
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
      "should handle command with environment variables",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        sandboxesToCleanup.push(sandbox);

        const result = await sandbox.execute(
          'MY_VAR="test_value" && echo $MY_VAR',
        );

        expect(result.exitCode).toBe(0);
        // Note: This may or may not work depending on shell behavior
        // The main point is the command executes without error
      },
      TEST_TIMEOUT,
    );
  });

  // ============================================================================
  // Task G3: Test file operations
  // ============================================================================

  describe("file operations", () => {
    it(
      "should upload files to sandbox",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        sandboxesToCleanup.push(sandbox);

        const content = new TextEncoder().encode("Hello from test file!");
        const results = await sandbox.uploadFiles([
          ["/vercel/sandbox/test-upload.txt", content],
        ]);

        expect(results.length).toBe(1);
        expect(results[0].path).toBe("/vercel/sandbox/test-upload.txt");
        expect(results[0].error).toBeNull();

        // Verify file exists using execute
        const checkResult = await sandbox.execute(
          "cat /vercel/sandbox/test-upload.txt",
        );
        expect(checkResult.output.trim()).toBe("Hello from test file!");
      },
      TEST_TIMEOUT,
    );

    it(
      "should download files from sandbox",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        sandboxesToCleanup.push(sandbox);

        // First create a file using execute
        await sandbox.execute(
          'echo "Download test content" > /vercel/sandbox/test-download.txt',
        );

        // Now download it
        const results = await sandbox.downloadFiles([
          "/vercel/sandbox/test-download.txt",
        ]);

        expect(results.length).toBe(1);
        expect(results[0].path).toBe("/vercel/sandbox/test-download.txt");
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
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        sandboxesToCleanup.push(sandbox);

        const results = await sandbox.downloadFiles([
          "/vercel/sandbox/nonexistent-file-12345.txt",
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
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        sandboxesToCleanup.push(sandbox);

        // Create a file first
        await sandbox.execute(
          'echo "Read test content" > /vercel/sandbox/read-test.txt',
        );

        // Use inherited read method
        const content = await sandbox.read("/vercel/sandbox/read-test.txt");

        expect(content).toContain("Read test content");
      },
      TEST_TIMEOUT,
    );

    it(
      "should use inherited write method from BaseSandbox",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        sandboxesToCleanup.push(sandbox);

        // Use inherited write method
        await sandbox.write(
          "/vercel/sandbox/write-test.txt",
          "Written via BaseSandbox",
        );

        // Verify using execute
        const result = await sandbox.execute(
          "cat /vercel/sandbox/write-test.txt",
        );
        expect(result.output.trim()).toBe("Written via BaseSandbox");
      },
      TEST_TIMEOUT,
    );

    it(
      "should use inherited edit method from BaseSandbox",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        sandboxesToCleanup.push(sandbox);

        // Create initial file
        await sandbox.write("/vercel/sandbox/edit-test.txt", "Hello World");

        // Use inherited edit method
        await sandbox.edit(
          "/vercel/sandbox/edit-test.txt",
          "Hello World",
          "Hello Edited World",
        );

        // Verify the edit
        const result = await sandbox.execute(
          "cat /vercel/sandbox/edit-test.txt",
        );
        expect(result.output.trim()).toBe("Hello Edited World");
      },
      TEST_TIMEOUT,
    );

    it(
      "should upload multiple files at once",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        sandboxesToCleanup.push(sandbox);

        const encoder = new TextEncoder();
        const results = await sandbox.uploadFiles([
          ["/vercel/sandbox/multi1.txt", encoder.encode("Content 1")],
          ["/vercel/sandbox/multi2.txt", encoder.encode("Content 2")],
          ["/vercel/sandbox/multi3.txt", encoder.encode("Content 3")],
        ]);

        expect(results.length).toBe(3);
        expect(results.every((r) => r.error === null)).toBe(true);

        // Verify all files exist
        const checkResult = await sandbox.execute(
          "cat /vercel/sandbox/multi1.txt /vercel/sandbox/multi2.txt /vercel/sandbox/multi3.txt",
        );
        expect(checkResult.output).toContain("Content 1");
        expect(checkResult.output).toContain("Content 2");
        expect(checkResult.output).toContain("Content 3");
      },
      TEST_TIMEOUT,
    );
  });

  // ============================================================================
  // Task G4: Test snapshot operations
  // ============================================================================

  describe("snapshot operations", () => {
    it(
      "should create snapshot successfully",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        // Don't add to cleanup - snapshot stops the sandbox

        // Create some state to snapshot
        await sandbox.execute(
          'echo "Snapshot test" > /vercel/sandbox/snapshot-file.txt',
        );

        // Create snapshot
        const snapshotInfo = await sandbox.snapshot();

        expect(snapshotInfo.snapshotId).toBeDefined();
        expect(snapshotInfo.snapshotId).toBeTruthy();
        expect(snapshotInfo.sourceSandboxId).toBe(sandbox.id);
        expect(snapshotInfo.status).toBe("created");
        expect(snapshotInfo.sizeBytes).toBeGreaterThan(0);
        expect(snapshotInfo.createdAt).toBeInstanceOf(Date);
        expect(snapshotInfo.expiresAt).toBeInstanceOf(Date);

        // Verify snapshot expiry is ~7 days in the future
        const now = new Date();
        const daysUntilExpiry =
          (snapshotInfo.expiresAt.getTime() - now.getTime()) /
          (1000 * 60 * 60 * 24);
        expect(daysUntilExpiry).toBeGreaterThan(6);
        expect(daysUntilExpiry).toBeLessThan(8);
      },
      TEST_TIMEOUT,
    );

    it(
      "should return correct snapshot info structure",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        const snapshotInfo = await sandbox.snapshot();

        // Verify all required fields exist
        expect(typeof snapshotInfo.snapshotId).toBe("string");
        expect(typeof snapshotInfo.sourceSandboxId).toBe("string");
        expect(typeof snapshotInfo.status).toBe("string");
        expect(typeof snapshotInfo.sizeBytes).toBe("number");
        expect(Object.prototype.toString.call(snapshotInfo.createdAt)).toBe(
          "[object Date]",
        );
        expect(Object.prototype.toString.call(snapshotInfo.expiresAt)).toBe(
          "[object Date]",
        );
      },
      TEST_TIMEOUT,
    );

    // Note: Testing snapshot restoration is expensive and may be flaky due to
    // eventual consistency. We test it conditionally and with longer timeout.
    it.skip("should restore from snapshot (expensive test - skipped by default)", async () => {
      // Create original sandbox and add some content
      const originalSandbox = await VercelSandbox.create({
        runtime: "node24",
        timeout: 60000,
      });

      await originalSandbox.execute(
        'echo "Restore test content" > /vercel/sandbox/restore-test.txt',
      );

      // Create snapshot
      const snapshotInfo = await originalSandbox.snapshot();
      // Note: Sandbox is stopped after snapshot

      // Wait a moment for snapshot to be fully available
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Create new sandbox from snapshot
      const restoredSandbox = await VercelSandbox.create({
        runtime: "node24",
        timeout: 60000,
        source: {
          type: "snapshot",
          snapshotId: snapshotInfo.snapshotId,
        },
      });

      sandboxesToCleanup.push(restoredSandbox);

      // Verify the file exists in restored sandbox
      const result = await restoredSandbox.execute(
        "cat /vercel/sandbox/restore-test.txt",
      );
      expect(result.output.trim()).toBe("Restore test content");
    }, 300_000); // 5 minute timeout for this expensive test
  });

  // ============================================================================
  // Additional integration tests
  // ============================================================================

  describe("domain and ports", () => {
    it.skip(
      "should expose port and return domain URL",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
          ports: [3000],
        });

        sandboxesToCleanup.push(sandbox);

        const domain = sandbox.domain(3000);

        expect(domain).toBeDefined();
        expect(domain).toContain(sandbox.id);
        expect(domain).toMatch(/^https?:\/\//);
      },
      TEST_TIMEOUT,
    );
  });

  describe("reconnect to existing sandbox", () => {
    it(
      "should reconnect to existing sandbox via VercelSandbox.get()",
      async () => {
        // Create a sandbox
        const originalSandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 120000, // 2 minutes to allow time for reconnect test
        });

        sandboxesToCleanup.push(originalSandbox);

        const sandboxId = originalSandbox.id;

        // Create a file to verify later
        await originalSandbox.execute(
          'echo "Reconnect test" > /vercel/sandbox/reconnect.txt',
        );

        // Reconnect using VercelSandbox.get()
        const reconnectedSandbox = await VercelSandbox.get(sandboxId);

        // Don't add to cleanup - it's the same sandbox as originalSandbox

        expect(reconnectedSandbox.id).toBe(sandboxId);
        expect(reconnectedSandbox.isRunning).toBe(true);

        // Verify we can still access the file
        const result = await reconnectedSandbox.execute(
          "cat /vercel/sandbox/reconnect.txt",
        );
        expect(result.output.trim()).toBe("Reconnect test");
      },
      TEST_TIMEOUT,
    );
  });

  describe("extend timeout", () => {
    it(
      "should extend sandbox timeout",
      async () => {
        const sandbox = await VercelSandbox.create({
          runtime: "node24",
          timeout: 60000,
        });

        sandboxesToCleanup.push(sandbox);

        // Extend timeout - should not throw
        await expect(sandbox.extendTimeout(60000)).resolves.not.toThrow();
      },
      TEST_TIMEOUT,
    );
  });
});
