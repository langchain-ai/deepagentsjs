import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { LocalShellBackend } from "./local-shell.js";

function createTempDir(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "deepagents-shell-test-"));
}

async function removeDir(dirPath: string) {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore errors during cleanup
  }
}

describe("LocalShellBackend", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(async () => {
    await removeDir(tmpDir);
  });

  describe("initialization", () => {
    it("should initialize correctly with defaults", () => {
      const backend = new LocalShellBackend({ rootDir: tmpDir });

      expect(backend.id).toMatch(/^local-[0-9a-f]{8}$/);
      expect(backend.isInitialized).toBe(false);
    });

    it("should generate unique IDs", () => {
      const backend1 = new LocalShellBackend({ rootDir: tmpDir });
      const backend2 = new LocalShellBackend({ rootDir: tmpDir });

      expect(backend1.id).not.toBe(backend2.id);
    });

    it("should create rootDir on initialize()", async () => {
      const newDir = path.join(tmpDir, "nested", "subdir");
      const backend = new LocalShellBackend({ rootDir: newDir });

      expect(fsSync.existsSync(newDir)).toBe(false);

      await backend.initialize();

      expect(backend.isInitialized).toBe(true);
      expect(fsSync.existsSync(newDir)).toBe(true);
      expect(fsSync.statSync(newDir).isDirectory()).toBe(true);
    });

    it("should be safe to initialize when rootDir already exists", async () => {
      const backend = new LocalShellBackend({ rootDir: tmpDir });
      await backend.initialize();

      expect(backend.isInitialized).toBe(true);
    });

    it("should throw on double initialization", async () => {
      const backend = new LocalShellBackend({ rootDir: tmpDir });
      await backend.initialize();

      await expect(backend.initialize()).rejects.toThrow("already initialized");
    });

    it("should create and initialize via static create()", async () => {
      const newDir = path.join(tmpDir, "via-create");
      const backend = await LocalShellBackend.create({ rootDir: newDir });

      expect(backend.isInitialized).toBe(true);
      expect(fsSync.existsSync(newDir)).toBe(true);
    });

    it("should expose isRunning as alias for isInitialized", async () => {
      const backend = new LocalShellBackend({ rootDir: tmpDir });
      expect(backend.isRunning).toBe(false);

      await backend.initialize();
      expect(backend.isRunning).toBe(true);
    });

    it("should set isRunning to false after close()", async () => {
      const backend = await LocalShellBackend.create({ rootDir: tmpDir });
      expect(backend.isRunning).toBe(true);

      await backend.close();
      expect(backend.isRunning).toBe(false);
      expect(backend.isInitialized).toBe(false);
    });
  });

  describe("execute", () => {
    it("should execute a simple command", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        inheritEnv: true,
      });

      const result = await backend.execute("echo 'Hello World'");

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Hello World");
      expect(result.truncated).toBe(false);
    });

    it("should handle failing commands", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        inheritEnv: true,
      });

      const result = await backend.execute("cat nonexistent_file.txt");

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("[stderr]");
      expect(result.output).toContain("Exit code:");
    });

    it("should execute in the specified working directory", async () => {
      fsSync.writeFileSync(path.join(tmpDir, "test.txt"), "test content");

      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        inheritEnv: true,
      });

      const result = await backend.execute("cat test.txt");

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("test content");
    });

    it("should return an error for empty command", async () => {
      const backend = new LocalShellBackend({ rootDir: tmpDir });

      const result = await backend.execute("");

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("must be a non-empty string");
    });

    it("should timeout long-running commands", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        timeout: 1,
        inheritEnv: true,
      });

      const result = await backend.execute("sleep 5");

      expect(result.exitCode).toBe(124);
      expect(result.output).toContain("timed out");
    });

    it("should truncate large output", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        maxOutputBytes: 100,
        inheritEnv: true,
      });

      const result = await backend.execute("seq 1 1000");

      expect(result.truncated).toBe(true);
      expect(result.output).toContain("Output truncated");
    });

    it("should prefix stderr lines with [stderr]", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        inheritEnv: true,
      });

      const result = await backend.execute("echo 'error message' >&2");

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("[stderr]");
      expect(result.output).toContain("error message");
    });
  });

  describe("environment variables", () => {
    it("should pass custom environment variables to commands", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        env: { CUSTOM_VAR: "custom_value", PATH: process.env.PATH ?? "" },
      });

      const result = await backend.execute(
        'node -e "process.stdout.write(process.env.CUSTOM_VAR || \\"\\")"',
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("custom_value");
    });

    it("should inherit parent environment when inheritEnv is true", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        inheritEnv: true,
      });

      const result = await backend.execute(
        'node -e "process.stdout.write(process.env.PATH || \\"\\")"',
      );

      expect(result.exitCode).toBe(0);
      expect(result.output.trim().length).toBeGreaterThan(0);
    });

    it("should start with empty environment by default", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        env: { PATH: process.env.PATH ?? "" },
      });

      const result = await backend.execute(
        "node -e \"process.stdout.write('CUSTOM_VAR is: ' + (process.env.CUSTOM_VAR || ''))\"",
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("CUSTOM_VAR is: ");
      expect(result.output).not.toContain("CUSTOM_VAR is: something");
    });
  });

  describe("filesystem integration", () => {
    it("should work alongside inherited filesystem operations", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        virtualMode: true,
      });

      const writeResult = await backend.write("/test.txt", "Hello\nWorld\n");
      expect(writeResult.error).toBeUndefined();
      expect(writeResult.path).toBe("/test.txt");

      const content = await backend.read("/test.txt");
      expect(content).toContain("Hello");
      expect(content).toContain("World");

      const editResult = await backend.edit("/test.txt", "World", "Universe");
      expect(editResult.error).toBeUndefined();
      expect(editResult.occurrences).toBe(1);

      const updated = await backend.read("/test.txt");
      expect(updated).toContain("Universe");
      expect(updated).not.toContain("World");
    });

    it("should allow shell and filesystem operations together", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        virtualMode: true,
        inheritEnv: true,
      });

      await backend.write("/script.sh", "#!/bin/bash\necho 'Script output'");

      await backend.execute("chmod +x script.sh");
      const result = await backend.execute("bash script.sh");

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Script output");

      await backend.execute("echo 'Shell created' > shell_file.txt");

      const content = await backend.read("/shell_file.txt");
      expect(content).toContain("Shell created");
    });

    it("should list directory contents", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        virtualMode: true,
      });

      await backend.write("/file1.txt", "content1");
      await backend.write("/file2.txt", "content2");

      const files = await backend.lsInfo("/");

      expect(files.length).toBe(2);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("/file1.txt");
      expect(paths).toContain("/file2.txt");
    });

    it("should support grep", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        virtualMode: true,
      });

      await backend.write("/file1.txt", "TODO: implement this");
      await backend.write("/file2.txt", "DONE: completed");

      const matches = await backend.grepRaw("TODO");

      expect(Array.isArray(matches)).toBe(true);
      expect((matches as Array<{ text: string }>).length).toBe(1);
      expect((matches as Array<{ text: string }>)[0].text).toBe(
        "TODO: implement this",
      );
    });

    it("should support glob", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        virtualMode: true,
      });

      await backend.write("/file1.txt", "content");
      await backend.write("/file2.py", "content");
      await backend.write("/file3.txt", "content");

      const txtFiles = await backend.globInfo("*.txt");

      expect(txtFiles.length).toBe(2);
      const paths = txtFiles.map((f) => f.path);
      expect(paths).toContain("/file1.txt");
      expect(paths).toContain("/file3.txt");
      expect(paths).not.toContain("/file2.py");
    });
  });

  describe("virtual mode", () => {
    it("should restrict filesystem paths but not shell commands", async () => {
      const backend = new LocalShellBackend({
        rootDir: tmpDir,
        virtualMode: true,
      });

      const content = await backend.read("/../etc/passwd");
      expect(content).toContain("Error");

      const result = await backend.execute("cat /etc/passwd");
      expect(result).toBeDefined();
      expect(typeof result.exitCode).toBe("number");
    });
  });
});
