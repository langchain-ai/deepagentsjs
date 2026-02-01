/**
 * Unit tests for VercelSandbox class.
 *
 * Uses mocked @vercel/sandbox SDK for fast, isolated testing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VercelSandboxError } from "./types.js";

// ============================================================================
// Mock State
// ============================================================================

// Track mock state for assertions
const mockState = {
  sandboxInstance: null as MockSandboxType | null,
  createCalls: [] as Array<{
    runtime?: string;
    timeout?: number;
    token?: string;
    source?: unknown;
    ports?: number[];
    resources?: { vcpus?: number };
  }>,
  getCalls: [] as Array<{ sandboxId: string; token?: string }>,
};

// Type for mock sandbox instance
interface MockSandboxType {
  sandboxId: string;
  status: string;
  files: Map<string, Buffer>;
  nextCommandResult: { stdout: string; stderr: string; exitCode: number };
  shouldFailWriteFiles: boolean;
  shouldFailReadFile: boolean;
  shouldFailSnapshot: boolean;
  shouldFailStop: boolean;
  setNextCommandResult: (
    stdout: string,
    stderr: string,
    exitCode: number,
  ) => void;
  addFile: (path: string, content: Buffer | string) => void;
  runCommand: (options: {
    cmd: string;
    args: string[];
    cwd?: string;
  }) => Promise<{
    stdout: () => Promise<string>;
    stderr: () => Promise<string>;
    exitCode: number;
  }>;
  writeFiles: (
    files: Array<{ path: string; content: Buffer }>,
  ) => Promise<void>;
  readFileToBuffer: (options: { path: string }) => Promise<Buffer | null>;
  domain: (port: number) => string;
  extendTimeout: (duration: number) => Promise<void>;
  snapshot: () => Promise<{
    snapshotId: string;
    sourceSandboxId: string;
    status: "created" | "deleted" | "failed";
    sizeBytes: number;
    createdAt: Date;
    expiresAt: Date;
  }>;
  stop: () => Promise<void>;
}

// Mock auth module to avoid env var issues in tests
vi.mock("./auth.js", () => ({
  getAuthToken: vi.fn(() => "mock-auth-token"),
}));

// Mock the @vercel/sandbox module with factory
vi.mock("@vercel/sandbox", () => {
  /**
   * Mock Sandbox class that simulates the Vercel SDK behavior.
   */
  class MockSandbox {
    sandboxId: string;
    status: string = "running";

    // Mock file storage
    files: Map<string, Buffer> = new Map();

    // Command execution configuration
    nextCommandResult: {
      stdout: string;
      stderr: string;
      exitCode: number;
    } = {
      stdout: "",
      stderr: "",
      exitCode: 0,
    };

    // Error simulation flags
    shouldFailWriteFiles = false;
    shouldFailReadFile = false;
    shouldFailSnapshot = false;
    shouldFailStop = false;

    constructor(sandboxId: string = "sandbox-mock-123") {
      this.sandboxId = sandboxId;
    }

    // Configure next command result
    setNextCommandResult(stdout: string, stderr: string, exitCode: number) {
      this.nextCommandResult = { stdout, stderr, exitCode };
    }

    // Add file to mock filesystem
    addFile(path: string, content: Buffer | string) {
      const buffer =
        typeof content === "string" ? Buffer.from(content) : content;
      this.files.set(path, buffer);
    }

    // SDK methods
    async runCommand(_options: {
      cmd: string;
      args: string[];
      cwd?: string;
    }): Promise<{
      stdout: () => Promise<string>;
      stderr: () => Promise<string>;
      exitCode: number;
    }> {
      const result = { ...this.nextCommandResult };
      return {
        stdout: async () => result.stdout,
        stderr: async () => result.stderr,
        exitCode: result.exitCode,
      };
    }

    async writeFiles(
      files: Array<{ path: string; content: Buffer }>,
    ): Promise<void> {
      if (this.shouldFailWriteFiles) {
        throw new Error("Write operation failed: permission denied");
      }
      for (const file of files) {
        this.files.set(file.path, file.content);
      }
    }

    async readFileToBuffer(options: { path: string }): Promise<Buffer | null> {
      if (this.shouldFailReadFile) {
        throw new Error("Read operation failed: ENOENT not found");
      }
      return this.files.get(options.path) ?? null;
    }

    domain(port: number): string {
      return `https://${this.sandboxId}-${port}.vercel.app`;
    }

    async extendTimeout(_duration: number): Promise<void> {
      // No-op in mock
    }

    async snapshot(): Promise<{
      snapshotId: string;
      sourceSandboxId: string;
      status: "created" | "deleted" | "failed";
      sizeBytes: number;
      createdAt: Date;
      expiresAt: Date;
    }> {
      if (this.shouldFailSnapshot) {
        throw new Error("Snapshot creation failed");
      }
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
      return {
        snapshotId: "snap-mock-456",
        sourceSandboxId: this.sandboxId,
        status: "created",
        sizeBytes: 1024 * 1024 * 100, // 100MB
        createdAt: now,
        expiresAt,
      };
    }

    async stop(): Promise<void> {
      if (this.shouldFailStop) {
        throw new Error("Failed to stop sandbox");
      }
      this.status = "stopped";
    }

    // Static factory methods
    static async create(options?: {
      runtime?: string;
      timeout?: number;
      token?: string;
      source?: unknown;
      ports?: number[];
      resources?: { vcpus?: number };
    }): Promise<MockSandbox> {
      mockState.createCalls.push(options || {});
      mockState.sandboxInstance =
        new MockSandbox() as unknown as MockSandboxType;
      return mockState.sandboxInstance as unknown as MockSandbox;
    }

    static async get(options: {
      sandboxId: string;
      token?: string;
    }): Promise<MockSandbox> {
      mockState.getCalls.push(options);
      mockState.sandboxInstance = new MockSandbox(
        options.sandboxId,
      ) as unknown as MockSandboxType;
      return mockState.sandboxInstance as unknown as MockSandbox;
    }
  }

  return {
    Sandbox: MockSandbox,
  };
});

