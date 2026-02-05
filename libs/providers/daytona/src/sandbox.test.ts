import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DaytonaSandbox, DaytonaSandboxError } from "./index.js";

// Create mock objects at module level for access in tests
const mockSandbox = {
  id: "mock-sandbox-id",
  process: {
    executeCommand: vi.fn(),
  },
  fs: {
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    createFolder: vi.fn(),
  },
  delete: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  getWorkDir: vi.fn().mockResolvedValue("/home/daytona"),
  getUserHomeDir: vi.fn().mockResolvedValue("/home/daytona"),
};

const mockDaytonaInstance = {
  create: vi.fn().mockResolvedValue(mockSandbox),
  get: vi.fn().mockResolvedValue(mockSandbox),
};

// Mock the Daytona SDK with a proper class
vi.mock("@daytonaio/sdk", () => {
  return {
    Daytona: class MockDaytona {
      create = mockDaytonaInstance.create;
      get = mockDaytonaInstance.get;
    },
  };
});

describe("DaytonaSandbox", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DAYTONA_API_KEY = "test-api-key";
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("constructor", () => {
    it("should create instance with default options", () => {
      const sandbox = new DaytonaSandbox();
      expect(sandbox).toBeInstanceOf(DaytonaSandbox);
      expect(sandbox.id).toMatch(/^daytona-sandbox-/);
    });

    it("should create instance with custom options", () => {
      const sandbox = new DaytonaSandbox({
        language: "python",
        timeout: 600,
      });
      expect(sandbox).toBeInstanceOf(DaytonaSandbox);
    });

    it("should not be running before initialization", () => {
      const sandbox = new DaytonaSandbox();
      expect(sandbox.isRunning).toBe(false);
    });
  });

  describe("sandbox property", () => {
    it("should throw when accessed before initialization", () => {
      const sandbox = new DaytonaSandbox();
      expect(() => sandbox.sandbox).toThrow(DaytonaSandboxError);
      expect(() => sandbox.sandbox).toThrow("Sandbox not initialized");
    });
  });

  describe("initialize", () => {
    it("should initialize the sandbox", async () => {
      const sandbox = new DaytonaSandbox();
      await sandbox.initialize();

      expect(sandbox.isRunning).toBe(true);
      expect(sandbox.id).toBe("mock-sandbox-id");
    });

    it("should throw when initialized twice", async () => {
      const sandbox = new DaytonaSandbox();
      await sandbox.initialize();

      await expect(sandbox.initialize()).rejects.toThrow(
        "Sandbox is already initialized",
      );
    });

    it("should throw on authentication failure", async () => {
      delete process.env.DAYTONA_API_KEY;
      const sandbox = new DaytonaSandbox();

      await expect(sandbox.initialize()).rejects.toThrow(
        "Failed to authenticate with Daytona",
      );
    });
  });

  describe("static create", () => {
    it("should create and initialize sandbox in one step", async () => {
      const sandbox = await DaytonaSandbox.create();

      expect(sandbox).toBeInstanceOf(DaytonaSandbox);
      expect(sandbox.isRunning).toBe(true);
      expect(sandbox.id).toBe("mock-sandbox-id");
    });

    it("should pass options to constructor", async () => {
      await DaytonaSandbox.create({
        language: "python",
        image: "python:3.12",
        resources: { cpu: 4, memory: 8 },
      });

      expect(mockDaytonaInstance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          language: "python",
          image: "python:3.12",
          resources: { cpu: 4, memory: 8 },
        }),
      );
    });
  });

  describe("execute", () => {
    it("should execute command and return result", async () => {
      mockSandbox.process.executeCommand.mockResolvedValueOnce({
        result: "Hello World\n",
        exitCode: 0,
      });

      const sandbox = await DaytonaSandbox.create();
      const result = await sandbox.execute('echo "Hello World"');

      expect(result).toEqual({
        output: "Hello World\n",
        exitCode: 0,
        truncated: false,
      });
    });

    it("should handle non-zero exit codes", async () => {
      mockSandbox.process.executeCommand.mockResolvedValueOnce({
        result: "Command not found\n",
        exitCode: 127,
      });

      const sandbox = await DaytonaSandbox.create();
      const result = await sandbox.execute("nonexistent-command");

      expect(result.exitCode).toBe(127);
    });

    it("should throw on timeout", async () => {
      mockSandbox.process.executeCommand.mockRejectedValueOnce(
        new Error("Command timeout exceeded"),
      );

      const sandbox = await DaytonaSandbox.create();

      await expect(sandbox.execute("sleep 1000")).rejects.toThrow(
        "Command timed out",
      );
    });
  });

  describe("uploadFiles", () => {
    it("should upload files successfully", async () => {
      mockSandbox.fs.uploadFile.mockResolvedValue(undefined);
      mockSandbox.fs.createFolder.mockResolvedValue(undefined);

      const sandbox = await DaytonaSandbox.create();
      const encoder = new TextEncoder();

      const results = await sandbox.uploadFiles([
        ["test.txt", encoder.encode("Hello World")],
        ["src/main.ts", encoder.encode("console.log('Hi')")],
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ path: "test.txt", error: null });
      expect(results[1]).toEqual({ path: "src/main.ts", error: null });
    });

    it("should handle upload errors", async () => {
      mockSandbox.fs.uploadFile.mockRejectedValueOnce(
        new Error("Permission denied"),
      );

      const sandbox = await DaytonaSandbox.create();
      const encoder = new TextEncoder();

      const results = await sandbox.uploadFiles([
        ["protected/file.txt", encoder.encode("content")],
      ]);

      expect(results[0].error).toBe("permission_denied");
    });
  });

  describe("downloadFiles", () => {
    it("should download files successfully", async () => {
      const content = Buffer.from("Hello World");
      mockSandbox.fs.downloadFile.mockResolvedValueOnce(content);

      const sandbox = await DaytonaSandbox.create();
      const results = await sandbox.downloadFiles(["test.txt"]);

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("test.txt");
      expect(results[0].content).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(results[0].content!)).toBe("Hello World");
    });

    it("should handle file not found", async () => {
      mockSandbox.fs.downloadFile.mockRejectedValueOnce(
        new Error("File not found"),
      );

      const sandbox = await DaytonaSandbox.create();
      const results = await sandbox.downloadFiles(["missing.txt"]);

      expect(results[0].content).toBeNull();
      expect(results[0].error).toBe("file_not_found");
    });
  });

  describe("lifecycle methods", () => {
    it("should stop sandbox", async () => {
      const sandbox = await DaytonaSandbox.create();
      await sandbox.stop();

      expect(mockSandbox.stop).toHaveBeenCalled();
    });

    it("should start sandbox", async () => {
      const sandbox = await DaytonaSandbox.create();
      await sandbox.start();

      expect(mockSandbox.start).toHaveBeenCalled();
    });

    it("should close and delete sandbox", async () => {
      const sandbox = await DaytonaSandbox.create();
      await sandbox.close();

      expect(mockSandbox.delete).toHaveBeenCalled();
      expect(sandbox.isRunning).toBe(false);
    });

    it("should get working directory", async () => {
      const sandbox = await DaytonaSandbox.create();
      const workDir = await sandbox.getWorkDir();

      expect(workDir).toBe("/home/daytona");
    });

    it("should get user home directory", async () => {
      const sandbox = await DaytonaSandbox.create();
      const homeDir = await sandbox.getUserHomeDir();

      expect(homeDir).toBe("/home/daytona");
    });
  });

  describe("static connect", () => {
    it("should connect to existing sandbox", async () => {
      const sandbox = await DaytonaSandbox.connect("existing-sandbox-id");

      expect(sandbox).toBeInstanceOf(DaytonaSandbox);
      expect(sandbox.isRunning).toBe(true);
    });

    it("should throw when sandbox not found", async () => {
      mockDaytonaInstance.get.mockRejectedValueOnce(new Error("Not found"));

      await expect(
        DaytonaSandbox.connect("nonexistent-sandbox"),
      ).rejects.toThrow("Sandbox not found");
    });
  });
});

describe("DaytonaSandboxError", () => {
  it("should create error with message and code", () => {
    const error = new DaytonaSandboxError("Test error", "NOT_INITIALIZED");

    expect(error.message).toBe("Test error");
    expect(error.code).toBe("NOT_INITIALIZED");
    expect(error.name).toBe("DaytonaSandboxError");
  });

  it("should preserve cause", () => {
    const cause = new Error("Original error");
    const error = new DaytonaSandboxError("Wrapper", "COMMAND_FAILED", cause);

    expect(error.cause).toBe(cause);
  });

  it("should be instanceof Error", () => {
    const error = new DaytonaSandboxError("Test", "NOT_INITIALIZED");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DaytonaSandboxError);
  });
});
