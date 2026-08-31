import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  SpritesSandbox,
  SpritesSandboxError,
  createSpritesSandboxFactory,
  createSpritesSandboxFactoryFromSandbox,
} from "./index.js";
import { ExecError, FilesystemError } from "@fly/sprites";

const { mockFilesystem, mockSprite, mockClient } = vi.hoisted(() => {
  const mockFilesystem = {
    writeFile: vi.fn(),
    readFile: vi.fn(),
  };

  const mockSprite = {
    name: "mock-sprite",
    execFile: vi.fn(),
    filesystem: vi.fn(() => mockFilesystem),
    delete: vi.fn(),
    createCheckpoint: vi.fn(),
    restoreCheckpoint: vi.fn(),
    listCheckpoints: vi.fn(),
  };

  const mockClient = {
    createSprite: vi.fn(),
    getSprite: vi.fn(),
    listAllSprites: vi.fn(),
  };

  return { mockFilesystem, mockSprite, mockClient };
});

vi.mock("@fly/sprites", () => {
  class MockExecError extends Error {
    constructor(
      message: string,
      public readonly result: {
        stdout: string;
        stderr: string;
        exitCode: number;
      },
    ) {
      super(message);
      this.name = "ExecError";
    }

    get exitCode() {
      return this.result.exitCode;
    }

    get stdout() {
      return this.result.stdout;
    }

    get stderr() {
      return this.result.stderr;
    }
  }

  class MockFilesystemError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly path: string,
    ) {
      super(message);
      this.name = "FilesystemError";
    }
  }

  return {
    SpritesClient: class MockSpritesClient {
      createSprite = mockClient.createSprite;
      getSprite = mockClient.getSprite;
      listAllSprites = mockClient.listAllSprites;
    },
    Sprite: class MockSprite {},
    ExecError: MockExecError,
    FilesystemError: MockFilesystemError,
  };
});

/** Build a mock checkpoint/restore stream that emits the given messages. */
function mockStream(
  messages: Array<{ type: string; data?: string; error?: string }>,
) {
  return {
    processAll: vi.fn(
      async (handler: (msg: (typeof messages)[number]) => void) => {
        for (const msg of messages) {
          handler(msg);
        }
      },
    ),
  };
}

