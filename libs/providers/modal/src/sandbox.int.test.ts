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
import { sandboxStandardTests } from "@langchain/standard-tests";
import { ModalSandbox } from "./sandbox.js";

// Check if integration tests should run
const MODAL_TOKEN_ID = process.env.MODAL_TOKEN_ID;
const MODAL_TOKEN_SECRET = process.env.MODAL_TOKEN_SECRET;
const hasCredentials = !!(MODAL_TOKEN_ID && MODAL_TOKEN_SECRET);

const TEST_TIMEOUT = 180_000; // 3 minutes

sandboxStandardTests({
  name: "ModalSandbox",
  skip: !hasCredentials,
  timeout: TEST_TIMEOUT,
  createSandbox: async (options) =>
    ModalSandbox.create({
      imageName: "alpine:3.21",
      ...options,
    }),
  createUninitializedSandbox: () =>
    new ModalSandbox({ imageName: "alpine:3.21" }),
  closeSandbox: (sandbox) => sandbox.close(),
  resolvePath: (name) => `/tmp/${name}`,
});

/**
 * Track sandboxes for cleanup
 */
const sandboxesToCleanup: ModalSandbox[] = [];

afterAll(async () => {
  for (const sandbox of sandboxesToCleanup) {
    try {
      await sandbox.close();
    } catch {
      // Ignore cleanup errors
    }
  }
});

describe.skipIf(!hasCredentials)("ModalSandbox Provider-Specific Tests", () => {
  describe("initialFiles (provider-specific)", () => {
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
  });
});
