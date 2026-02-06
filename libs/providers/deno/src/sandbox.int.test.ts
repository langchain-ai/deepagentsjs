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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sandboxStandardTests, withRetry } from "@langchain/standard-tests";
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

describe
  .skipIf(!DENO_TOKEN)
  .sequential("DenoSandbox Provider-Specific Tests", () => {
    let shared: DenoSandbox;

    beforeAll(async () => {
      shared = await withRetry(() => DenoSandbox.create({ memoryMb: 768 }));
    }, TEST_TIMEOUT);

    afterAll(async () => {
      try {
        await shared?.close();
      } catch {
        // Ignore cleanup errors
      }
    }, TEST_TIMEOUT);

    describe("Deno runtime", () => {
      it(
        "should have Deno available",
        async () => {
          const result = await shared.execute("deno --version");

          expect(result.exitCode).toBe(0);
          expect(result.output).toMatch(/deno \d+\.\d+\.\d+/);
        },
        TEST_TIMEOUT,
      );
    });

    describe("reconnect to existing sandbox", () => {
      let originalSandbox: DenoSandbox;
      beforeAll(async () => {
        originalSandbox = await withRetry(() =>
          DenoSandbox.create({
            memoryMb: 768,
            lifetime: "5m",
          }),
        );
      }, TEST_TIMEOUT);

      afterAll(async () => {
        try {
          await originalSandbox?.close();
        } catch {
          // Ignore cleanup errors
        }
      }, TEST_TIMEOUT);

      it(
        "should reconnect to existing sandbox via DenoSandbox.connect()",
        async () => {
          const sandboxId = originalSandbox.id;

          await originalSandbox.execute(
            'echo "Reconnect test" > /home/app/reconnect.txt',
          );

          // Close the connection (but sandbox keeps running due to duration lifetime)
          await originalSandbox.close();

          // Reconnect using DenoSandbox.fromId()
          const reconnectedSandbox = await DenoSandbox.fromId(sandboxId);

          expect(reconnectedSandbox.id).toBe(sandboxId);
          expect(reconnectedSandbox.isRunning).toBe(true);

          const result = await reconnectedSandbox.execute(
            "cat /home/app/reconnect.txt",
          );
          expect(result.output.trim()).toBe("Reconnect test");
        },
        TEST_TIMEOUT * 2,
      );
    });

    describe("TypeScript execution with Deno", () => {
      let tsSandbox: DenoSandbox;

      beforeAll(async () => {
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

        tsSandbox = await withRetry(() =>
          DenoSandbox.create({
            memoryMb: 768,
            initialFiles: {
              "/home/app/main.ts": tsCode,
            },
          }),
        );
      }, TEST_TIMEOUT);

      afterAll(async () => {
        try {
          await tsSandbox?.close();
        } catch {
          // Ignore cleanup errors
        }
      }, TEST_TIMEOUT);

      it(
        "should create sandbox with TypeScript files and execute them with Deno",
        async () => {
          expect(tsSandbox.isRunning).toBe(true);

          const result = await tsSandbox.execute("deno run /home/app/main.ts");
          expect(result.exitCode).toBe(0);
          expect(result.output).toContain("Hello from initialFiles!");
          expect(result.output).toContain("User: Alice, Age: 30");
        },
        TEST_TIMEOUT,
      );
    });
  });
