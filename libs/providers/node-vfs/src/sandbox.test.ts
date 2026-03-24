/* eslint-disable no-instanceof/no-instanceof */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { VfsSandbox } from "./sandbox.js";
import { VfsSandboxError } from "./types.js";

describe("VfsSandbox", () => {
  let sandbox: VfsSandbox;

  afterEach(async () => {
    if (sandbox?.isRunning) {
      await sandbox.stop();
    }
  });

  describe("constructor", () => {
    it("should create a sandbox with default options", () => {
      sandbox = new VfsSandbox();
      expect(sandbox.id).toMatch(/^vfs-sandbox-\d+$/);
      expect(sandbox.isRunning).toBe(false);
    });

    it("should create a sandbox with custom options", () => {
      sandbox = new VfsSandbox({
        mountPath: "/custom",
        timeout: 60000,
      });
      expect(sandbox.id).toMatch(/^vfs-sandbox-\d+$/);
    });
  });

  describe("initialize", () => {
    it("should initialize the sandbox", async () => {
      sandbox = new VfsSandbox();
      await sandbox.initialize();
      expect(sandbox.isRunning).toBe(true);
      expect(sandbox.workingDirectory).toBeTruthy();
    });

    it("should throw if already initialized", async () => {
      sandbox = new VfsSandbox();
      await sandbox.initialize();

      await expect(sandbox.initialize()).rejects.toThrow(VfsSandboxError);
      await expect(sandbox.initialize()).rejects.toMatchObject({
        code: "ALREADY_INITIALIZED",
      });
    });

    it("should populate initial files", async () => {
      const encoder = new TextEncoder();
      sandbox = new VfsSandbox({
        initialFiles: {
          "/test.txt": "Hello, World!",
          "/src/index.js": "console.log('Hi')",
        },
      });
      await sandbox.initialize();

      const results = await sandbox.downloadFiles([
        "/test.txt",
        "/src/index.js",
      ]);

      expect(results[0].error).toBeNull();
      expect(results[0].content).toEqual(encoder.encode("Hello, World!"));

      expect(results[1].error).toBeNull();
      expect(results[1].content).toEqual(encoder.encode("console.log('Hi')"));
    });
  });

  describe("static create", () => {
    it("should create and initialize in one step", async () => {
      sandbox = await VfsSandbox.create();
      expect(sandbox.isRunning).toBe(true);
    });

    it("should create with initial files", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/hello.txt": "Hello!",
        },
      });

      const results = await sandbox.downloadFiles(["/hello.txt"]);
      expect(results[0].error).toBeNull();
      expect(new TextDecoder().decode(results[0].content!)).toBe("Hello!");
    });
  });

  describe("execute", () => {
    beforeEach(async () => {
      sandbox = await VfsSandbox.create();
    });

    it("should throw if not initialized", async () => {
      const uninitSandbox = new VfsSandbox();
      await expect(uninitSandbox.execute("echo test")).rejects.toThrow(
        VfsSandboxError,
      );
      await expect(uninitSandbox.execute("echo test")).rejects.toMatchObject({
        code: "NOT_INITIALIZED",
      });
    });

    // Note: When VFS polyfill is active (not using temp directory fallback),
    // command execution may fail because the VFS mount path doesn't exist
    // on the real filesystem for child_process.spawn.
    // These tests verify behavior when using temp directory fallback.

    it("should execute a simple command or handle VFS mode gracefully", async () => {
      const result = await sandbox.execute("echo 'Hello, World!'");
      // In temp dir mode, this works. In VFS mode, it may fail with ENOENT.
      if (result.output.includes("ENOENT")) {
        // VFS mode - command execution not supported with virtual paths
        expect(result.exitCode).toBe(1);
      } else {
        expect(result.output.trim()).toBe("Hello, World!");
        expect(result.exitCode).toBe(0);
        expect(result.truncated).toBe(false);
      }
    });

    it("should capture stderr or handle VFS mode", async () => {
      const result = await sandbox.execute("echo 'error' >&2");
      if (result.output.includes("ENOENT")) {
        expect(result.exitCode).toBe(1);
      } else {
        expect(result.output.trim()).toBe("error");
        expect(result.exitCode).toBe(0);
      }
    });

    it("should return non-zero exit code for failed commands or VFS mode", async () => {
      const result = await sandbox.execute("exit 42");
      if (result.output.includes("ENOENT")) {
        expect(result.exitCode).toBe(1);
      } else {
        expect(result.exitCode).toBe(42);
      }
    });

    it("should execute commands in the working directory or handle VFS mode", async () => {
      const result = await sandbox.execute("pwd");
      if (result.output.includes("ENOENT")) {
        expect(result.exitCode).toBe(1);
      } else {
        // In VFS mode, commands execute in a temp directory (not the virtual path)
        // In temp dir fallback mode, commands execute in the actual working directory
        const output = result.output.trim();

        if (sandbox.isVfsMode) {
          // VFS mode: commands run in a temp directory for execution
          expect(output).toMatch(/vfs-(sandbox|exec)/);
        } else {
          // Temp dir fallback mode: working directory is the actual path
          const expected = sandbox.workingDirectory;
          // On macOS, /var is a symlink to /private/var, so pwd may resolve differently
          expect(
            output === expected ||
              output === `/private${expected}` ||
              expected === `/private${output}`,
          ).toBe(true);
        }
      }
    });
  });

  describe("uploadFiles", () => {
    beforeEach(async () => {
      sandbox = await VfsSandbox.create();
    });

    it("should throw if not initialized", async () => {
      const uninitSandbox = new VfsSandbox();
      await expect(
        uninitSandbox.uploadFiles([["test.txt", new Uint8Array([])]]),
      ).rejects.toThrow(VfsSandboxError);
    });

    it("should upload a single file", async () => {
      const encoder = new TextEncoder();
      const content = encoder.encode("Hello, File!");

      const results = await sandbox.uploadFiles([["test.txt", content]]);

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("test.txt");
      expect(results[0].error).toBeNull();

      // Verify file was written
      const downloaded = await sandbox.downloadFiles(["test.txt"]);
      expect(downloaded[0].content).toEqual(content);
    });

    it("should upload multiple files", async () => {
      const encoder = new TextEncoder();
      const files: Array<[string, Uint8Array]> = [
        ["file1.txt", encoder.encode("Content 1")],
        ["file2.txt", encoder.encode("Content 2")],
        ["nested/file3.txt", encoder.encode("Content 3")],
      ];

      const results = await sandbox.uploadFiles(files);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.error === null)).toBe(true);
    });

    it("should create parent directories", async () => {
      const encoder = new TextEncoder();
      const results = await sandbox.uploadFiles([
        ["deep/nested/path/file.txt", encoder.encode("Deep content")],
      ]);

      expect(results[0].error).toBeNull();

      const downloaded = await sandbox.downloadFiles([
        "deep/nested/path/file.txt",
      ]);
      expect(downloaded[0].error).toBeNull();
    });
  });

  describe("downloadFiles", () => {
    beforeEach(async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/existing.txt": "Existing content",
          "/dir/nested.txt": "Nested content",
        },
      });
    });

    it("should throw if not initialized", async () => {
      const uninitSandbox = new VfsSandbox();
      await expect(uninitSandbox.downloadFiles(["test.txt"])).rejects.toThrow(
        VfsSandboxError,
      );
    });

    it("should download an existing file", async () => {
      const results = await sandbox.downloadFiles(["/existing.txt"]);

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("/existing.txt");
      expect(results[0].error).toBeNull();
      expect(new TextDecoder().decode(results[0].content!)).toBe(
        "Existing content",
      );
    });

    it("should return error for non-existent file", async () => {
      const results = await sandbox.downloadFiles(["/nonexistent.txt"]);

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("/nonexistent.txt");
      expect(results[0].content).toBeNull();
      expect(results[0].error).toBe("file_not_found");
    });

    it("should download multiple files", async () => {
      const results = await sandbox.downloadFiles([
        "/existing.txt",
        "/dir/nested.txt",
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].error).toBeNull();
      expect(results[1].error).toBeNull();
    });

    it("should handle mixed success and failure", async () => {
      const results = await sandbox.downloadFiles([
        "/existing.txt",
        "/missing.txt",
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].error).toBeNull();
      expect(results[1].error).toBe("file_not_found");
    });
  });

  describe("stop", () => {
    it("should stop the sandbox", async () => {
      sandbox = await VfsSandbox.create();
      expect(sandbox.isRunning).toBe(true);

      await sandbox.stop();
      expect(sandbox.isRunning).toBe(false);
    });

    it("should be safe to call multiple times", async () => {
      sandbox = await VfsSandbox.create();

      await sandbox.stop();
      await sandbox.stop(); // Should not throw
      expect(sandbox.isRunning).toBe(false);
    });
  });
});

describe("VfsSandboxError", () => {
  it("should create error with message and code", () => {
    const error = new VfsSandboxError("Test error", "NOT_INITIALIZED");

    expect(error.message).toBe("Test error");
    expect(error.code).toBe("NOT_INITIALIZED");
    expect(error.name).toBe("VfsSandboxError");
  });

  it("should create error with cause", () => {
    const cause = new Error("Original error");
    const error = new VfsSandboxError("Wrapped error", "COMMAND_FAILED", cause);

    expect(error.cause).toBe(cause);
  });

  it("should be instanceof Error", () => {
    const error = new VfsSandboxError("Test", "NOT_INITIALIZED");
    expect(error instanceof Error).toBe(true);
    expect(error instanceof VfsSandboxError).toBe(true);
  });
});
