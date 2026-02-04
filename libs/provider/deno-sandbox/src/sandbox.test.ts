/**
 * Unit tests for DenoSandbox class.
 *
 * Uses mocked @deno/sandbox SDK for fast, isolated testing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DenoSandboxError } from "./types.js";

// ============================================================================
// Mock State
// ============================================================================

// Track mock state for assertions
const mockState = {
  sandboxInstance: null as MockSandboxType | null,
  createCalls: [] as Array<{
    memoryMb?: number;
    lifetime?: string;
    region?: string;
  }>,
  connectCalls: [] as Array<{ id: string }>,
};

// Type for mock sandbox instance
interface MockSandboxType {
  id: string;
  status: string;
  files: Map<string, string>;
  nextCommandResult: { stdoutText: string; stderrText: string; status: { success: boolean; code: number } };
  shouldFailWriteFile: boolean;
  shouldFailReadFile: boolean;
  setNextCommandResult: (
    stdoutText: string,
    stderrText: string,
    code: number,
  ) => void;
  addFile: (path: string, content: string) => void;
  spawn: (cmd: string, options: { args: string[]; stdout: string; stderr: string }) => Promise<{
    output: () => Promise<{
      status: { success: boolean; code: number };
      stdoutText: string;
      stderrText: string;
    }>;
    status: Promise<{ success: boolean; code: number }>;
  }>;
  sh: ReturnType<typeof createMockSh>;
  writeTextFile: (path: string, content: string) => Promise<void>;
  close: () => Promise<void>;
  kill: () => Promise<void>;
}

// Create a mock shell function
function createMockSh(instance: MockSandboxType) {
  const sh = (strings: TemplateStringsArray, ...values: unknown[]) => {
    // Combine template strings with values
    let command = strings[0];
    for (let i = 0; i < values.length; i++) {
      command += String(values[i]) + strings[i + 1];
    }

    return {
      noThrow: async () => {
        // Check if this is a cat command for file reading
        if (command.startsWith("cat ")) {
          const filePath = command.substring(4).trim();
          const content = instance.files.get(filePath);
          if (content !== undefined) {
            return {
              status: { success: true, code: 0 },
              stdoutText: content,
              stderrText: "",
            };
          } else {
            return {
              status: { success: false, code: 1 },
              stdoutText: "",
              stderrText: "cat: file not found",
            };
          }
        }
        // Default behavior
        return {
          status: instance.nextCommandResult.status,
          stdoutText: instance.nextCommandResult.stdoutText,
          stderrText: instance.nextCommandResult.stderrText,
        };
      },
      text: async () => {
        return instance.nextCommandResult.stdoutText;
      },
    };
  };
  return sh;
}

// Mock auth module to avoid env var issues in tests
vi.mock("./auth.js", () => ({
  getAuthToken: vi.fn(() => "mock-auth-token"),
  getAuthCredentials: vi.fn(() => ({ token: "mock-auth-token" })),
}));

// Mock the @deno/sandbox module with factory
vi.mock("@deno/sandbox", () => {
  /**
   * Mock Sandbox class that simulates the Deno SDK behavior.
   */
  class MockSandbox {
    id: string;
    status: string = "running";

    // Mock file storage
    files: Map<string, string> = new Map();

    // Command execution configuration
    nextCommandResult: {
      stdoutText: string;
      stderrText: string;
      status: { success: boolean; code: number };
    } = {
      stdoutText: "",
      stderrText: "",
      status: { success: true, code: 0 },
    };

    // Error simulation flags
    shouldFailWriteFile = false;
    shouldFailReadFile = false;

    // Shell mock
    sh: ReturnType<typeof createMockSh>;

    constructor(sandboxId: string = "sandbox-mock-123") {
      this.id = sandboxId;
      this.sh = createMockSh(this as unknown as MockSandboxType);
    }

    // Configure next command result
    setNextCommandResult(stdoutText: string, stderrText: string, code: number) {
      this.nextCommandResult = {
        stdoutText,
        stderrText,
        status: { success: code === 0, code },
      };
    }

    // Add file to mock filesystem
    addFile(path: string, content: string) {
      this.files.set(path, content);
    }

    // SDK methods
    async spawn(
      _cmd: string,
      _options: { args: string[]; stdout: string; stderr: string },
    ): Promise<{
      output: () => Promise<{
        status: { success: boolean; code: number };
        stdoutText: string;
        stderrText: string;
      }>;
      status: Promise<{ success: boolean; code: number }>;
    }> {
      const result = { ...this.nextCommandResult };

      return {
        output: async () => ({
          status: result.status,
          stdoutText: result.stdoutText,
          stderrText: result.stderrText,
        }),
        status: Promise.resolve(result.status),
      };
    }

    async writeTextFile(path: string, content: string): Promise<void> {
      if (this.shouldFailWriteFile) {
        throw new Error("Write operation failed: permission denied");
      }
      this.files.set(path, content);
    }

    async close(): Promise<void> {
      this.status = "closed";
    }

    async kill(): Promise<void> {
      this.status = "killed";
    }

    // Static factory methods
    static async create(options?: {
      memoryMb?: number;
      lifetime?: string;
      region?: string;
    }): Promise<MockSandbox> {
      mockState.createCalls.push(options || {});
      mockState.sandboxInstance =
        new MockSandbox() as unknown as MockSandboxType;
      return mockState.sandboxInstance as unknown as MockSandbox;
    }

    static async connect(options: { id: string }): Promise<MockSandbox> {
      mockState.connectCalls.push(options);
      mockState.sandboxInstance = new MockSandbox(
        options.id,
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
  DenoSandbox,
  createDenoSandboxFactory,
  createDenoSandboxFactoryFromSandbox,
} from "./sandbox.js";

// ============================================================================
// Tests
// ============================================================================

describe("DenoSandbox", () => {
  beforeEach(() => {
    // Reset mock state
    mockState.sandboxInstance = null;
    mockState.createCalls = [];
    mockState.connectCalls = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Test DenoSandbox initialization
  // ==========================================================================

  describe("constructor", () => {
    it("should set default options", () => {
      const sandbox = new DenoSandbox();

      // ID should be generated with prefix
      expect(sandbox.id).toMatch(/^deno-sandbox-\d+$/);

      // isRunning should be false before initialization
      expect(sandbox.isRunning).toBe(false);
    });

    it("should accept custom options", () => {
      const sandbox = new DenoSandbox({
        memoryMb: 1024,
        lifetime: "5m",
        region: "ams",
      });

      expect(sandbox.id).toMatch(/^deno-sandbox-\d+$/);
      expect(sandbox.isRunning).toBe(false);
    });
  });

  describe("initialize", () => {
    it("should create sandbox via SDK", async () => {
      const sandbox = new DenoSandbox({
        memoryMb: 1024,
        lifetime: "5m",
      });

      await sandbox.initialize();

      expect(mockState.createCalls.length).toBe(1);
      expect(mockState.createCalls[0].memoryMb).toBe(1024);
      expect(mockState.createCalls[0].lifetime).toBe("5m");
    });

    it("should update id after initialization", async () => {
      const sandbox = new DenoSandbox();
      const initialId = sandbox.id;

      await sandbox.initialize();

      expect(sandbox.id).toBe("sandbox-mock-123");
      expect(sandbox.id).not.toBe(initialId);
    });

    it("should pass region configuration to SDK", async () => {
      const sandbox = new DenoSandbox({
        region: "ams",
      });

      await sandbox.initialize();

      expect(mockState.createCalls[0].region).toBe("ams");
    });

    it("should throw if already initialized", async () => {
      const sandbox = new DenoSandbox();
      await sandbox.initialize();

      await expect(sandbox.initialize()).rejects.toThrow(DenoSandboxError);
      await expect(sandbox.initialize()).rejects.toMatchObject({
        code: "ALREADY_INITIALIZED",
      });
    });

    it("should set isRunning to true after initialization", async () => {
      const sandbox = new DenoSandbox();
      expect(sandbox.isRunning).toBe(false);

      await sandbox.initialize();

      expect(sandbox.isRunning).toBe(true);
    });
  });

  describe("sandbox getter", () => {
    it("should throw if not initialized", () => {
      const sandbox = new DenoSandbox();

      expect(() => sandbox.sandbox).toThrow(DenoSandboxError);
      expect(() => sandbox.sandbox).toThrow("not initialized");
    });

    it("should return sandbox instance after initialization", async () => {
      const sandbox = new DenoSandbox();
      await sandbox.initialize();

      const sdkSandbox = sandbox.sandbox;
      expect(sdkSandbox).toBeDefined();
      expect(sdkSandbox.id).toBe("sandbox-mock-123");
    });
  });

  describe("static create", () => {
    it("should create and initialize sandbox in one step", async () => {
      const sandbox = await DenoSandbox.create({
        memoryMb: 2048,
        lifetime: "10m",
      });

      expect(sandbox.isRunning).toBe(true);
      expect(sandbox.id).toBe("sandbox-mock-123");
      expect(mockState.createCalls.length).toBe(1);
    });

    it("should work with default options", async () => {
      const sandbox = await DenoSandbox.create();

      expect(sandbox.isRunning).toBe(true);
      expect(mockState.createCalls[0].memoryMb).toBe(768);
      expect(mockState.createCalls[0].lifetime).toBe("session");
    });
  });

  describe("static connect", () => {
    it("should reconnect to existing sandbox by ID", async () => {
      const sandbox = await DenoSandbox.connect("existing-sandbox-id");

      expect(sandbox.id).toBe("existing-sandbox-id");
      expect(sandbox.isRunning).toBe(true);
      expect(mockState.connectCalls.length).toBe(1);
      expect(mockState.connectCalls[0].id).toBe("existing-sandbox-id");
    });
  });

  // ==========================================================================
  // Test command execution
  // ==========================================================================

  describe("execute", () => {
    it("should call SDK with correct command format", async () => {
      const sandbox = await DenoSandbox.create();

      // Spy on spawn
      const spawnSpy = vi.spyOn(mockState.sandboxInstance!, "spawn");

      await sandbox.execute("echo hello");

      expect(spawnSpy).toHaveBeenCalledWith("/bin/bash", {
        args: ["-c", "echo hello"],
        stdout: "piped",
        stderr: "piped",
      });
    });

    it("should return combined stdout and stderr", async () => {
      const sandbox = await DenoSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("output", "error", 0);

      const result = await sandbox.execute("test command");

      expect(result.output).toBe("outputerror");
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it("should capture exit code correctly", async () => {
      const sandbox = await DenoSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("", "command failed", 1);

      const result = await sandbox.execute("failing command");

      expect(result.exitCode).toBe(1);
    });

    it("should return stdout only when no stderr", async () => {
      const sandbox = await DenoSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("hello world\n", "", 0);

      const result = await sandbox.execute("echo 'hello world'");

      expect(result.output).toBe("hello world\n");
    });

    it("should throw if not initialized", async () => {
      const sandbox = new DenoSandbox();

      await expect(sandbox.execute("echo test")).rejects.toThrow(
        DenoSandboxError,
      );
      await expect(sandbox.execute("echo test")).rejects.toMatchObject({
        code: "NOT_INITIALIZED",
      });
    });

    it("should handle complex commands", async () => {
      const sandbox = await DenoSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("result", "", 0);

      const result = await sandbox.execute(
        "cd /app && deno install && deno run build.ts",
      );

      expect(result.exitCode).toBe(0);
    });
  });

  // ==========================================================================
  // Test file operations
  // ==========================================================================

  describe("uploadFiles", () => {
    it("should write text content to sandbox", async () => {
      const sandbox = await DenoSandbox.create();
      const writeFileSpy = vi.spyOn(mockState.sandboxInstance!, "writeTextFile");

      const content = new TextEncoder().encode("file content");
      await sandbox.uploadFiles([["test.txt", content]]);

      expect(writeFileSpy).toHaveBeenCalledWith("test.txt", "file content");
    });

    it("should upload multiple files", async () => {
      const sandbox = await DenoSandbox.create();

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
      const sandbox = await DenoSandbox.create();
      mockState.sandboxInstance!.shouldFailWriteFile = true;

      const results = await sandbox.uploadFiles([
        ["test.txt", new TextEncoder().encode("content")],
      ]);

      expect(results[0].error).toBe("permission_denied");
    });

    it("should throw if not initialized", async () => {
      const sandbox = new DenoSandbox();

      await expect(
        sandbox.uploadFiles([["test.txt", new Uint8Array()]]),
      ).rejects.toThrow(DenoSandboxError);
    });
  });

  describe("downloadFiles", () => {
    it("should return file content", async () => {
      const sandbox = await DenoSandbox.create();
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
      const sandbox = await DenoSandbox.create();

      const results = await sandbox.downloadFiles(["nonexistent.txt"]);

      expect(results[0].path).toBe("nonexistent.txt");
      expect(results[0].content).toBeNull();
      expect(results[0].error).toBe("file_not_found");
    });

    it("should download multiple files", async () => {
      const sandbox = await DenoSandbox.create();
      mockState.sandboxInstance!.addFile("file1.txt", "content1");
      mockState.sandboxInstance!.addFile("file2.txt", "content2");

      const results = await sandbox.downloadFiles(["file1.txt", "file2.txt"]);

      expect(results.length).toBe(2);
      expect(new TextDecoder().decode(results[0].content!)).toBe("content1");
      expect(new TextDecoder().decode(results[1].content!)).toBe("content2");
    });

    it("should handle mixed success/failure", async () => {
      const sandbox = await DenoSandbox.create();
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
      const sandbox = new DenoSandbox();

      await expect(sandbox.downloadFiles(["test.txt"])).rejects.toThrow(
        DenoSandboxError,
      );
    });
  });

  describe("lifecycle methods", () => {
    describe("close", () => {
      it("should close the sandbox", async () => {
        const sandbox = await DenoSandbox.create();
        const closeSpy = vi.spyOn(mockState.sandboxInstance!, "close");

        await sandbox.close();

        expect(closeSpy).toHaveBeenCalled();
        expect(sandbox.isRunning).toBe(false);
      });

      it("should be safe to call multiple times", async () => {
        const sandbox = await DenoSandbox.create();

        await sandbox.close();
        await sandbox.close(); // Should not throw

        expect(sandbox.isRunning).toBe(false);
      });

      it("should do nothing if not initialized", async () => {
        const sandbox = new DenoSandbox();

        await sandbox.close(); // Should not throw

        expect(sandbox.isRunning).toBe(false);
      });
    });

    describe("kill", () => {
      it("should kill the sandbox", async () => {
        const sandbox = await DenoSandbox.create();
        const killSpy = vi.spyOn(mockState.sandboxInstance!, "kill");

        await sandbox.kill();

        expect(killSpy).toHaveBeenCalled();
        expect(sandbox.isRunning).toBe(false);
      });
    });

    describe("stop", () => {
      it("should be an alias for close", async () => {
        const sandbox = await DenoSandbox.create();
        const closeSpy = vi.spyOn(mockState.sandboxInstance!, "close");

        await sandbox.stop();

        expect(closeSpy).toHaveBeenCalled();
        expect(sandbox.isRunning).toBe(false);
      });
    });
  });

  // ==========================================================================
  // Test inherited BaseSandbox methods
  // ==========================================================================

  describe("inherited BaseSandbox methods", () => {
    it("should have read method from BaseSandbox", async () => {
      const sandbox = await DenoSandbox.create();

      // read() is inherited and calls execute() internally
      expect(typeof sandbox.read).toBe("function");
    });

    it("should have write method from BaseSandbox", async () => {
      const sandbox = await DenoSandbox.create();

      expect(typeof sandbox.write).toBe("function");
    });

    it("should have edit method from BaseSandbox", async () => {
      const sandbox = await DenoSandbox.create();

      expect(typeof sandbox.edit).toBe("function");
    });

    it("should have lsInfo method from BaseSandbox", async () => {
      const sandbox = await DenoSandbox.create();

      expect(typeof sandbox.lsInfo).toBe("function");
    });

    it("should have grepRaw method from BaseSandbox", async () => {
      const sandbox = await DenoSandbox.create();

      expect(typeof sandbox.grepRaw).toBe("function");
    });

    it("should have globInfo method from BaseSandbox", async () => {
      const sandbox = await DenoSandbox.create();

      expect(typeof sandbox.globInfo).toBe("function");
    });
  });

  // ==========================================================================
  // Test factory functions
  // ==========================================================================

  describe("createDenoSandboxFactory", () => {
    it("should return an async factory function", () => {
      const factory = createDenoSandboxFactory();

      expect(typeof factory).toBe("function");
    });

    it("should create new sandbox when called", async () => {
      const factory = createDenoSandboxFactory({ memoryMb: 1024 });

      const sandbox = await factory();

      expect(sandbox).toBeInstanceOf(DenoSandbox);
      expect(sandbox.isRunning).toBe(true);
      expect(mockState.createCalls.length).toBe(1);
    });

    it("should create new sandbox on each call", async () => {
      const factory = createDenoSandboxFactory();

      await factory();
      await factory();

      expect(mockState.createCalls.length).toBe(2);
    });

    it("should pass options to sandbox creation", async () => {
      const factory = createDenoSandboxFactory({
        memoryMb: 2048,
        lifetime: "10m",
      });

      await factory();

      expect(mockState.createCalls[0].memoryMb).toBe(2048);
      expect(mockState.createCalls[0].lifetime).toBe("10m");
    });
  });

  describe("createDenoSandboxFactoryFromSandbox", () => {
    // Mock StateAndStore for testing
    const mockStateAndStore = { state: { files: {} }, store: undefined };

    it("should return a BackendFactory function", async () => {
      const sandbox = await DenoSandbox.create();
      const factory = createDenoSandboxFactoryFromSandbox(sandbox);

      expect(typeof factory).toBe("function");
    });

    it("should return the same sandbox instance", async () => {
      const sandbox = await DenoSandbox.create();
      const factory = createDenoSandboxFactoryFromSandbox(sandbox);

      const result1 = factory(mockStateAndStore);
      const result2 = factory(mockStateAndStore);

      expect(result1).toBe(sandbox);
      expect(result2).toBe(sandbox);
    });

    it("should not create new sandboxes", async () => {
      const sandbox = await DenoSandbox.create();
      const initialCalls = mockState.createCalls.length;

      const factory = createDenoSandboxFactoryFromSandbox(sandbox);
      factory(mockStateAndStore);
      factory(mockStateAndStore);

      expect(mockState.createCalls.length).toBe(initialCalls);
    });
  });
});
