/**
 * Integration tests for DaytonaSandbox.
 *
 * These tests require a valid DAYTONA_API_KEY environment variable.
 * Run with: pnpm test:int
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DaytonaSandbox } from "./index.js";

describe("DaytonaSandbox Integration Tests", () => {
  let sandbox: DaytonaSandbox;

  beforeAll(async () => {
    // Create sandbox with reasonable defaults for testing
    sandbox = await DaytonaSandbox.create({
      language: "typescript",
      autoStopInterval: 5, // Auto-stop after 5 minutes of inactivity
      labels: {
        purpose: "integration-test",
        package: "@langchain/daytona",
      },
    });
  });

  afterAll(async () => {
    await sandbox?.close();
  });

  it("should create and initialize sandbox", async () => {
    if (!sandbox) return;

    expect(sandbox.isRunning).toBe(true);
    expect(sandbox.id).toBeTruthy();
  });

  it("should execute simple command", async () => {
    if (!sandbox) return;

    const result = await sandbox.execute('echo "Hello from Daytona!"');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Hello from Daytona!");
  });

  it("should execute node command", async () => {
    if (!sandbox) return;

    const result = await sandbox.execute("node --version");

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/v\d+\.\d+\.\d+/);
  });

  it("should upload and download files", async () => {
    if (!sandbox) return;

    const encoder = new TextEncoder();
    const testContent = "Hello, Daytona Sandbox!";

    // Upload file
    const uploadResults = await sandbox.uploadFiles([
      ["test-file.txt", encoder.encode(testContent)],
    ]);

    expect(uploadResults[0].error).toBeNull();

    // Verify file exists
    const lsResult = await sandbox.execute("ls -la test-file.txt");
    expect(lsResult.exitCode).toBe(0);

    // Download file
    const downloadResults = await sandbox.downloadFiles(["test-file.txt"]);

    expect(downloadResults[0].error).toBeNull();
    expect(downloadResults[0].content).toBeTruthy();

    const downloadedContent = new TextDecoder().decode(
      downloadResults[0].content!,
    );
    expect(downloadedContent).toBe(testContent);
  });

  it("should handle file in subdirectory", async () => {
    if (!sandbox) return;

    const encoder = new TextEncoder();

    // Upload file to subdirectory
    const uploadResults = await sandbox.uploadFiles([
      ["subdir/nested/file.txt", encoder.encode("nested content")],
    ]);

    expect(uploadResults[0].error).toBeNull();

    // Verify file exists
    const result = await sandbox.execute("cat subdir/nested/file.txt");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("nested content");
  });

  it("should run TypeScript code", async () => {
    if (!sandbox) return;

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
  });

  it("should get working directory", async () => {
    if (!sandbox) return;

    const workDir = await sandbox.getWorkDir();

    expect(workDir).toBeTruthy();
    expect(typeof workDir).toBe("string");
  });

  it("should get user home directory", async () => {
    if (!sandbox) return;

    const homeDir = await sandbox.getUserHomeDir();

    expect(homeDir).toBeTruthy();
    expect(typeof homeDir).toBe("string");
  });

  it("should handle command errors gracefully", async () => {
    if (!sandbox) return;

    const result = await sandbox.execute("nonexistent-command-12345");

    expect(result.exitCode).not.toBe(0);
  });

  it("should handle file not found gracefully", async () => {
    if (!sandbox) return;

    const results = await sandbox.downloadFiles(["nonexistent-file-12345.txt"]);

    expect(results[0].content).toBeNull();
    expect(results[0].error).toBe("file_not_found");
  });

  it("should use inherited BaseSandbox methods", async () => {
    if (!sandbox) return;

    // Test read method (inherited from BaseSandbox)
    const encoder = new TextEncoder();
    await sandbox.uploadFiles([
      ["readable.txt", encoder.encode("Line 1\nLine 2\nLine 3\n")],
    ]);

    const content = await sandbox.read("readable.txt");
    expect(content).toContain("Line 1");
    expect(content).toContain("Line 2");

    // Test write method (inherited from BaseSandbox)
    const writeResult = await sandbox.write(
      "new-file.txt",
      "Created with write()",
    );
    expect(writeResult.error).toBeUndefined();

    // Verify the file was created
    const readBack = await sandbox.execute("cat new-file.txt");
    expect(readBack.output).toContain("Created with write()");
  });
});

describe("DaytonaSandbox initialFiles Integration Tests", () => {
  it("should create sandbox with initial files", async () => {
    const sandbox = await DaytonaSandbox.create({
      language: "typescript",
      autoStopInterval: 5,
      labels: {
        purpose: "integration-test-initial-files",
        package: "@langchain/daytona",
      },
      initialFiles: {
        "app/index.js": "console.log('Hello from initial file');",
        "app/package.json": '{"name": "test-app", "version": "1.0.0"}',
      },
    });

    try {
      expect(sandbox.isRunning).toBe(true);

      // Verify index.js exists and has correct content
      const indexResult = await sandbox.execute("cat app/index.js");
      expect(indexResult.exitCode).toBe(0);
      expect(indexResult.output).toContain("Hello from initial file");

      // Verify package.json exists and has correct content
      const packageResult = await sandbox.execute("cat app/package.json");
      expect(packageResult.exitCode).toBe(0);
      expect(packageResult.output).toContain("test-app");
      expect(packageResult.output).toContain("1.0.0");

      // Verify we can execute the JavaScript file
      const execResult = await sandbox.execute("node app/index.js");
      expect(execResult.exitCode).toBe(0);
      expect(execResult.output).toContain("Hello from initial file");
    } finally {
      await sandbox.close();
    }
  });

  it("should create sandbox with deeply nested initial files", async () => {
    const sandbox = await DaytonaSandbox.create({
      language: "typescript",
      autoStopInterval: 5,
      labels: {
        purpose: "integration-test-nested-files",
        package: "@langchain/daytona",
      },
      initialFiles: {
        "src/components/Button/index.tsx":
          "export const Button = () => <button>Click</button>;",
        "src/utils/helpers/string.ts":
          "export const capitalize = (s: string) => s.toUpperCase();",
      },
    });

    try {
      expect(sandbox.isRunning).toBe(true);

      // Verify nested directory structure was created
      const lsResult = await sandbox.execute("find src -type f");
      expect(lsResult.exitCode).toBe(0);
      expect(lsResult.output).toContain("src/components/Button/index.tsx");
      expect(lsResult.output).toContain("src/utils/helpers/string.ts");

      // Verify file contents
      const buttonContent = await sandbox.execute(
        "cat src/components/Button/index.tsx",
      );
      expect(buttonContent.output).toContain("Button");

      const helperContent = await sandbox.execute(
        "cat src/utils/helpers/string.ts",
      );
      expect(helperContent.output).toContain("capitalize");
    } finally {
      await sandbox.close();
    }
  });

  it("should create sandbox with empty initialFiles object", async () => {
    const sandbox = await DaytonaSandbox.create({
      language: "typescript",
      autoStopInterval: 5,
      labels: {
        purpose: "integration-test-empty-files",
        package: "@langchain/daytona",
      },
      initialFiles: {},
    });

    try {
      expect(sandbox.isRunning).toBe(true);

      // Sandbox should work normally
      const result = await sandbox.execute('echo "Works!"');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Works!");
    } finally {
      await sandbox.close();
    }
  });

  it("should create sandbox with TypeScript files and execute them", async () => {
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

    const sandbox = await DaytonaSandbox.create({
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

    try {
      expect(sandbox.isRunning).toBe(true);

      // Execute the TypeScript file
      const result = await sandbox.execute("npx tsx main.ts");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Hello from initialFiles!");
      expect(result.output).toContain("User: Alice, Age: 30");
    } finally {
      await sandbox.close();
    }
  });
});
