/* oxlint-disable no-instanceof/no-instanceof */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VercelSandboxError } from "./types.js";

type CreateOptions = Record<string, unknown> & {
  name?: string;
  persistent?: boolean;
  onCreate?: (sandbox: MockSandboxType) => Promise<void>;
};

interface MockCommandType {
  exitCode: number | null;
  stdoutText: string;
  stderrText: string;
  waitError: Error | null;
  stdoutError: Error | null;
  waitPromise: Promise<MockCommandType> | null;
  kill: ReturnType<typeof vi.fn>;
  wait: () => Promise<MockCommandType>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
}

interface MockSandboxType {
  name: string;
  status: string;
  files: Map<string, Uint8Array | Error | null>;
  nextCommand: MockCommandType;
  writeError: Error | null;
  deleted: boolean;
  stopped: boolean;
  setNextCommandResult: (
    stdoutText: string,
    stderrText: string,
    exitCode: number,
  ) => void;
  addFile: (path: string, content: string | Uint8Array) => void;
  runCommand: ReturnType<typeof vi.fn>;
  writeFiles: ReturnType<typeof vi.fn>;
  readFileToBuffer: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

const mockState = {
  sandboxInstance: null as MockSandboxType | null,
  createCalls: [] as CreateOptions[],
  getCalls: [] as Array<Record<string, unknown>>,
  getOrCreateCalls: [] as CreateOptions[],
  sandboxes: new Map<string, MockSandboxType>(),
};

class MockCommand implements MockCommandType {
  exitCode: number | null;

  stdoutText: string;

  stderrText: string;

  waitError: Error | null = null;

  stdoutError: Error | null = null;

  waitPromise: Promise<MockCommandType> | null = null;

  kill = vi.fn(async () => {});

  constructor({
    stdoutText = "",
    stderrText = "",
    exitCode = 0,
  }: {
    stdoutText?: string;
    stderrText?: string;
    exitCode?: number | null;
  } = {}) {
    this.stdoutText = stdoutText;
    this.stderrText = stderrText;
    this.exitCode = exitCode;
  }

  async wait(): Promise<MockCommandType> {
    if (this.waitPromise) {
      return this.waitPromise;
    }
    if (this.waitError) {
      throw this.waitError;
    }
    return this;
  }

  async stdout(): Promise<string> {
    if (this.stdoutError) {
      throw this.stdoutError;
    }
    return this.stdoutText;
  }

