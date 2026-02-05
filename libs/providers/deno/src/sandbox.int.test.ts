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
 * Tests run sequentially to avoid hitting sandbox concurrency limits.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterAll, afterEach } from "vitest";
import { DenoSandbox } from "./sandbox.js";

// Check if integration tests should run
const DENO_TOKEN = process.env.DENO_DEPLOY_TOKEN;

/**
 * Current sandbox for the test - cleaned up after each test
 */
let currentSandbox: DenoSandbox | null = null;

/**
 * Track sandboxes for cleanup (fallback for any missed cleanups)
 */
const sandboxesToCleanup: DenoSandbox[] = [];

/**
 * Helper to create and track a sandbox
 */
async function createSandbox(
  options: Parameters<typeof DenoSandbox.create>[0] = {},
): Promise<DenoSandbox> {
  const sandbox = await DenoSandbox.create({
    memoryMb: 768,
    ...options,
  });
  currentSandbox = sandbox;
  sandboxesToCleanup.push(sandbox);
  return sandbox;
}

/**
 * Cleanup current sandbox after each test to avoid concurrency issues
 */
afterEach(async () => {
  if (currentSandbox) {
    try {
      await currentSandbox.close();
    } catch {
      // Ignore cleanup errors
    }
    currentSandbox = null;
  }
});

