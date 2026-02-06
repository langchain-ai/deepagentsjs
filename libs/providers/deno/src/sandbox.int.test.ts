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
import { sandboxStandardTests } from "@langchain/standard-tests";
import { DenoSandbox } from "./sandbox.js";

// Check if integration tests should run
const DENO_TOKEN = process.env.DENO_DEPLOY_TOKEN;

const TEST_TIMEOUT = 120_000; // 2 minutes

sandboxStandardTests({
  name: "DenoSandbox",
  skip: !DENO_TOKEN,
  sequential: true,
  timeout: TEST_TIMEOUT,
  createSandbox: async (options) =>
    DenoSandbox.create({
      memoryMb: 768,
      ...options,
    }),
  createUninitializedSandbox: () => new DenoSandbox({ memoryMb: 768 }),
  closeSandbox: (sandbox) => sandbox.close(),
  resolvePath: (name) => `/home/app/${name}`,
});

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

describe
  .skipIf(!DENO_TOKEN)
  .sequential("DenoSandbox Provider-Specific Tests", () => {
    describe("Deno runtime", () => {
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

    describe("TypeScript execution with Deno", () => {
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