  async stderr(): Promise<string> {
    return this.stderrText;
  }
}

vi.mock("@vercel/sandbox", () => {
  class MockSandbox {
    name: string;

    status = "running";

    files: Map<string, Uint8Array | Error | null> = new Map();

    nextCommand: MockCommandType = new MockCommand({ stdoutText: "" });

    writeError: Error | null = null;

    deleted = false;

    stopped = false;

    constructor(name = "vercel-sandbox-mock-123") {
      this.name = name;
    }

    setNextCommandResult(
      stdoutText: string,
      stderrText: string,
      exitCode: number,
    ) {
      this.nextCommand = new MockCommand({
        stdoutText,
        stderrText,
        exitCode,
      });
    }

    addFile(path: string, content: string | Uint8Array) {
      this.files.set(
        path,
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content,
      );
    }

    runCommand = vi.fn(async () => this.nextCommand);

    writeFiles = vi.fn(
      async (files: Array<{ path: string; content: Uint8Array }>) => {
        if (this.writeError) {
          throw this.writeError;
        }
        for (const file of files) {
          this.files.set(file.path, file.content);
        }
      },
    );

    readFileToBuffer = vi.fn(async ({ path }: { path: string }) => {
      const value = this.files.get(path);
      if (value === undefined) {
        return null;
      }
      if (value instanceof Error) {
        throw value;
      }
      return value === null ? null : Buffer.from(value);
    });

    stop = vi.fn(async () => {
      this.stopped = true;
      this.status = "stopped";
    });

    delete = vi.fn(async () => {
      this.deleted = true;
      this.status = "deleted";
      mockState.sandboxes.delete(this.name);
    });

    static async create(options?: CreateOptions): Promise<MockSandbox> {
      mockState.createCalls.push(options ?? {});
      const sandbox = new MockSandbox(options?.name);
      mockState.sandboxInstance = sandbox as unknown as MockSandboxType;
      mockState.sandboxes.set(
        sandbox.name,
        sandbox as unknown as MockSandboxType,
      );
      return sandbox;
    }

    static async get(options: { name: string }): Promise<MockSandbox> {
      mockState.getCalls.push(options);
      const existing = mockState.sandboxes.get(options.name);
      if (existing) {
        mockState.sandboxInstance = existing;
        return existing as unknown as MockSandbox;
      }
      const sandbox = new MockSandbox(options.name);
      mockState.sandboxInstance = sandbox as unknown as MockSandboxType;
      mockState.sandboxes.set(
        options.name,
        sandbox as unknown as MockSandboxType,
      );
      return sandbox;
    }

    static async getOrCreate(options?: CreateOptions): Promise<MockSandbox> {
      mockState.getOrCreateCalls.push(options ?? {});
      if (options?.name) {
        const existing = mockState.sandboxes.get(options.name);
        if (existing) {
          mockState.sandboxInstance = existing;
          return existing as unknown as MockSandbox;
        }
      }
      const sandbox = new MockSandbox(options?.name);
      mockState.sandboxInstance = sandbox as unknown as MockSandboxType;
      mockState.sandboxes.set(
        sandbox.name,
        sandbox as unknown as MockSandboxType,
      );
      await options?.onCreate?.(sandbox as unknown as MockSandboxType);
      return sandbox;
    }
  }

  return { Sandbox: MockSandbox };
});

import { MAX_OUTPUT_BYTES, VercelSandbox } from "./sandbox.js";

describe("VercelSandbox", () => {
  beforeEach(() => {
    mockState.sandboxInstance = null;
    mockState.createCalls = [];
    mockState.getCalls = [];
    mockState.getOrCreateCalls = [];
    mockState.sandboxes = new Map();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("sets default state", () => {
      const sandbox = new VercelSandbox();

      expect(sandbox.id).toMatch(/^vercel-sandbox-\d+$/);
      expect(sandbox.isRunning).toBe(false);
    });

    it("wraps an existing SDK sandbox", () => {
      const sdkSandbox = {
        name: "existing-name",
      } as unknown as MockSandboxType;

      const sandbox = new VercelSandbox({
        sandbox: sdkSandbox as never,
      });

      expect(sandbox.id).toBe("existing-name");
      expect(sandbox.isRunning).toBe(true);
      expect(sandbox.instance).toBe(sdkSandbox);
    });

    it("rejects negative default command timeouts", () => {
      expect(() => new VercelSandbox({ commandTimeoutMs: -1 })).toThrow(
        VercelSandboxError,
      );
    });

    it("identifies provider errors", () => {
      const error = new VercelSandboxError("test", "INVALID_OPTIONS");

      expect(VercelSandboxError.isInstance(error)).toBe(true);
    });
  });

  describe("initialize and create", () => {
    it("creates a sandbox through the SDK", async () => {
      const sandbox = new VercelSandbox({ runtime: "node24" });

      await sandbox.initialize();

      expect(sandbox.id).toBe("vercel-sandbox-mock-123");
      expect(sandbox.isRunning).toBe(true);
      expect(mockState.createCalls).toHaveLength(1);
      expect(mockState.createCalls[0].runtime).toBe("node24");
    });

    it("passes persistent false by default", async () => {
      await VercelSandbox.create();

      expect(mockState.createCalls[0].persistent).toBe(false);
    });

    it("passes explicit persistent true through", async () => {
      await VercelSandbox.create({ persistent: true });

      expect(mockState.createCalls[0].persistent).toBe(true);
    });

    it("uploads initial files", async () => {
      await VercelSandbox.create({
        initialFiles: {
          "a.txt": "a",
          "/vercel/sandbox/b.bin": new Uint8Array([98]),
        },
      });

      expect(mockState.sandboxInstance?.writeFiles).toHaveBeenCalledWith([
        {
          path: "a.txt",
          content: new TextEncoder().encode("a"),
        },
        {
          path: "/vercel/sandbox/b.bin",
          content: new Uint8Array([98]),
        },
      ]);
    });

    it("static create wraps an existing SDK sandbox", async () => {
      const sdkSandbox = {
        name: "wrapped-by-create",
      } as unknown as MockSandboxType;

      const sandbox = await VercelSandbox.create({
        sandbox: sdkSandbox as never,
      });

      expect(sandbox.id).toBe("wrapped-by-create");
      expect(mockState.createCalls).toHaveLength(0);
    });

    it("preserves initial file upload errors", async () => {
      const existing = await VercelSandbox.create();
      mockState.sandboxInstance!.writeError = new Error("write failed");

      await expect(
        VercelSandbox.create({
          sandbox: existing.instance,
          initialFiles: {
            "relative.txt": "content",
          },
        }),
      ).rejects.toMatchObject({ code: "FILE_OPERATION_FAILED" });
    });

    it("throws when initialized twice", async () => {
      const sandbox = new VercelSandbox();
      await sandbox.initialize();

      await expect(sandbox.initialize()).rejects.toMatchObject({
        code: "ALREADY_INITIALIZED",
      });
    });
  });

  describe("named lifecycle", () => {
    it("getOrCreate wraps the SDK sandbox", async () => {
      const sandbox = await VercelSandbox.getOrCreate({
        name: "named-workspace",
        persistent: true,
      });

      expect(sandbox.id).toBe("named-workspace");
      expect(mockState.getOrCreateCalls[0]).toMatchObject({
        name: "named-workspace",
        persistent: true,
      });
    });

    it("fromName retrieves an existing named sandbox", async () => {
      await VercelSandbox.getOrCreate({ name: "existing" });

      const sandbox = await VercelSandbox.fromName("existing", {
        resume: true,
      });

      expect(sandbox.id).toBe("existing");
      expect(mockState.getCalls[0]).toMatchObject({
        name: "existing",
        resume: true,
      });
    });

    it("stop preserves the named sandbox while close and delete destroy it", async () => {
      const sandbox = await VercelSandbox.create({ persistent: true });
      const sdkSandbox = mockState.sandboxInstance!;

      await sandbox.stop();

      expect(sdkSandbox.stop).toHaveBeenCalled();
      expect(sandbox.isRunning).toBe(false);
      expect(sandbox.instance).toBe(sdkSandbox);

      await sandbox.close();

      expect(sdkSandbox.delete).toHaveBeenCalled();
      expect(sandbox.isRunning).toBe(false);
    });

    it("delete explicitly destroys the sandbox", async () => {
      const sandbox = await VercelSandbox.create();
      const sdkSandbox = mockState.sandboxInstance!;

      await sandbox.delete();

      expect(sdkSandbox.delete).toHaveBeenCalled();
      expect(sandbox.isRunning).toBe(false);
    });
  });

  describe("execute", () => {
    it("runs bash -lc commands with the default SDK timeout", async () => {
      const sandbox = await VercelSandbox.create({ commandTimeoutMs: 42 });

      await sandbox.execute("echo hello");

      expect(mockState.sandboxInstance?.runCommand).toHaveBeenCalledWith({
        cmd: "bash",
        args: ["-lc", "echo hello"],
        timeoutMs: 42,
      });
    });

    it("returns stdout and wraps stderr", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("out", "err\n", 0);

      const result = await sandbox.execute("test");

      expect(result).toEqual({
        output: "out\n<stderr>err</stderr>",
        exitCode: 0,
        truncated: false,
      });
    });

    it("preserves non-zero exit codes", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult("failed", "", 7);

      const result = await sandbox.execute("exit 7");

      expect(result.exitCode).toBe(7);
      expect(result.output).toBe("failed");
    });

    it("truncates output at the byte limit", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.setNextCommandResult(
        "x".repeat(MAX_OUTPUT_BYTES + 1),
        "",
        0,
      );

      const result = await sandbox.execute("yes");

      expect(result.truncated).toBe(true);
      expect(result.output).toBe(
        `${"x".repeat(MAX_OUTPUT_BYTES)}\n\n... Output truncated at ${MAX_OUTPUT_BYTES} bytes.`,
      );
    });

    it("omits the SDK timeout when timeout is zero", async () => {
      const sandbox = await VercelSandbox.create({ commandTimeoutMs: 0 });
      mockState.sandboxInstance!.setNextCommandResult("done", "", 0);

      const result = await sandbox.execute("echo done");

      expect(result.output).toBe("done");
      expect(result.exitCode).toBe(0);
      expect(mockState.sandboxInstance?.runCommand).toHaveBeenCalledWith({
        cmd: "bash",
        args: ["-lc", "echo done"],
      });
    });

    it("throws provider errors when command execution fails", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.runCommand.mockRejectedValueOnce(
        new Error("run failed"),
      );

      await expect(sandbox.execute("echo")).rejects.toMatchObject({
        code: "COMMAND_FAILED",
      });
    });

