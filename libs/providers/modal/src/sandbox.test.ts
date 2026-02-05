import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ModalSandboxError } from "./types.js";

// ============================================================================
// Mock State
// ============================================================================

// Track mock state for assertions
const mockState = {
  sandboxInstance: null as MockSandboxType | null,
  clientInstance: null as MockClientType | null,
  createCalls: [] as Array<{
    app: unknown;
    image: unknown;
    options: Record<string, unknown>;
  }>,
  fromIdCalls: [] as Array<{ sandboxId: string }>,
  fromNameCalls: [] as Array<{ appName: string; sandboxName: string }>,
};

// Type for mock sandbox instance
interface MockSandboxType {
  sandboxId: string;
  files: Map<string, Uint8Array>;
  nextCommandResult: {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
  shouldFailOpen: boolean;
  setNextCommandResult: (stdout: string, stderr: string, code: number) => void;
  addFile: (path: string, content: Uint8Array) => void;
  exec: (
    args: string[],
    options: { stdout: string; stderr: string },
  ) => Promise<MockProcessType>;
  open: (path: string, mode: string) => Promise<MockFileHandleType>;
  terminate: () => Promise<void>;
  poll: () => Promise<number | null>;
  wait: () => Promise<number>;
}

interface MockProcessType {
  stdout: { readText: () => Promise<string> };
  stderr: { readText: () => Promise<string> };
  wait: () => Promise<number>;
}

interface MockFileHandleType {
  read: () => Promise<Uint8Array>;
  write: (data: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
}

interface MockClientType {
  apps: {
    fromName: (
      name: string,
      options: { createIfMissing: boolean },
    ) => Promise<unknown>;
  };
  images: {
    fromRegistry: (name: string) => unknown;
  };
  sandboxes: {
    create: (
      app: unknown,
      image: unknown,
      options: Record<string, unknown>,
    ) => Promise<MockSandboxType>;
    fromId: (sandboxId: string) => Promise<MockSandboxType>;
    fromName: (
      appName: string,
      sandboxName: string,
    ) => Promise<MockSandboxType>;
  };
  volumes: {
    fromName: (
      name: string,
      options: { createIfMissing: boolean },
    ) => Promise<unknown>;
  };
  secrets: {
    fromName: (name: string) => Promise<unknown>;
  };
}

// Mock auth module to avoid env var issues in tests
vi.mock("./auth.js", () => ({
  getTokenId: vi.fn(() => "mock-token-id"),
  getTokenSecret: vi.fn(() => "mock-token-secret"),
  getAuthCredentials: vi.fn(() => ({
    tokenId: "mock-token-id",
    tokenSecret: "mock-token-secret",
  })),
}));

// Mock the modal module with factory
vi.mock("modal", () => {
  /**
   * Mock Sandbox class that simulates the Modal SDK behavior.
   */
  class MockSandbox {
    sandboxId: string;

    // Mock file storage
    files: Map<string, Uint8Array> = new Map();

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
    shouldFailOpen = false;

    constructor(sandboxId: string = "sb-mock-123") {
      this.sandboxId = sandboxId;
    }

    // Configure next command result
    setNextCommandResult(stdout: string, stderr: string, code: number) {
      this.nextCommandResult = {
        stdout,
        stderr,
        exitCode: code,
      };
    }

    // Add file to mock filesystem
    addFile(path: string, content: Uint8Array) {
      this.files.set(path, content);
    }

    // SDK methods
    async exec(
      args: string[],
      _options: { stdout: string; stderr: string },
    ): Promise<MockProcessType> {
      const result = { ...this.nextCommandResult };

      // Check if this is a mkdir command - always succeed
      if (args[0] === "mkdir") {
        return {
          stdout: { readText: async () => "" },
          stderr: { readText: async () => "" },
          wait: async () => 0,
        };
      }

      return {
        stdout: { readText: async () => result.stdout },
        stderr: { readText: async () => result.stderr },
        wait: async () => result.exitCode,
      };
    }

    async open(path: string, _mode: string): Promise<MockFileHandleType> {
      if (this.shouldFailOpen) {
        throw new Error("File operation failed: permission denied");
      }

      // Capture files reference for the returned object's methods
      const files = this.files;
      return {
        read: async () => {
          const content = files.get(path);
          if (content === undefined) {
            throw new Error(`File not found: ${path}`);
          }
          return content;
        },
        write: async (data: Uint8Array) => {
          files.set(path, data);
        },
        close: async () => {},
      };
    }

    async terminate(): Promise<void> {
      // No-op for mock
    }

    async poll(): Promise<number | null> {
      return null;
    }

    async wait(): Promise<number> {
      return 0; // Return exit code
    }
  }

  /**
   * Mock ModalClient class
   */
  class MockModalClient {
    apps = {
      fromName: async (
        _name: string,
        _options: { createIfMissing: boolean },
      ) => {
        return { appId: "mock-app-id" };
      },
    };

    images = {
      fromRegistry: (name: string) => {
        return { imageName: name };
      },
    };

    sandboxes = {
      create: async (
        app: unknown,
        image: unknown,
        options: Record<string, unknown>,
      ) => {
        mockState.createCalls.push({ app, image, options });
        mockState.sandboxInstance =
          new MockSandbox() as unknown as MockSandboxType;
        return mockState.sandboxInstance as unknown as MockSandbox;
      },
      fromId: async (sandboxId: string) => {
        mockState.fromIdCalls.push({ sandboxId });
        mockState.sandboxInstance = new MockSandbox(
          sandboxId,
        ) as unknown as MockSandboxType;
        return mockState.sandboxInstance as unknown as MockSandbox;
      },
      fromName: async (appName: string, sandboxName: string) => {
        mockState.fromNameCalls.push({ appName, sandboxName });
        mockState.sandboxInstance = new MockSandbox(
          `${appName}-${sandboxName}`,
        ) as unknown as MockSandboxType;
        return mockState.sandboxInstance as unknown as MockSandbox;
      },
    };

    volumes = {
      fromName: async (
        name: string,
        _options: { createIfMissing: boolean },
      ) => {
        return { volumeName: name };
      },
    };

    secrets = {
      fromName: async (name: string) => {
        return { secretName: name };
      },
    };

    constructor() {
      mockState.clientInstance = this as unknown as MockClientType;
    }
  }

  return {
    ModalClient: MockModalClient,
  };
});

// Import after mocks are set up
import { ModalSandbox } from "./sandbox.js";

// ============================================================================
// Tests
// ============================================================================

describe("ModalSandbox", () => {
  beforeEach(() => {
    // Reset mock state
    mockState.sandboxInstance = null;
    mockState.clientInstance = null;
    mockState.createCalls = [];
    mockState.fromIdCalls = [];
    mockState.fromNameCalls = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Test ModalSandbox initialization
  // ==========================================================================

  describe("constructor", () => {
    it("should set default options", () => {
      const sandbox = new ModalSandbox();

      // ID should be generated with prefix
      expect(sandbox.id).toMatch(/^modal-sandbox-\d+$/);

      // isRunning should be false before initialization
      expect(sandbox.isRunning).toBe(false);
    });

    it("should accept custom options", () => {
      const sandbox = new ModalSandbox({
        appName: "my-app",
        imageName: "python:3.12-slim",
        timeoutMs: 600_000,
      });

      expect(sandbox.id).toMatch(/^modal-sandbox-\d+$/);
      expect(sandbox.isRunning).toBe(false);
    });
  });

  describe("initialize", () => {
    it("should create sandbox via SDK", async () => {
      const sandbox = new ModalSandbox({
        imageName: "python:3.12-slim",
        timeoutMs: 600_000,
      });

      await sandbox.initialize();

      expect(mockState.createCalls.length).toBe(1);
      expect(mockState.createCalls[0].options.timeoutMs).toBe(600_000);
    });

    it("should update id after initialization", async () => {
      const sandbox = new ModalSandbox();
      const initialId = sandbox.id;

      await sandbox.initialize();

      expect(sandbox.id).toBe("sb-mock-123");
      expect(sandbox.id).not.toBe(initialId);
    });

    it("should pass timeoutMs configuration to SDK", async () => {
      const sandbox = new ModalSandbox({
        timeoutMs: 1_200_000,
      });

      await sandbox.initialize();

      expect(mockState.createCalls[0].options.timeoutMs).toBe(1_200_000);
    });

    it("should pass workdir configuration to SDK", async () => {
      const sandbox = new ModalSandbox({
        workdir: "/app",
      });

      await sandbox.initialize();

      expect(mockState.createCalls[0].options.workdir).toBe("/app");
    });

    it("should throw if already initialized", async () => {
      const sandbox = new ModalSandbox();
      await sandbox.initialize();

      await expect(sandbox.initialize()).rejects.toThrow(ModalSandboxError);
      await expect(sandbox.initialize()).rejects.toMatchObject({
        code: "ALREADY_INITIALIZED",
      });
    });

    it("should set isRunning to true after initialization", async () => {
      const sandbox = new ModalSandbox();
      expect(sandbox.isRunning).toBe(false);

      await sandbox.initialize();

      expect(sandbox.isRunning).toBe(true);
    });

    it("should populate initial files with string content", async () => {
      const sandbox = new ModalSandbox({
        initialFiles: {
          "/test.txt": "Hello, World!",
          "/src/index.js": "console.log('Hi')",
        },
      });

      await sandbox.initialize();

      // Verify files were uploaded to the mock sandbox
      // Note: paths are normalized (leading slash removed)
      const mockSb = mockState.sandboxInstance!;
      expect(mockSb.files.has("test.txt")).toBe(true);
      expect(mockSb.files.has("src/index.js")).toBe(true);

      // Check content (should be Uint8Array)
      const encoder = new TextEncoder();
      expect(mockSb.files.get("test.txt")).toEqual(
        encoder.encode("Hello, World!"),
      );
      expect(mockSb.files.get("src/index.js")).toEqual(
        encoder.encode("console.log('Hi')"),
      );
    });

    it("should populate initial files with Uint8Array content", async () => {
      const encoder = new TextEncoder();
      const binaryContent = encoder.encode("Binary content");

      const sandbox = new ModalSandbox({
        initialFiles: {
          "/binary.dat": binaryContent,
        },
      });

      await sandbox.initialize();

      // Note: paths are normalized (leading slash removed)
      const mockSb = mockState.sandboxInstance!;
      expect(mockSb.files.has("binary.dat")).toBe(true);
      expect(mockSb.files.get("binary.dat")).toEqual(binaryContent);
    });

    it("should handle initial files with mixed content types", async () => {
      const encoder = new TextEncoder();
      const sandbox = new ModalSandbox({
        initialFiles: {
          "/text.txt": "String content",
          "/data.bin": encoder.encode("Binary data"),
        },
      });

      await sandbox.initialize();

      // Note: paths are normalized (leading slash removed)
      const mockSb = mockState.sandboxInstance!;
      expect(mockSb.files.has("text.txt")).toBe(true);
      expect(mockSb.files.has("data.bin")).toBe(true);
    });

    it("should normalize paths - remove leading slash", async () => {
      const sandbox = new ModalSandbox({
        initialFiles: {
          "/with-slash.txt": "content1",
          "no-slash.txt": "content2",
        },
      });

      await sandbox.initialize();

      const mockSb = mockState.sandboxInstance!;
      // Both should be stored with paths (the mock stores normalized paths)
      expect(mockSb.files.has("with-slash.txt")).toBe(true);
      expect(mockSb.files.has("no-slash.txt")).toBe(true);
    });
  });

  describe("instance getter", () => {
    it("should throw if not initialized", () => {
      const sandbox = new ModalSandbox();

      expect(() => sandbox.instance).toThrow(ModalSandboxError);
      expect(() => sandbox.instance).toThrow("not initialized");
    });

    it("should return sandbox instance after initialization", async () => {
      const sandbox = new ModalSandbox();
      await sandbox.initialize();

      const sdkSandbox = sandbox.instance;
      expect(sdkSandbox).toBeDefined();
      expect(sdkSandbox.sandboxId).toBe("sb-mock-123");
    });
  });

  describe("client getter", () => {
    it("should throw if not initialized", () => {
      const sandbox = new ModalSandbox();

      expect(() => sandbox.client).toThrow(ModalSandboxError);
      expect(() => sandbox.client).toThrow("not initialized");
    });

    it("should return client instance after initialization", async () => {
      const sandbox = new ModalSandbox();
      await sandbox.initialize();

      const client = sandbox.client;
      expect(client).toBeDefined();
      // Verify it has ModalClient-like properties
      expect(client.apps).toBeDefined();
      expect(client.sandboxes).toBeDefined();
    });
  });

  describe("static create", () => {
    it("should create and initialize sandbox in one step", async () => {
      const sandbox = await ModalSandbox.create({
        imageName: "python:3.12-slim",
        timeoutMs: 600_000,
      });

      expect(sandbox.isRunning).toBe(true);
      expect(sandbox.id).toBe("sb-mock-123");
      expect(mockState.createCalls.length).toBe(1);
    });

    it("should work with default options", async () => {
      const sandbox = await ModalSandbox.create();

      expect(sandbox.isRunning).toBe(true);
      expect(mockState.createCalls.length).toBe(1);
      // SDK defaults are used (no timeoutMs explicitly set)
      expect(mockState.createCalls[0].options.timeoutMs).toBeUndefined();
    });

    it("should create with initial files", async () => {
      const sandbox = await ModalSandbox.create({
        initialFiles: {
          "/hello.txt": "Hello!",
          "/nested/file.js": "export const x = 1;",
        },
      });

      expect(sandbox.isRunning).toBe(true);

      // Verify files were uploaded
      const mockSb = mockState.sandboxInstance!;
      expect(mockSb.files.has("hello.txt")).toBe(true);
      expect(mockSb.files.has("nested/file.js")).toBe(true);

      // Verify content
      const results = await sandbox.downloadFiles([
        "hello.txt",
        "nested/file.js",
      ]);
      expect(results[0].error).toBeNull();
      expect(new TextDecoder().decode(results[0].content!)).toBe("Hello!");
      expect(results[1].error).toBeNull();
      expect(new TextDecoder().decode(results[1].content!)).toBe(
        "export const x = 1;",
      );
    });
  });

  describe("static fromId", () => {
    it("should reconnect to existing sandbox by ID", async () => {
      const sandbox = await ModalSandbox.fromId("existing-sandbox-id");

      expect(sandbox.id).toBe("existing-sandbox-id");
      expect(sandbox.isRunning).toBe(true);
      expect(mockState.fromIdCalls.length).toBe(1);
      expect(mockState.fromIdCalls[0].sandboxId).toBe("existing-sandbox-id");
    });
  });

  describe("static fromName", () => {
    it("should get sandbox by app name and sandbox name", async () => {
      const sandbox = await ModalSandbox.fromName("my-app", "my-sandbox");

      expect(sandbox.id).toBe("my-app-my-sandbox");
      expect(sandbox.isRunning).toBe(true);
      expect(mockState.fromNameCalls.length).toBe(1);
      expect(mockState.fromNameCalls[0].appName).toBe("my-app");
      expect(mockState.fromNameCalls[0].sandboxName).toBe("my-sandbox");
    });
  });

  // ==========================================================================
  // Test command execution
  // ==========================================================================

  describe("execute", () => {
    it("should call SDK exec with bash -c", async () => {
      const sandbox = await ModalSandbox.create();

      // Spy on exec
      const execSpy = vi.spyOn(mockState.sandboxInstance!, "exec");

      await sandbox.execute("echo hello");

      expect(execSpy).toHaveBeenCalledWith(["bash", "-c", "echo hello"], {
        stdout: "pipe",
        stderr: "pipe",
      });
    });

    it("should return combined stdout and stderr", async () => {
      const sandbox = await ModalSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("output", "error", 0);

      const result = await sandbox.execute("test command");

      expect(result.output).toBe("outputerror");
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it("should capture exit code correctly", async () => {
      const sandbox = await ModalSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("", "command failed", 1);

      const result = await sandbox.execute("failing command");

      expect(result.exitCode).toBe(1);
    });

    it("should return stdout only when no stderr", async () => {
      const sandbox = await ModalSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("hello world\n", "", 0);

      const result = await sandbox.execute("echo 'hello world'");

      expect(result.output).toBe("hello world\n");
    });

    it("should throw if not initialized", async () => {
      const sandbox = new ModalSandbox();

      await expect(sandbox.execute("echo test")).rejects.toThrow(
        ModalSandboxError,
      );
      await expect(sandbox.execute("echo test")).rejects.toMatchObject({
        code: "NOT_INITIALIZED",
      });
    });

    it("should handle complex commands", async () => {
      const sandbox = await ModalSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("result", "", 0);

      const result = await sandbox.execute(
        "cd /app && pip install && python main.py",
      );

      expect(result.exitCode).toBe(0);
    });
  });

  // ==========================================================================
  // Test file operations
  // ==========================================================================

  describe("uploadFiles", () => {
    it("should write content to sandbox", async () => {
      const sandbox = await ModalSandbox.create();
      const openSpy = vi.spyOn(mockState.sandboxInstance!, "open");

      const content = new TextEncoder().encode("file content");
      await sandbox.uploadFiles([["test.txt", content]]);

      // open is called for writing the file
      expect(openSpy).toHaveBeenCalledWith("test.txt", "w");
    });

    it("should upload multiple files", async () => {
      const sandbox = await ModalSandbox.create();

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
      const sandbox = await ModalSandbox.create();
      mockState.sandboxInstance!.shouldFailOpen = true;

      const results = await sandbox.uploadFiles([
        ["test.txt", new TextEncoder().encode("content")],
      ]);

      expect(results[0].error).toBe("permission_denied");
    });

    it("should throw if not initialized", async () => {
      const sandbox = new ModalSandbox();

      await expect(
        sandbox.uploadFiles([["test.txt", new Uint8Array()]]),
      ).rejects.toThrow(ModalSandboxError);
    });
  });

  describe("downloadFiles", () => {
    it("should return file content", async () => {
      const sandbox = await ModalSandbox.create();
      const content = new TextEncoder().encode("file content");
      mockState.sandboxInstance!.addFile("test.txt", content);

      const results = await sandbox.downloadFiles(["test.txt"]);

      expect(results.length).toBe(1);
      expect(results[0].path).toBe("test.txt");
      expect(results[0].error).toBeNull();
      expect(results[0].content).not.toBeNull();

      const resultContent = new TextDecoder().decode(results[0].content!);
      expect(resultContent).toBe("file content");
    });

    it("should handle file_not_found", async () => {
      const sandbox = await ModalSandbox.create();

      const results = await sandbox.downloadFiles(["nonexistent.txt"]);

      expect(results[0].path).toBe("nonexistent.txt");
      expect(results[0].content).toBeNull();
      expect(results[0].error).toBe("file_not_found");
    });

    it("should download multiple files", async () => {
      const sandbox = await ModalSandbox.create();
      mockState.sandboxInstance!.addFile(
        "file1.txt",
        new TextEncoder().encode("content1"),
      );
      mockState.sandboxInstance!.addFile(
        "file2.txt",
        new TextEncoder().encode("content2"),
      );

      const results = await sandbox.downloadFiles(["file1.txt", "file2.txt"]);

      expect(results.length).toBe(2);
      expect(new TextDecoder().decode(results[0].content!)).toBe("content1");
      expect(new TextDecoder().decode(results[1].content!)).toBe("content2");
    });

    it("should handle mixed success/failure", async () => {
      const sandbox = await ModalSandbox.create();
      mockState.sandboxInstance!.addFile(
        "exists.txt",
        new TextEncoder().encode("content"),
      );

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
      const sandbox = new ModalSandbox();

      await expect(sandbox.downloadFiles(["test.txt"])).rejects.toThrow(
        ModalSandboxError,
      );
    });
  });

  describe("lifecycle methods", () => {
    describe("close", () => {
      it("should terminate the sandbox", async () => {
        const sandbox = await ModalSandbox.create();
        const terminateSpy = vi.spyOn(mockState.sandboxInstance!, "terminate");

        await sandbox.close();

        expect(terminateSpy).toHaveBeenCalled();
        expect(sandbox.isRunning).toBe(false);
      });

      it("should be safe to call multiple times", async () => {
        const sandbox = await ModalSandbox.create();

        await sandbox.close();
        await sandbox.close(); // Should not throw

        expect(sandbox.isRunning).toBe(false);
      });

      it("should do nothing if not initialized", async () => {
        const sandbox = new ModalSandbox();

        await sandbox.close(); // Should not throw

        expect(sandbox.isRunning).toBe(false);
      });
    });

    describe("terminate", () => {
      it("should be an alias for close", async () => {
        const sandbox = await ModalSandbox.create();
        const terminateSpy = vi.spyOn(mockState.sandboxInstance!, "terminate");

        await sandbox.terminate();

        expect(terminateSpy).toHaveBeenCalled();
        expect(sandbox.isRunning).toBe(false);
      });
    });

    describe("stop", () => {
      it("should be an alias for close", async () => {
        const sandbox = await ModalSandbox.create();
        const terminateSpy = vi.spyOn(mockState.sandboxInstance!, "terminate");

        await sandbox.stop();

        expect(terminateSpy).toHaveBeenCalled();
        expect(sandbox.isRunning).toBe(false);
      });
    });
  });

  // ==========================================================================
  // Test inherited BaseSandbox methods
  // ==========================================================================

  describe("inherited BaseSandbox methods", () => {
    it.each([
      "read",
      "write",
      "edit",
      "lsInfo",
      "grepRaw",
      "globInfo",
    ] as const)("should have %s method from BaseSandbox", async (method) => {
      const sandbox = await ModalSandbox.create();
      expect(typeof sandbox[method]).toBe("function");
    });
  });
});