// Import after mocks are set up
import {
  VercelSandbox,
  createVercelSandboxFactory,
  createVercelSandboxFactoryFromSandbox,
} from "./sandbox.js";

// ============================================================================
// Tests
// ============================================================================

describe("VercelSandbox", () => {
  beforeEach(() => {
    // Reset mock state
    mockState.sandboxInstance = null;
    mockState.createCalls = [];
    mockState.getCalls = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Task F3: Test VercelSandbox initialization
  // ==========================================================================

  describe("constructor", () => {
    it("should set default options", () => {
      const sandbox = new VercelSandbox();

      // ID should be generated with prefix
      expect(sandbox.id).toMatch(/^vercel-sandbox-\d+$/);

      // isRunning should be false before initialization
      expect(sandbox.isRunning).toBe(false);
    });

    it("should accept custom options", () => {
      const sandbox = new VercelSandbox({
        runtime: "python3.13",
        timeout: 600000,
        ports: [3000, 8080],
      });

      expect(sandbox.id).toMatch(/^vercel-sandbox-\d+$/);
      expect(sandbox.isRunning).toBe(false);
    });
  });

  describe("initialize", () => {
    it("should create sandbox via SDK", async () => {
      const sandbox = new VercelSandbox({
        runtime: "node24",
        timeout: 300000,
      });

      await sandbox.initialize();

      expect(mockState.createCalls.length).toBe(1);
      expect(mockState.createCalls[0].runtime).toBe("node24");
      expect(mockState.createCalls[0].timeout).toBe(300000);
      expect(mockState.createCalls[0].token).toBe("mock-auth-token");
    });

    it("should update id after initialization", async () => {
      const sandbox = new VercelSandbox();
      const initialId = sandbox.id;

      await sandbox.initialize();

      expect(sandbox.id).toBe("sandbox-mock-123");
      expect(sandbox.id).not.toBe(initialId);
    });

    it("should pass source configuration to SDK", async () => {
      const sandbox = new VercelSandbox({
        source: {
          type: "git",
          url: "https://github.com/test/repo.git",
          depth: 1,
        },
      });

      await sandbox.initialize();

      expect(mockState.createCalls[0].source).toEqual({
        type: "git",
        url: "https://github.com/test/repo.git",
        depth: 1,
      });
    });

    it("should pass ports configuration to SDK", async () => {
      const sandbox = new VercelSandbox({
        ports: [3000, 8080],
      });

      await sandbox.initialize();

      expect(mockState.createCalls[0].ports).toEqual([3000, 8080]);
    });

    it("should pass vcpus configuration to SDK", async () => {
      const sandbox = new VercelSandbox({
        vcpus: 4,
      });

      await sandbox.initialize();

      expect(mockState.createCalls[0].resources).toEqual({ vcpus: 4 });
    });

    it("should throw if already initialized", async () => {
      const sandbox = new VercelSandbox();
      await sandbox.initialize();

      await expect(sandbox.initialize()).rejects.toThrow(VercelSandboxError);
      await expect(sandbox.initialize()).rejects.toMatchObject({
        code: "ALREADY_INITIALIZED",
      });
    });

    it("should set isRunning to true after initialization", async () => {
      const sandbox = new VercelSandbox();
      expect(sandbox.isRunning).toBe(false);

      await sandbox.initialize();

      expect(sandbox.isRunning).toBe(true);
    });
  });

  describe("sandbox getter", () => {
    it("should throw if not initialized", () => {
      const sandbox = new VercelSandbox();

      expect(() => sandbox.sandbox).toThrow(VercelSandboxError);
      expect(() => sandbox.sandbox).toThrow("not initialized");
    });

    it("should return sandbox instance after initialization", async () => {
      const sandbox = new VercelSandbox();
      await sandbox.initialize();

      const sdkSandbox = sandbox.sandbox;
      expect(sdkSandbox).toBeDefined();
      expect(sdkSandbox.sandboxId).toBe("sandbox-mock-123");
    });
  });

  describe("static create", () => {
    it("should create and initialize sandbox in one step", async () => {
      const sandbox = await VercelSandbox.create({
        runtime: "node22",
        timeout: 600000,
      });

      expect(sandbox.isRunning).toBe(true);
      expect(sandbox.id).toBe("sandbox-mock-123");
      expect(mockState.createCalls.length).toBe(1);
    });

    it("should work with default options", async () => {
      const sandbox = await VercelSandbox.create();

      expect(sandbox.isRunning).toBe(true);
      expect(mockState.createCalls[0].runtime).toBe("node24");
      expect(mockState.createCalls[0].timeout).toBe(300000);
    });
  });

  describe("static get", () => {
    it("should reconnect to existing sandbox by ID", async () => {
      const sandbox = await VercelSandbox.get("existing-sandbox-id");

      expect(sandbox.id).toBe("existing-sandbox-id");
      expect(sandbox.isRunning).toBe(true);
      expect(mockState.getCalls.length).toBe(1);
      expect(mockState.getCalls[0].sandboxId).toBe("existing-sandbox-id");
    });

    it("should use auth token when reconnecting", async () => {
      await VercelSandbox.get("sandbox-id", {
        auth: { type: "oidc", token: "my-token" },
      });

      expect(mockState.getCalls[0].token).toBe("mock-auth-token");
    });
  });

  // ==========================================================================
  // Task F4: Test command execution
  // ==========================================================================

  describe("execute", () => {
    it("should call SDK with correct command format", async () => {
      const sandbox = await VercelSandbox.create();

      // Spy on runCommand
      const runCommandSpy = vi.spyOn(mockState.sandboxInstance!, "runCommand");

      await sandbox.execute("echo hello");

      expect(runCommandSpy).toHaveBeenCalledWith({
        cmd: "/bin/bash",
        args: ["-c", "echo hello"],
        cwd: "/vercel/sandbox",
      });
    });

    it("should return combined stdout and stderr", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("output", "error", 0);

      const result = await sandbox.execute("test command");

      expect(result.output).toBe("outputerror");
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it("should capture exit code correctly", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("", "command failed", 1);

      const result = await sandbox.execute("failing command");

      expect(result.exitCode).toBe(1);
    });

    it("should return stdout only when no stderr", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("hello world\n", "", 0);

      const result = await sandbox.execute("echo 'hello world'");

      expect(result.output).toBe("hello world\n");
    });

    it("should throw if not initialized", async () => {
      const sandbox = new VercelSandbox();

      await expect(sandbox.execute("echo test")).rejects.toThrow(
        VercelSandboxError,
      );
      await expect(sandbox.execute("echo test")).rejects.toMatchObject({
        code: "NOT_INITIALIZED",
      });
    });

    it("should handle complex commands", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("result", "", 0);

      const result = await sandbox.execute(
        "cd /app && npm install && npm run build",
      );

      expect(result.exitCode).toBe(0);
    });
  });

  // ==========================================================================
  // Task F5: Test file operations
  // ==========================================================================

  describe("uploadFiles", () => {
    it("should convert Uint8Array to Buffer", async () => {
      const sandbox = await VercelSandbox.create();
      const writeFilesSpy = vi.spyOn(mockState.sandboxInstance!, "writeFiles");

      const content = new TextEncoder().encode("file content");
      await sandbox.uploadFiles([["test.txt", content]]);

      expect(writeFilesSpy).toHaveBeenCalled();
      const call = writeFilesSpy.mock.calls[0][0];
      expect(call[0].path).toBe("test.txt");
      expect(Buffer.isBuffer(call[0].content)).toBe(true);
      expect(call[0].content.toString()).toBe("file content");
    });

    it("should upload multiple files", async () => {
      const sandbox = await VercelSandbox.create();

      const results = await sandbox.uploadFiles([
        ["file1.txt", new TextEncoder().encode("content1")],
        ["file2.txt", new TextEncoder().encode("content2")],
      ]);

      expect(results.length).toBe(2);
      expect(results[0].path).toBe("file1.txt");
      expect(results[0].error).toBeNull();
      expect(results[1].path).toBe("file2.txt");
      expect(results[1].error).toBeNull();
    });

    it("should handle SDK errors", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.shouldFailWriteFiles = true;

      const results = await sandbox.uploadFiles([
        ["test.txt", new TextEncoder().encode("content")],
      ]);

      expect(results[0].error).toBe("permission_denied");
    });

    it("should throw if not initialized", async () => {
      const sandbox = new VercelSandbox();

      await expect(
        sandbox.uploadFiles([["test.txt", new Uint8Array()]]),
      ).rejects.toThrow(VercelSandboxError);
    });
  });

  describe("downloadFiles", () => {
    it("should return file content", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.addFile("test.txt", "file content");

      const results = await sandbox.downloadFiles(["test.txt"]);

      expect(results.length).toBe(1);
      expect(results[0].path).toBe("test.txt");
      expect(results[0].error).toBeNull();
      expect(results[0].content).not.toBeNull();

      const content = new TextDecoder().decode(results[0].content!);
      expect(content).toBe("file content");
    });

    it("should handle file_not_found", async () => {
      const sandbox = await VercelSandbox.create();

      const results = await sandbox.downloadFiles(["nonexistent.txt"]);

      expect(results[0].path).toBe("nonexistent.txt");
      expect(results[0].content).toBeNull();
      expect(results[0].error).toBe("file_not_found");
    });

    it("should download multiple files", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.addFile("file1.txt", "content1");
      mockState.sandboxInstance!.addFile("file2.txt", "content2");

      const results = await sandbox.downloadFiles(["file1.txt", "file2.txt"]);

      expect(results.length).toBe(2);
      expect(new TextDecoder().decode(results[0].content!)).toBe("content1");
      expect(new TextDecoder().decode(results[1].content!)).toBe("content2");
    });

    it("should handle mixed success/failure", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.addFile("exists.txt", "content");

      const results = await sandbox.downloadFiles([
        "exists.txt",
        "missing.txt",
      ]);

      expect(results[0].error).toBeNull();
      expect(results[0].content).not.toBeNull();
      expect(results[1].error).toBe("file_not_found");
      expect(results[1].content).toBeNull();
    });

    it("should throw if not initialized", async () => {
      const sandbox = new VercelSandbox();

      await expect(sandbox.downloadFiles(["test.txt"])).rejects.toThrow(
        VercelSandboxError,
      );
    });
  });

  describe("additional methods", () => {
    describe("domain", () => {
      it("should return public URL for port", async () => {
        const sandbox = await VercelSandbox.create();

        const url = sandbox.domain(3000);

        expect(url).toBe("https://sandbox-mock-123-3000.vercel.app");
      });

      it("should throw if not initialized", () => {
        const sandbox = new VercelSandbox();

        expect(() => sandbox.domain(3000)).toThrow(VercelSandboxError);
      });
    });

    describe("extendTimeout", () => {
      it("should call SDK extendTimeout", async () => {
        const sandbox = await VercelSandbox.create();
        const extendSpy = vi.spyOn(mockState.sandboxInstance!, "extendTimeout");

        await sandbox.extendTimeout(600000);

        expect(extendSpy).toHaveBeenCalledWith(600000);
      });
    });

    describe("snapshot", () => {
      it("should return snapshot info", async () => {
        const sandbox = await VercelSandbox.create();

        const snapshot = await sandbox.snapshot();

        expect(snapshot.snapshotId).toBe("snap-mock-456");
        expect(snapshot.sourceSandboxId).toBe("sandbox-mock-123");
        expect(snapshot.status).toBe("created");
        expect(snapshot.sizeBytes).toBe(1024 * 1024 * 100);
        expect(snapshot.createdAt).toBeInstanceOf(Date);
        expect(snapshot.expiresAt).toBeInstanceOf(Date);
      });

      it("should throw on snapshot failure", async () => {
        const sandbox = await VercelSandbox.create();
        mockState.sandboxInstance!.shouldFailSnapshot = true;

        await expect(sandbox.snapshot()).rejects.toThrow(VercelSandboxError);
        await expect(sandbox.snapshot()).rejects.toMatchObject({
          code: "SNAPSHOT_FAILED",
        });
      });
    });

    describe("stop", () => {
      it("should stop the sandbox", async () => {
        const sandbox = await VercelSandbox.create();
        const stopSpy = vi.spyOn(mockState.sandboxInstance!, "stop");

        await sandbox.stop();

        expect(stopSpy).toHaveBeenCalled();
        expect(sandbox.isRunning).toBe(false);
      });

      it("should be safe to call multiple times", async () => {
        const sandbox = await VercelSandbox.create();

        await sandbox.stop();
        await sandbox.stop(); // Should not throw

        expect(sandbox.isRunning).toBe(false);
      });

      it("should handle stop failure gracefully", async () => {
        const sandbox = await VercelSandbox.create();
        mockState.sandboxInstance!.shouldFailStop = true;

        // Should still mark as not running even if stop fails
        await expect(sandbox.stop()).rejects.toThrow();
        expect(sandbox.isRunning).toBe(false);
      });

      it("should do nothing if not initialized", async () => {
        const sandbox = new VercelSandbox();

        await sandbox.stop(); // Should not throw

        expect(sandbox.isRunning).toBe(false);
      });
    });
  });

  // ==========================================================================
  // Test inherited BaseSandbox methods
  // ==========================================================================

  describe("inherited BaseSandbox methods", () => {
    it("should have read method from BaseSandbox", async () => {
      const sandbox = await VercelSandbox.create();

      // read() is inherited and calls execute() internally
      expect(typeof sandbox.read).toBe("function");
    });

    it("should have write method from BaseSandbox", async () => {
      const sandbox = await VercelSandbox.create();

      expect(typeof sandbox.write).toBe("function");
    });

    it("should have edit method from BaseSandbox", async () => {
      const sandbox = await VercelSandbox.create();

      expect(typeof sandbox.edit).toBe("function");
    });

    it("should have lsInfo method from BaseSandbox", async () => {
      const sandbox = await VercelSandbox.create();

      expect(typeof sandbox.lsInfo).toBe("function");
    });

    it("should have grepRaw method from BaseSandbox", async () => {
      const sandbox = await VercelSandbox.create();

      expect(typeof sandbox.grepRaw).toBe("function");
    });

    it("should have globInfo method from BaseSandbox", async () => {
      const sandbox = await VercelSandbox.create();

      expect(typeof sandbox.globInfo).toBe("function");
    });
  });

  // ==========================================================================
  // Test factory functions
  // ==========================================================================

  describe("createVercelSandboxFactory", () => {
    it("should return an async factory function", () => {
      const factory = createVercelSandboxFactory();

      expect(typeof factory).toBe("function");
    });

    it("should create new sandbox when called", async () => {
      const factory = createVercelSandboxFactory({ runtime: "node24" });

      const sandbox = await factory();

      expect(sandbox).toBeInstanceOf(VercelSandbox);
      expect(sandbox.isRunning).toBe(true);
      expect(mockState.createCalls.length).toBe(1);
    });

    it("should create new sandbox on each call", async () => {
      const factory = createVercelSandboxFactory();

      await factory();
      await factory();

      expect(mockState.createCalls.length).toBe(2);
    });

    it("should pass options to sandbox creation", async () => {
      const factory = createVercelSandboxFactory({
        runtime: "python3.13",
        timeout: 600000,
      });

      await factory();

      expect(mockState.createCalls[0].runtime).toBe("python3.13");
      expect(mockState.createCalls[0].timeout).toBe(600000);
    });
  });

  describe("createVercelSandboxFactoryFromSandbox", () => {
    // Mock StateAndStore for testing
    const mockStateAndStore = { state: { files: {} }, store: undefined };

    it("should return a BackendFactory function", async () => {
      const sandbox = await VercelSandbox.create();
      const factory = createVercelSandboxFactoryFromSandbox(sandbox);

      expect(typeof factory).toBe("function");
    });

    it("should return the same sandbox instance", async () => {
      const sandbox = await VercelSandbox.create();
      const factory = createVercelSandboxFactoryFromSandbox(sandbox);

      const result1 = factory(mockStateAndStore);
      const result2 = factory(mockStateAndStore);

      expect(result1).toBe(sandbox);
      expect(result2).toBe(sandbox);
    });

    it("should not create new sandboxes", async () => {
      const sandbox = await VercelSandbox.create();
      const initialCalls = mockState.createCalls.length;

      const factory = createVercelSandboxFactoryFromSandbox(sandbox);
      factory(mockStateAndStore);
      factory(mockStateAndStore);

      expect(mockState.createCalls.length).toBe(initialCalls);
    });
  });
});