describe("SpritesSandbox", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.SPRITES_TOKEN = "test-token";
    vi.clearAllMocks();
    mockClient.createSprite.mockResolvedValue(mockSprite);
    mockClient.getSprite.mockResolvedValue(mockSprite);
    mockSprite.execFile.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    mockSprite.filesystem.mockReturnValue(mockFilesystem);
    mockFilesystem.writeFile.mockResolvedValue(undefined);
    mockFilesystem.readFile.mockResolvedValue(Buffer.from("content"));
    mockSprite.delete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("constructor", () => {
    it("should create instance with default options", () => {
      const sandbox = new SpritesSandbox();
      expect(sandbox).toBeInstanceOf(SpritesSandbox);
      expect(sandbox.id).toMatch(/^deepagents-[0-9a-f]{8}$/);
    });

    it("should use the provided name as id", () => {
      const sandbox = new SpritesSandbox({ name: "my-sandbox" });
      expect(sandbox.id).toBe("my-sandbox");
    });

    it("should not be running before initialization", () => {
      const sandbox = new SpritesSandbox();
      expect(sandbox.isRunning).toBe(false);
    });

    it("should default the working directory", () => {
      const sandbox = new SpritesSandbox();
      expect(sandbox.workdir).toBe("/home/sprite");
    });

    it("should accept a custom working directory", () => {
      const sandbox = new SpritesSandbox({ workdir: "/app" });
      expect(sandbox.workdir).toBe("/app");
    });
  });

  describe("instance property", () => {
    it("should throw when accessed before initialization", () => {
      const sandbox = new SpritesSandbox();
      expect(() => sandbox.instance).toThrow(SpritesSandboxError);
      expect(() => sandbox.instance).toThrow("Sandbox not initialized");
    });
  });

  describe("initialize", () => {
    it("should initialize the sandbox", async () => {
      const sandbox = new SpritesSandbox({ name: "my-sandbox" });
      await sandbox.initialize();

      expect(sandbox.isRunning).toBe(true);
      expect(mockClient.createSprite).toHaveBeenCalledWith("my-sandbox", {});
    });

    it("should pass creation options through to the SDK", async () => {
      const sandbox = new SpritesSandbox({
        name: "my-sandbox",
        config: { ramMB: 2048, cpus: 2 },
        environment: { FOO: "bar" },
        labels: ["ci"],
        runtime: "dev",
        waitForCapacity: true,
      });
      await sandbox.initialize();

      expect(mockClient.createSprite).toHaveBeenCalledWith("my-sandbox", {
        config: { ramMB: 2048, cpus: 2 },
        environment: { FOO: "bar" },
        labels: ["ci"],
        runtime: "dev",
        waitForCapacity: true,
      });
    });

    it("should throw when initialized twice", async () => {
      const sandbox = new SpritesSandbox();
      await sandbox.initialize();

      await expect(sandbox.initialize()).rejects.toThrow(
        "Sandbox is already initialized",
      );
    });

    it("should throw on authentication failure", async () => {
      delete process.env.SPRITES_TOKEN;
      const sandbox = new SpritesSandbox();

      await expect(sandbox.initialize()).rejects.toThrow(
        "Failed to authenticate with Sprites",
      );
    });

    it("should throw SANDBOX_CREATION_FAILED when creation fails", async () => {
      mockClient.createSprite.mockRejectedValue(new Error("quota exceeded"));
      const sandbox = new SpritesSandbox();

      await expect(sandbox.initialize()).rejects.toMatchObject({
        code: "SANDBOX_CREATION_FAILED",
      });
    });

    it("should upload initial files", async () => {
      const sandbox = new SpritesSandbox({
        initialFiles: { "main.js": "console.log('hi')" },
      });
      await sandbox.initialize();

      expect(mockFilesystem.writeFile).toHaveBeenCalledWith(
        "main.js",
        Buffer.from("console.log('hi')"),
      );
    });

    it("should throw when initial file upload fails", async () => {
      mockFilesystem.writeFile.mockRejectedValue(
        new FilesystemError("denied", "EACCES", "main.js"),
      );
      const sandbox = new SpritesSandbox({
        initialFiles: { "main.js": "console.log('hi')" },
      });

      await expect(sandbox.initialize()).rejects.toMatchObject({
        code: "FILE_OPERATION_FAILED",
      });
    });
  });

  describe("static create", () => {
    it("should create and initialize in one step", async () => {
      const sandbox = await SpritesSandbox.create({ name: "one-step" });
      expect(sandbox.isRunning).toBe(true);
    });
  });

  describe("execute", () => {
    it("should run commands via bash -lc in the workdir", async () => {
      mockSprite.execFile.mockResolvedValue({
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
      });

      const sandbox = await SpritesSandbox.create();
      const result = await sandbox.execute("echo hello");

      expect(mockSprite.execFile).toHaveBeenCalledWith(
        "bash",
        ["-lc", "echo hello"],
        { cwd: "/home/sprite", timeout: 300_000 },
      );
      expect(result).toEqual({
        output: "hello\n",
        exitCode: 0,
        truncated: false,
      });
    });

    it("should combine stdout and stderr", async () => {
      mockSprite.execFile.mockResolvedValue({
        stdout: "out",
        stderr: "err",
        exitCode: 0,
      });

      const sandbox = await SpritesSandbox.create();
      const result = await sandbox.execute("some command");

      expect(result.output).toBe("outerr");
    });

    it("should return non-zero exit codes instead of throwing", async () => {
      mockSprite.execFile.mockRejectedValue(
        new ExecError("Command failed with exit code 2", {
          stdout: "",
          stderr: "boom\n",
          exitCode: 2,
        }),
      );

      const sandbox = await SpritesSandbox.create();
      const result = await sandbox.execute("exit 2");

      expect(result.exitCode).toBe(2);
      expect(result.output).toBe("boom\n");
    });

    it("should respect a custom timeout", async () => {
      const sandbox = await SpritesSandbox.create({ timeout: 10 });
      await sandbox.execute("true");

      expect(mockSprite.execFile).toHaveBeenCalledWith(
        "bash",
        ["-lc", "true"],
        { cwd: "/home/sprite", timeout: 10_000 },
      );
    });

    it("should throw COMMAND_TIMEOUT on timeout", async () => {
      mockSprite.execFile.mockRejectedValue(
        new Error("Command timed out after 300000 ms"),
      );

      const sandbox = await SpritesSandbox.create();

      await expect(sandbox.execute("sleep 1000")).rejects.toMatchObject({
        code: "COMMAND_TIMEOUT",
      });
    });

    it("should throw COMMAND_FAILED on other errors", async () => {
      mockSprite.execFile.mockRejectedValue(new Error("connection lost"));

      const sandbox = await SpritesSandbox.create();

      await expect(sandbox.execute("true")).rejects.toMatchObject({
        code: "COMMAND_FAILED",
      });
    });

    it("should throw when not initialized", async () => {
      const sandbox = new SpritesSandbox();
      await expect(sandbox.execute("true")).rejects.toThrow(
        "Sandbox not initialized",
      );
    });
  });

  describe("uploadFiles", () => {
    it("should upload files via the filesystem API", async () => {
      const sandbox = await SpritesSandbox.create();
      const encoder = new TextEncoder();

      const results = await sandbox.uploadFiles([
        ["a.txt", encoder.encode("aaa")],
        ["dir/b.txt", encoder.encode("bbb")],
      ]);

      expect(mockSprite.filesystem).toHaveBeenCalledWith("/home/sprite");
      expect(results).toEqual([
        { path: "a.txt", error: null },
        { path: "dir/b.txt", error: null },
      ]);
    });

    it("should report partial failures", async () => {
      mockFilesystem.writeFile
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new FilesystemError("denied", "EACCES", "b"));

      const sandbox = await SpritesSandbox.create();
      const encoder = new TextEncoder();

      const results = await sandbox.uploadFiles([
        ["a.txt", encoder.encode("aaa")],
        ["b.txt", encoder.encode("bbb")],
      ]);

      expect(results[0].error).toBeNull();
      expect(results[1].error).toBe("permission_denied");
    });
  });

  describe("downloadFiles", () => {
    it("should download file contents", async () => {
      mockFilesystem.readFile.mockResolvedValue(Buffer.from("hello"));

      const sandbox = await SpritesSandbox.create();
      const results = await sandbox.downloadFiles(["a.txt"]);

      expect(results[0].error).toBeNull();
      expect(new TextDecoder().decode(results[0].content!)).toBe("hello");
    });

    it("should map missing files to file_not_found", async () => {
      mockFilesystem.readFile
        .mockResolvedValueOnce(Buffer.from("hello"))
        .mockRejectedValueOnce(
          new FilesystemError("no such file", "ENOENT", "missing.txt"),
        );

      const sandbox = await SpritesSandbox.create();
      const results = await sandbox.downloadFiles(["a.txt", "missing.txt"]);

      expect(results[0].error).toBeNull();
      expect(results[1]).toMatchObject({
        content: null,
        error: "file_not_found",
      });
    });

    it("should map UNKNOWN-code errors by message", async () => {
      // The server does not always return a structured code; a missing file
      // can surface as code UNKNOWN with the raw Go error string.
      mockFilesystem.readFile.mockRejectedValue(
        new FilesystemError(
          "open /home/sprite/missing.txt: no such file or directory",
          "UNKNOWN",
          "missing.txt",
        ),
      );

      const sandbox = await SpritesSandbox.create();
      const results = await sandbox.downloadFiles(["missing.txt"]);

      expect(results[0].error).toBe("file_not_found");
    });

    it("should map directory errors to is_directory", async () => {
      mockFilesystem.readFile.mockRejectedValue(
        new FilesystemError("is a directory", "EISDIR", "dir"),
      );

      const sandbox = await SpritesSandbox.create();
      const results = await sandbox.downloadFiles(["dir"]);

      expect(results[0].error).toBe("is_directory");
    });
  });

  describe("close", () => {
    it("should delete the sprite", async () => {
      const sandbox = await SpritesSandbox.create();
      await sandbox.close();

      expect(mockSprite.delete).toHaveBeenCalled();
      expect(sandbox.isRunning).toBe(false);
    });

    it("should be a no-op when not initialized", async () => {
      const sandbox = new SpritesSandbox();
      await sandbox.close();

      expect(mockSprite.delete).not.toHaveBeenCalled();
    });

    it("kill should alias close", async () => {
      const sandbox = await SpritesSandbox.create();
      await sandbox.kill();

      expect(mockSprite.delete).toHaveBeenCalled();
      expect(sandbox.isRunning).toBe(false);
    });
  });

  describe("checkpoint", () => {
    it("should create a checkpoint and return the newest one", async () => {
      const older = {
        id: "v1",
        createTime: new Date("2026-01-01T00:00:00Z"),
      };
      const newest = {
        id: "v2",
        createTime: new Date("2026-02-01T00:00:00Z"),
        comment: "test",
      };
      mockSprite.createCheckpoint.mockResolvedValue(
        mockStream([{ type: "info", data: "starting" }, { type: "complete" }]),
      );
      mockSprite.listCheckpoints.mockResolvedValue([
        { id: "Current", createTime: new Date("2026-03-01T00:00:00Z") },
        older,
        newest,
      ]);

      const sandbox = await SpritesSandbox.create();
      const checkpoint = await sandbox.checkpoint("test");

      expect(mockSprite.createCheckpoint).toHaveBeenCalledWith("test");
      expect(checkpoint).toBe(newest);
    });

    it("should throw CHECKPOINT_FAILED on stream errors", async () => {
      mockSprite.createCheckpoint.mockResolvedValue(
        mockStream([{ type: "error", error: "disk full" }]),
      );

      const sandbox = await SpritesSandbox.create();

      await expect(sandbox.checkpoint()).rejects.toMatchObject({
        code: "CHECKPOINT_FAILED",
      });
    });
  });

  describe("restore", () => {
    it("should restore a checkpoint", async () => {
      mockSprite.restoreCheckpoint.mockResolvedValue(
        mockStream([{ type: "complete" }]),
      );

      const sandbox = await SpritesSandbox.create();
      await sandbox.restore("v1");

      expect(mockSprite.restoreCheckpoint).toHaveBeenCalledWith("v1");
    });

    it("should throw CHECKPOINT_FAILED on stream errors", async () => {
      mockSprite.restoreCheckpoint.mockResolvedValue(
        mockStream([{ type: "error", error: "no such checkpoint" }]),
      );

      const sandbox = await SpritesSandbox.create();

      await expect(sandbox.restore("v99")).rejects.toMatchObject({
        code: "CHECKPOINT_FAILED",
      });
    });
  });

  describe("fromName", () => {
    it("should connect to an existing sprite", async () => {
      const sandbox = await SpritesSandbox.fromName("mock-sprite");

      expect(mockClient.getSprite).toHaveBeenCalledWith("mock-sprite");
      expect(sandbox.isRunning).toBe(true);
      expect(sandbox.id).toBe("mock-sprite");
      expect(mockClient.createSprite).not.toHaveBeenCalled();
    });

    it("should throw SANDBOX_NOT_FOUND for missing sprites", async () => {
      mockClient.getSprite.mockRejectedValue(new Error("404"));

      await expect(SpritesSandbox.fromName("nope")).rejects.toMatchObject({
        code: "SANDBOX_NOT_FOUND",
      });
    });
  });

  describe("deleteAll", () => {
    it("should delete all sprites with the given prefix", async () => {
      const spriteA = { delete: vi.fn().mockResolvedValue(undefined) };
      const spriteB = { delete: vi.fn().mockRejectedValue(new Error("gone")) };
      mockClient.listAllSprites.mockResolvedValue([spriteA, spriteB]);

      const deleted = await SpritesSandbox.deleteAll("ci-");

      expect(mockClient.listAllSprites).toHaveBeenCalledWith("ci-");
      expect(deleted).toBe(1);
    });

    it("should reject an empty prefix", async () => {
      await expect(SpritesSandbox.deleteAll("")).rejects.toThrow(
        "non-empty name prefix",
      );
    });
  });

  describe("getWorkDir / getUserHomeDir", () => {
    it("should return the configured workdir", async () => {
      const sandbox = await SpritesSandbox.create({ workdir: "/app" });
      expect(await sandbox.getWorkDir()).toBe("/app");
    });

    it("should resolve the home directory via the shell", async () => {
      mockSprite.execFile.mockResolvedValue({
        stdout: "/home/sprite",
        stderr: "",
        exitCode: 0,
      });

      const sandbox = await SpritesSandbox.create();
      expect(await sandbox.getUserHomeDir()).toBe("/home/sprite");
    });
  });

  describe("factories", () => {
    it("createSpritesSandboxFactory should create a new sandbox per call", async () => {
      const factory = createSpritesSandboxFactory();

      const sandbox1 = await factory();
      const sandbox2 = await factory();

      expect(sandbox1).not.toBe(sandbox2);
      expect(mockClient.createSprite).toHaveBeenCalledTimes(2);
    });

    it("createSpritesSandboxFactoryFromSandbox should reuse the sandbox", async () => {
      const sandbox = await SpritesSandbox.create();
      const factory = createSpritesSandboxFactoryFromSandbox(sandbox);

      const runtime = {} as never;
      expect(factory(runtime)).toBe(sandbox);
      expect(factory(runtime)).toBe(sandbox);
    });
  });
});
