/**
 * Integration tests for DaytonaSandbox.
 *
 * These tests require a valid DAYTONA_API_KEY environment variable.
 * Run with: pnpm test:int
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sandboxStandardTests } from "@langchain/standard-tests";

import { DaytonaSandbox } from "./index.js";

const TEST_TIMEOUT = 120_000; // 2 minutes

/**
 * Clean up stale integration-test sandboxes before running tests.
 */
beforeAll(async () => {
  await DaytonaSandbox.deleteAll({
    purpose: "integration-test",
    package: "@langchain/daytona",
  });
}, TEST_TIMEOUT);

sandboxStandardTests({
  name: "DaytonaSandbox",
  timeout: TEST_TIMEOUT,
  createSandbox: async (options) =>
    DaytonaSandbox.create({
      language: "typescript",
      autoStopInterval: 5,
      labels: {
        purpose: "integration-test",
        package: "@langchain/daytona",
      },
      ...options,
    }),
  closeSandbox: (sandbox) => sandbox.close(),
  resolvePath: (name) => name,
});

describe("DaytonaSandbox Provider-Specific Tests", () => {
  let sandbox: DaytonaSandbox;

  beforeAll(async () => {
    sandbox = await DaytonaSandbox.create({
      language: "typescript",
      autoStopInterval: 5,
      labels: {
        purpose: "integration-test",
        package: "@langchain/daytona",
      },
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    try {
      await sandbox?.close();
    } catch {
      // Ignore cleanup errors
    }
  }, TEST_TIMEOUT);

  it(
    "should execute node command",
    async () => {
      const result = await sandbox.execute("node --version");

      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(/v\d+\.\d+\.\d+/);
    },
    TEST_TIMEOUT,
  );

  it(
    "should get working directory",
    async () => {
      const workDir = await sandbox.getWorkDir();

      expect(workDir).toBeTruthy();
      expect(typeof workDir).toBe("string");
    },
    TEST_TIMEOUT,
  );

  it(
    "should get user home directory",
    async () => {
      const homeDir = await sandbox.getUserHomeDir();

      expect(homeDir).toBeTruthy();
      expect(typeof homeDir).toBe("string");
    },
    TEST_TIMEOUT,
  );

  it(
    "should run TypeScript code",
    async () => {
      const encoder = new TextEncoder();
      const tsCode = `
const greeting: string = "Hello, TypeScript!";
console.log(greeting);

const add = (a: number, b: number): number => a + b;
console.log(\`2 + 3 = \${add(2, 3)}\`);
`;

      // Write TypeScript file
      await sandbox.uploadFiles([["script.ts", encoder.encode(tsCode)]]);

      // Execute with npx tsx
      const result = await sandbox.execute("npx tsx script.ts");

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Hello, TypeScript!");
      expect(result.output).toContain("2 + 3 = 5");
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// initialFiles with TypeScript (needs its own sandbox, cleaned up immediately)
// ---------------------------------------------------------------------------

describe("DaytonaSandbox TypeScript initialFiles", () => {
  let sandbox: DaytonaSandbox;

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

    sandbox = await DaytonaSandbox.create({
      language: "typescript",
      autoStopInterval: 5,
      labels: {
        purpose: "integration-test-typescript",
        package: "@langchain/daytona",
      },
      initialFiles: {
        "main.ts": tsCode,
      },
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    try {
      await sandbox?.close();
    } catch {
      // Ignore cleanup errors
    }
  }, TEST_TIMEOUT);

  it(
    "should create sandbox with TypeScript files and execute them",
    async () => {
      expect(sandbox.isRunning).toBe(true);

      // Execute the TypeScript file
      const result = await sandbox.execute("npx tsx main.ts");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Hello from initialFiles!");
      expect(result.output).toContain("User: Alice, Age: 30");
    },
    TEST_TIMEOUT,
  );
});