    it("returns exit code when log fetching fails", async () => {
      const sandbox = await VercelSandbox.create();
      const command = new MockCommand({ exitCode: 7 });
      command.stdoutError = new Error("logs failed");
      mockState.sandboxInstance!.nextCommand = command;

      const result = await sandbox.execute("echo");

      expect(result).toEqual({
        output: "<output unavailable: failed to fetch command logs>",
        exitCode: 7,
        truncated: false,
      });
    });
  });

  describe("uploadFiles", () => {
    it("batches relative and absolute uploads and preserves response order", async () => {
      const sandbox = await VercelSandbox.create();

      const results = await sandbox.uploadFiles([
        ["relative.txt", new TextEncoder().encode("relative")],
        ["/vercel/sandbox/ok.txt", new TextEncoder().encode("ok")],
        ["nested/other.txt", new TextEncoder().encode("other")],
      ]);

      expect(results).toEqual([
        { path: "relative.txt", error: null },
        { path: "/vercel/sandbox/ok.txt", error: null },
        { path: "nested/other.txt", error: null },
      ]);
      expect(mockState.sandboxInstance?.writeFiles).toHaveBeenCalledWith([
        {
          path: "relative.txt",
          content: new TextEncoder().encode("relative"),
        },
        {
          path: "/vercel/sandbox/ok.txt",
          content: new TextEncoder().encode("ok"),
        },
        {
          path: "nested/other.txt",
          content: new TextEncoder().encode("other"),
        },
      ]);
    });

    it("maps batch upload failures onto every path", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.writeError = Object.assign(
        new Error("permission denied"),
        { code: "EACCES" },
      );

      const results = await sandbox.uploadFiles([
        ["relative.txt", new Uint8Array()],
        ["/vercel/sandbox/ok.txt", new Uint8Array()],
      ]);

      expect(results).toEqual([
        { path: "relative.txt", error: "permission_denied" },
        { path: "/vercel/sandbox/ok.txt", error: "permission_denied" },
      ]);
    });

    it("maps unknown upload failures to invalid_path", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.writeError = new Error("network reset");

      const results = await sandbox.uploadFiles([
        ["/vercel/sandbox/ok.txt", new Uint8Array()],
      ]);

      expect(results[0].error).toBe("invalid_path");
    });
  });

  describe("downloadFiles", () => {
    it("downloads relative and absolute files and preserves partial success order", async () => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.addFile("relative.txt", "relative");
      mockState.sandboxInstance!.addFile("/vercel/sandbox/ok.txt", "ok");

      const results = await sandbox.downloadFiles([
        "relative.txt",
        "/vercel/sandbox/ok.txt",
        "missing.txt",
      ]);

      expect(new TextDecoder().decode(results[0].content!)).toBe("relative");
      expect(results[0].error).toBeNull();
      expect(new TextDecoder().decode(results[1].content!)).toBe("ok");
      expect(results[1].error).toBeNull();
      expect(results[2]).toEqual({
        path: "missing.txt",
        content: null,
        error: "file_not_found",
      });
    });

    it.each([
      [
        Object.assign(new Error("missing"), { code: "ENOENT" }),
        "file_not_found",
      ],
      [
        Object.assign(new Error("permission denied"), { code: "EACCES" }),
        "permission_denied",
      ],
      [
        Object.assign(new Error("is a directory"), { code: "EISDIR" }),
        "is_directory",
      ],
      [new Error("connection reset"), "invalid_path"],
    ] as const)("maps provider download error %#", async (error, expected) => {
      const sandbox = await VercelSandbox.create();
      mockState.sandboxInstance!.files.set("/vercel/sandbox/file.txt", error);

      const results = await sandbox.downloadFiles(["/vercel/sandbox/file.txt"]);

      expect(results[0]).toMatchObject({
        path: "/vercel/sandbox/file.txt",
        content: null,
        error: expected,
      });
    });
  });

  describe("inherited BaseSandbox methods", () => {
    it("exposes BaseSandbox helpers", async () => {
      const sandbox = await VercelSandbox.create();

      expect(typeof sandbox.read).toBe("function");
      expect(typeof sandbox.write).toBe("function");
      expect(typeof sandbox.edit).toBe("function");
      expect(typeof sandbox.ls).toBe("function");
      expect(typeof sandbox.grep).toBe("function");
      expect(typeof sandbox.glob).toBe("function");
    });
  });
});
