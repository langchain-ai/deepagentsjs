import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeepwasmBackend } from "../src/backend.js";

/**
 * Integration tests for the full DeepwasmBackend → @wasmer/sdk → bash pipeline.
 *
 * These tests require network access (first run downloads bash from the Wasmer
 * registry) and a working @wasmer/sdk runtime. The suite is skipped automatically
 * if the SDK fails to initialize.
 *
 * Run with: pnpm test:int
 *
 * NOTE: The WASIX bash runtime (sharrattj/bash) returns exit code 45 for shell
 * builtins like `echo`, `pwd`, and `exit`. External commands like `cat` and `ls`
 * return standard exit codes. Tests are written to accommodate this behavior.
 */

// Probe whether the SDK can initialize before running any tests.
let sdkAvailable = true;
try {
  const probe = await DeepwasmBackend.create();
  await probe.execute("echo probe");
  probe.close();
} catch {
  sdkAvailable = false;
}

const describeIfSdk = sdkAvailable ? describe : describe.skip;

describeIfSdk("DeepwasmBackend integration", { timeout: 120_000 }, () => {
  let backend: DeepwasmBackend;

  beforeAll(async () => {
    backend = await DeepwasmBackend.create();
  }, 60_000);

  afterAll(() => {
    backend?.close();
  });

  it("executes echo and captures stdout", async () => {
    const result = await backend.execute("echo hello");
    expect(result.output).toContain("hello");
    expect(result.truncated).toBe(false);
  }, 15_000);

  it("captures non-zero exit codes for invalid commands", async () => {
    const result = await backend.execute("nonexistent_command_xyz_12345");
    expect(result.exitCode).not.toBe(0);
  }, 15_000);

  it("uploads a file and reads it back via cat", async () => {
    // Files uploaded to the in-memory FS at /path are mounted at /work/path
    const content = new TextEncoder().encode("integration test content");
    const uploadResults = await backend.uploadFiles([
      ["/testfile.txt", content],
    ]);
    expect(uploadResults[0].error).toBeNull();

    const result = await backend.execute("cat /work/testfile.txt");
    expect(result.output).toContain("integration test content");
    expect(result.exitCode).toBe(0);
  }, 15_000);

  it("writes a file via execute and downloads it", async () => {
    // Files written to /work/path in WASIX sync back to /path in the in-memory FS
    await backend.execute("echo downloaded_content > /work/out.txt");

    const downloadResults = await backend.downloadFiles(["/out.txt"]);
    expect(downloadResults).toHaveLength(1);
    expect(downloadResults[0].error).toBeNull();

    const text = new TextDecoder().decode(downloadResults[0].content!);
    expect(text.trim()).toBe("downloaded_content");
  }, 15_000);

  it("handles multi-command execution", async () => {
    const result = await backend.execute("echo aaa && echo bbb");
    expect(result.output).toContain("aaa");
    expect(result.output).toContain("bbb");
  }, 15_000);

  it("reports working directory with pwd", async () => {
    const result = await backend.execute("pwd");
    expect(result.output.trim()).toBeTruthy();
    // cwd is set to /work in the backend
    expect(result.output).toContain("/work");
  }, 15_000);

  it("captures stderr for errors", async () => {
    const result = await backend.execute("cat /nonexistent_file_xyz");
    expect(result.exitCode).not.toBe(0);
    // stderr is included in output
    expect(result.output).toBeTruthy();
  }, 15_000);

  it("persists file state across sequential executions", async () => {
    // First command writes a file — it syncs back to in-memory FS via syncDirectoryToFs
    await backend.execute("echo persistent_data > /work/persist.txt");

    // Second command reads it back — the in-memory FS re-mounts into the new instance
    const readResult = await backend.execute("cat /work/persist.txt");
    expect(readResult.output).toContain("persistent_data");
    expect(readResult.exitCode).toBe(0);
  }, 30_000);
});