/**
 * Cleanup all sandboxes after tests complete (fallback)
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
// Use describe.sequential to run tests one at a time to avoid concurrency limits
describe.skipIf(!DENO_TOKEN).sequential("DenoSandbox Integration Tests", () => {
  // Increase timeout for integration tests (sandbox creation can take 10-30 seconds)
  const TEST_TIMEOUT = 120_000; // 2 minutes

  describe("sandbox lifecycle", () => {
    it(
      "should create sandbox via DenoSandbox.create()",
      async () => {
        const sandbox = await createSandbox({ lifetime: "session" });

        expect(sandbox).toBeInstanceOf(DenoSandbox);
        expect(sandbox.id).toBeDefined();
        expect(sandbox.id).not.toMatch(/^deno-sandbox-\d+$/); // Should have real ID
      },
      TEST_TIMEOUT,
    );

    it(
      "should have isRunning as true after creation",
      async () => {
        const sandbox = await createSandbox();

        expect(sandbox.isRunning).toBe(true);
      },
      TEST_TIMEOUT,
    );

    it(
      "should close sandbox successfully",
      async () => {
        const sandbox = await createSandbox();

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

        currentSandbox = sandbox;
        sandboxesToCleanup.push(sandbox);

        expect(sandbox.isRunning).toBe(true);
        expect(sandbox.id).not.toMatch(/^deno-sandbox-\d+$/);
      },
      TEST_TIMEOUT,
    );
  });

  describe("command execution", () => {
    it(
      "should run simple echo command",
      async () => {
        const sandbox = await createSandbox();

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
        const sandbox = await createSandbox();

        const result = await sandbox.execute("exit 42");

        expect(result.exitCode).toBe(42);
      },
      TEST_TIMEOUT,
    );

    it(
      "should capture command output correctly",
      async () => {
        const sandbox = await createSandbox();

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
        const sandbox = await createSandbox();

        const result = await sandbox.execute('echo "error message" >&2');

        // stderr should be included in output
        expect(result.output).toContain("error message");
      },
      TEST_TIMEOUT,
    );

    it(
      "should have Deno available",
      async () => {
        const sandbox = await createSandbox();

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
        const sandbox = await createSandbox();

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
        const sandbox = await createSandbox();

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
        const sandbox = await createSandbox();

        // First create a file using uploadFiles (ensures directory exists)
        const encoder = new TextEncoder();
        await sandbox.uploadFiles([
          [
            "/home/app/test-download.txt",
            encoder.encode("Download test content"),
          ],
        ]);

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
        const sandbox = await createSandbox();

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
        const sandbox = await createSandbox();

        const encoder = new TextEncoder();
        await sandbox.uploadFiles([
          ["/home/app/read-test.txt", encoder.encode("Read test content")],
        ]);

        const content = await sandbox.read("/home/app/read-test.txt");
        expect(content).toContain("Read test content");
      },
      TEST_TIMEOUT,
    );

    it(
      "should use inherited write method from BaseSandbox",
      async () => {
        const sandbox = await createSandbox();

        await sandbox.write(
          "/home/app/write-test.txt",
          "Written via BaseSandbox",
        );

        const result = await sandbox.execute("cat /home/app/write-test.txt");
        expect(result.output.trim()).toBe("Written via BaseSandbox");
      },
      TEST_TIMEOUT,
    );

    it(
      "should use inherited edit method from BaseSandbox",
      async () => {
        const sandbox = await createSandbox();

        await sandbox.write("/home/app/edit-test.txt", "Hello World");

        await sandbox.edit(
          "/home/app/edit-test.txt",
          "Hello World",
          "Hello Edited World",
        );

        const result = await sandbox.execute("cat /home/app/edit-test.txt");
        expect(result.output.trim()).toBe("Hello Edited World");
      },
      TEST_TIMEOUT,
    );

    it(
      "should upload multiple files at once",
      async () => {
        const sandbox = await createSandbox();

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

  describe("reconnect to existing sandbox", () => {
    it(
      "should reconnect to existing sandbox via DenoSandbox.connect()",
      async () => {
        // Create a sandbox with duration lifetime so it persists
        const originalSandbox = await createSandbox({ lifetime: "5m" });

        const sandboxId = originalSandbox.id;

        // Create a file to verify later
        await originalSandbox.execute(
          'echo "Reconnect test" > /home/app/reconnect.txt',
        );

        // Close the connection (but sandbox keeps running due to duration lifetime)
        await originalSandbox.close();
        currentSandbox = null; // Prevent afterEach from trying to close again

        // Reconnect using DenoSandbox.connect()
        const reconnectedSandbox = await DenoSandbox.connect(sandboxId);

        currentSandbox = reconnectedSandbox;
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
        currentSandbox = null;
      },
      TEST_TIMEOUT * 2, // Double timeout for reconnect test
    );
  });

  describe("initialFiles", () => {
    it(
      "should create sandbox with initial files",
      async () => {
        const sandbox = await createSandbox({
          initialFiles: {
            "/home/app/index.js": "console.log('Hello from initial file');",
            "/home/app/package.json":
              '{"name": "test-app", "version": "1.0.0"}',
          },
        });

        expect(sandbox.isRunning).toBe(true);

        // Verify index.js exists and has correct content
        const indexResult = await sandbox.execute("cat /home/app/index.js");
        expect(indexResult.exitCode).toBe(0);
        expect(indexResult.output).toContain("Hello from initial file");

        // Verify package.json exists and has correct content
        const packageResult = await sandbox.execute(
          "cat /home/app/package.json",
        );
        expect(packageResult.exitCode).toBe(0);
        expect(packageResult.output).toContain("test-app");
        expect(packageResult.output).toContain("1.0.0");

        // Verify we can execute the JavaScript file with Deno
        const execResult = await sandbox.execute("deno run /home/app/index.js");
        expect(execResult.exitCode).toBe(0);
        expect(execResult.output).toContain("Hello from initial file");
      },
      TEST_TIMEOUT,
    );

    it(
      "should create sandbox with deeply nested initial files",
      async () => {
        const sandbox = await createSandbox({
          initialFiles: {
            "/home/app/src/components/Button/index.tsx":
              "export const Button = () => <button>Click</button>;",
            "/home/app/src/utils/helpers/string.ts":
              "export const capitalize = (s: string) => s.toUpperCase();",
          },
        });

        expect(sandbox.isRunning).toBe(true);

        // Verify nested directory structure was created
        const lsResult = await sandbox.execute("find /home/app/src -type f");
        expect(lsResult.exitCode).toBe(0);
        expect(lsResult.output).toContain(
          "/home/app/src/components/Button/index.tsx",
        );
        expect(lsResult.output).toContain(
          "/home/app/src/utils/helpers/string.ts",
        );

        // Verify file contents
        const buttonContent = await sandbox.execute(
          "cat /home/app/src/components/Button/index.tsx",
        );
        expect(buttonContent.output).toContain("Button");

        const helperContent = await sandbox.execute(
          "cat /home/app/src/utils/helpers/string.ts",
        );
        expect(helperContent.output).toContain("capitalize");
      },
      TEST_TIMEOUT,
    );

    it(
      "should create sandbox with empty initialFiles object",
      async () => {
        const sandbox = await createSandbox({ initialFiles: {} });

        expect(sandbox.isRunning).toBe(true);

        // Sandbox should work normally
        const result = await sandbox.execute('echo "Works!"');
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("Works!");
      },
      TEST_TIMEOUT,
    );

    it(
      "should create sandbox with TypeScript files and execute them with Deno",
      async () => {
        const tsCode = `
const greeting: string = "Hello from initialFiles!";
console.log(greeting);

interface User {
  name: string;
  age: number;
}

const user: User = { name: "Alice", age: 30 };
console.log(\`User: \${user.name}, Age: \${user.age}\`);
`;

        const sandbox = await createSandbox({
          initialFiles: {
            "/home/app/main.ts": tsCode,
          },
        });

        expect(sandbox.isRunning).toBe(true);

        // Execute the TypeScript file with Deno
        const result = await sandbox.execute("deno run /home/app/main.ts");
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("Hello from initialFiles!");
        expect(result.output).toContain("User: Alice, Age: 30");
      },
      TEST_TIMEOUT,
    );
  });
});
