/**
 * Integration tests for LangSmith Sandbox.
 *
 * These tests require a valid LANGSMITH_API_KEY environment variable
 * and make real API calls to LangSmith.
 *
 * Run with: pnpm test:int
 */

import { describe, it, expect, afterAll } from "vitest";
import { LangSmithSandbox } from "./index.js";

describe.skipIf(!process.env.LANGSMITH_API_KEY)(
  "LangSmithSandbox integration",
  () => {
    let sandbox: LangSmithSandbox | null = null;

    // Increase timeout for integration tests
    const TIMEOUT = 180_000; // 3 minutes

    afterAll(async () => {
      await sandbox?.close();
    });

    it(
      "should create a sandbox",
      async () => {
        sandbox = await LangSmithSandbox.create({
          templateName: "deepagentsjs",
          timeout: 180,
        });

        expect(sandbox.id).toBeTruthy();
        expect(sandbox.name).toBeTruthy();
        expect(sandbox.isRunning).toBe(true);
      },
      TIMEOUT,
    );

    it(
      "should execute a command",
      async () => {
        if (!sandbox) {
          throw new Error("Sandbox not created");
        }

        const result = await sandbox.execute("python -c \"print('Hello from LangSmith!')\"");

        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("Hello from LangSmith!");
      },
      TIMEOUT,
    );

    it(
      "should check environment",
      async () => {
        if (!sandbox) {
          throw new Error("Sandbox not created");
        }

        const result = await sandbox.execute("python --version && pwd && ls -la");

        expect(result.exitCode).toBe(0);
        expect(result.output).toBeTruthy();
        expect(result.output).toContain("Python");
      },
      TIMEOUT,
    );

    it(
      "should write and read a file using Python",
      async () => {
        if (!sandbox) {
          throw new Error("Sandbox not created");
        }

        const filename = "test_python.txt";
        const content = "Hello from Python!";

        // Write a file using Python
        const writeResult = await sandbox.execute(
          `python -c "with open('${filename}', 'w') as f: f.write('${content}')"`,
        );
        expect(writeResult.exitCode).toBe(0);

        // Read the file back using Python
        const readResult = await sandbox.execute(
          `python -c "print(open('${filename}').read())"`,
        );
        expect(readResult.exitCode).toBe(0);
        expect(readResult.output.trim()).toBe(content);
      },
      TIMEOUT,
    );

    it(
      "should run a Python script",
      async () => {
        if (!sandbox) {
          throw new Error("Sandbox not created");
        }

        // Create a Python script using heredoc-style approach
        const writeResult = await sandbox.execute(
          `cat > script.py << 'EOF'
import sys
print(f"Python version: {sys.version}")
print("Script executed successfully!")
EOF`,
        );
        expect(writeResult.exitCode).toBe(0);

        const runResult = await sandbox.execute("python script.py");
        expect(runResult.exitCode).toBe(0);
        expect(runResult.output).toContain("Script executed successfully!");
      },
      TIMEOUT,
    );

    it(
      "should list sandboxes",
      async () => {
        const sandboxes = await LangSmithSandbox.list();

        expect(Array.isArray(sandboxes)).toBe(true);
        // Our sandbox should be in the list
        if (sandbox) {
          const found = sandboxes.find((s) => s.id === sandbox!.id);
          expect(found).toBeTruthy();
        }
      },
      TIMEOUT,
    );

    it(
      "should close the sandbox",
      async () => {
        if (!sandbox) {
          throw new Error("Sandbox not created");
        }

        await sandbox.close();
        expect(sandbox.isRunning).toBe(false);
        sandbox = null;
      },
      TIMEOUT,
    );
  },
);
