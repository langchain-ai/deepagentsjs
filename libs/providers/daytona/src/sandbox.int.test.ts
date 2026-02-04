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
    // Skip if no API key is configured
    if (!process.env.DAYTONA_API_KEY) {
      console.log("Skipping integration tests: DAYTONA_API_KEY not set");
      return;
    }

    // Create sandbox with reasonable defaults for testing
    sandbox = await DaytonaSandbox.create({
      language: "typescript",
      autoStopInterval: 5, // Auto-stop after 5 minutes of inactivity
      labels: {
        purpose: "integration-test",
        package: "@langchain/daytona",
      },
    });

    console.log(`Created sandbox: ${sandbox.id}`);
  });

  afterAll(async () => {
    if (sandbox) {
      try {
        await sandbox.close();
        console.log(`Deleted sandbox: ${sandbox.id}`);
      } catch (error) {
        console.error("Failed to cleanup sandbox:", error);
      }
    }
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
