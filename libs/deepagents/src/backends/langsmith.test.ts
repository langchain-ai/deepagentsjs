import { describe, it, expect, vi, beforeEach } from "vitest";

// Declare mocks so we can access them from test bodies
let mockRun: ReturnType<typeof vi.fn>;
let mockRead: ReturnType<typeof vi.fn>;
let mockWrite: ReturnType<typeof vi.fn>;
let mockDelete: ReturnType<typeof vi.fn>;
let MockLangSmithResourceNotFoundError: new (message?: string) => Error;
let MockLangSmithSandboxError: new (message?: string) => Error;

vi.mock("langsmith/experimental/sandbox", () => {
  class LangSmithSandboxError extends Error {
    constructor(message: string = "Sandbox error") {
      super(message);
      this.name = "LangSmithSandboxError";
    }
  }

  class LangSmithResourceNotFoundError extends LangSmithSandboxError {
    constructor(message: string = "Not found") {
      super(message);
      this.name = "LangSmithResourceNotFoundError";
    }
  }

  return {
    LangSmithSandboxError,
    LangSmithResourceNotFoundError,
    Sandbox: class {},
    SandboxClient: class {},
  };
});

// Import after vi.mock hoisting resolves
import { LangSmithSandbox } from "./langsmith.js";
import {
  LangSmithResourceNotFoundError,
  LangSmithSandboxError,
} from "langsmith/experimental/sandbox";

function makeMockSandbox(name: string = "test-sandbox") {
  mockRun = vi.fn();
  mockRead = vi.fn();
  mockWrite = vi.fn();
  mockDelete = vi.fn().mockResolvedValue(undefined);
  MockLangSmithResourceNotFoundError = LangSmithResourceNotFoundError;
  MockLangSmithSandboxError = LangSmithSandboxError;

  // A plain object that satisfies the Sandbox interface shape for testing
  return {
    name,
    run: mockRun,
    read: mockRead,
    write: mockWrite,
    delete: mockDelete,
  };
}

function makeSandbox(options?: {
  name?: string;
  defaultTimeout?: number;
}): LangSmithSandbox {
  const mock = makeMockSandbox(options?.name ?? "test-sandbox");
  return new LangSmithSandbox({
    sandbox: mock as any,
    defaultTimeout: options?.defaultTimeout,
  });
}

describe("LangSmithSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("id", () => {
    it("returns the sandbox name as the ID", () => {
      const sandbox = makeSandbox({ name: "my-sandbox" });
      expect(sandbox.id).toBe("my-sandbox");
    });
  });

  describe("isRunning", () => {
    it("is true after construction", () => {
      const sandbox = makeSandbox();
      expect(sandbox.isRunning).toBe(true);
    });

    it("is false after close()", async () => {
      const sandbox = makeSandbox();
      await sandbox.close();
      expect(sandbox.isRunning).toBe(false);
    });

    it("calls sandbox.delete() on close()", async () => {
      const sandbox = makeSandbox();
      await sandbox.close();
      expect(mockDelete).toHaveBeenCalledOnce();
    });
  });

  describe("execute()", () => {
    it("returns stdout-only when stderr is empty", async () => {
      const sandbox = makeSandbox();
      mockRun.mockResolvedValue({ stdout: "hello", stderr: "", exit_code: 0 });

      const result = await sandbox.execute("echo hello");

      expect(result.output).toBe("hello");
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it("returns stderr-only when stdout is empty", async () => {
      const sandbox = makeSandbox();
      mockRun.mockResolvedValue({
        stdout: "",
        stderr: "error output",
        exit_code: 1,
      });

      const result = await sandbox.execute("bad command");

      expect(result.output).toBe("error output");
      expect(result.exitCode).toBe(1);
    });

    it("combines stdout and stderr with newline separator", async () => {
      const sandbox = makeSandbox();
      mockRun.mockResolvedValue({
        stdout: "out",
        stderr: "err",
        exit_code: 0,
      });

      const result = await sandbox.execute("cmd");

      expect(result.output).toBe("out\nerr");
    });

    it("returns the exitCode from the SDK result", async () => {
      const sandbox = makeSandbox();
      mockRun.mockResolvedValue({ stdout: "", stderr: "", exit_code: 42 });

      const result = await sandbox.execute("exit 42");

      expect(result.exitCode).toBe(42);
    });

    it("always sets truncated: false", async () => {
      const sandbox = makeSandbox();
      mockRun.mockResolvedValue({
        stdout: "x".repeat(10000),
        stderr: "",
        exit_code: 0,
      });

      const result = await sandbox.execute("big output");

      expect(result.truncated).toBe(false);
    });

    it("passes defaultTimeout when options.timeout is absent", async () => {
      const sandbox = makeSandbox({ defaultTimeout: 600 });
      mockRun.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 });

      await sandbox.execute("cmd");

      expect(mockRun).toHaveBeenCalledWith("cmd", { timeout: 600 });
    });

    it("uses default 1800s timeout when no defaultTimeout is provided", async () => {
      const sandbox = makeSandbox(); // no defaultTimeout
      mockRun.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 });

      await sandbox.execute("cmd");

      expect(mockRun).toHaveBeenCalledWith("cmd", { timeout: 1800 });
    });

    it("passes overridden timeout when options.timeout is provided", async () => {
      const sandbox = makeSandbox({ defaultTimeout: 600 });
      mockRun.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 });

      await sandbox.execute("cmd", { timeout: 30 });

      expect(mockRun).toHaveBeenCalledWith("cmd", { timeout: 30 });
    });

    it("allows options.timeout to override even with zero", async () => {
      const sandbox = makeSandbox({ defaultTimeout: 600 });
      mockRun.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 });

      await sandbox.execute("cmd", { timeout: 0 });

      expect(mockRun).toHaveBeenCalledWith("cmd", { timeout: 0 });
    });
  });

  describe("downloadFiles()", () => {
    it("returns content on success", async () => {
      const sandbox = makeSandbox();
      const content = new Uint8Array([1, 2, 3]);
      mockRead.mockResolvedValue(content);

      const [result] = await sandbox.downloadFiles(["/tmp/file.txt"]);

      expect(result.path).toBe("/tmp/file.txt");
      expect(result.content).toBe(content);
      expect(result.error).toBeNull();
    });

    it("maps LangSmithResourceNotFoundError to file_not_found", async () => {
      const sandbox = makeSandbox();
      mockRead.mockRejectedValue(
        new MockLangSmithResourceNotFoundError("file not found"),
      );

      const [result] = await sandbox.downloadFiles(["/tmp/missing.txt"]);

      expect(result.error).toBe("file_not_found");
      expect(result.content).toBeNull();
    });

    it("maps LangSmithSandboxError with 'is a directory' to is_directory", async () => {
      const sandbox = makeSandbox();
      mockRead.mockRejectedValue(
        new MockLangSmithSandboxError("/tmp/mydir: is a directory"),
      );

      const [result] = await sandbox.downloadFiles(["/tmp/mydir"]);

      expect(result.error).toBe("is_directory");
      expect(result.content).toBeNull();
    });

    it("maps generic LangSmithSandboxError to file_not_found", async () => {
      const sandbox = makeSandbox();
      mockRead.mockRejectedValue(
        new MockLangSmithSandboxError("some other sandbox error"),
      );

      const [result] = await sandbox.downloadFiles(["/tmp/file.txt"]);

      expect(result.error).toBe("file_not_found");
      expect(result.content).toBeNull();
    });

    it("maps unknown errors to invalid_path", async () => {
      const sandbox = makeSandbox();
      mockRead.mockRejectedValue(new TypeError("network error"));

      const [result] = await sandbox.downloadFiles(["/tmp/file.txt"]);

      expect(result.error).toBe("invalid_path");
      expect(result.content).toBeNull();
    });

    it("supports partial success across multiple paths", async () => {
      const sandbox = makeSandbox();
      const content = new TextEncoder().encode("hello");
      mockRead
        .mockResolvedValueOnce(content)
        .mockRejectedValueOnce(new MockLangSmithResourceNotFoundError())
        .mockRejectedValueOnce(new TypeError("unexpected"));

      const results = await sandbox.downloadFiles([
        "/tmp/exists.txt",
        "/tmp/missing.txt",
        "/tmp/bad",
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].error).toBeNull();
      expect(results[0].content).toBe(content);
      expect(results[1].error).toBe("file_not_found");
      expect(results[2].error).toBe("invalid_path");
    });

    it("preserves response order matching input order", async () => {
      const sandbox = makeSandbox();
      const c1 = new TextEncoder().encode("first");
      const c2 = new TextEncoder().encode("second");
      mockRead.mockResolvedValueOnce(c1).mockResolvedValueOnce(c2);

      const results = await sandbox.downloadFiles(["/tmp/a.txt", "/tmp/b.txt"]);

      expect(results[0].path).toBe("/tmp/a.txt");
      expect(results[0].content).toBe(c1);
      expect(results[1].path).toBe("/tmp/b.txt");
      expect(results[1].content).toBe(c2);
    });
  });

  describe("uploadFiles()", () => {
    it("returns error: null on success", async () => {
      const sandbox = makeSandbox();
      mockWrite.mockResolvedValue(undefined);

      const content = new TextEncoder().encode("hello");
      const [result] = await sandbox.uploadFiles([["/tmp/file.txt", content]]);

      expect(result.path).toBe("/tmp/file.txt");
      expect(result.error).toBeNull();
    });

    it("maps thrown error to permission_denied", async () => {
      const sandbox = makeSandbox();
      mockWrite.mockRejectedValue(new Error("write failed"));

      const [result] = await sandbox.uploadFiles([
        ["/tmp/file.txt", new Uint8Array()],
      ]);

      expect(result.error).toBe("permission_denied");
    });

    it("supports partial success across multiple files", async () => {
      const sandbox = makeSandbox();
      mockWrite
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("permission denied"));

      const results = await sandbox.uploadFiles([
        ["/tmp/ok.txt", new TextEncoder().encode("ok")],
        ["/tmp/fail.txt", new TextEncoder().encode("fail")],
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].error).toBeNull();
      expect(results[1].error).toBe("permission_denied");
    });

    it("preserves response order matching input order", async () => {
      const sandbox = makeSandbox();
      mockWrite.mockResolvedValue(undefined);

      const results = await sandbox.uploadFiles([
        ["/tmp/first.txt", new TextEncoder().encode("1")],
        ["/tmp/second.txt", new TextEncoder().encode("2")],
      ]);

      expect(results[0].path).toBe("/tmp/first.txt");
      expect(results[1].path).toBe("/tmp/second.txt");
    });
  });

  describe("BaseSandbox inherited methods", () => {
    it.each(["read", "write", "edit", "ls", "grep", "glob"] as const)(
      "%s() is available on the sandbox",
      (method) => {
        const sandbox = makeSandbox();
        expect(typeof sandbox[method]).toBe("function");
      },
    );

    it("read() delegates to execute() via a shell command", async () => {
      const sandbox = makeSandbox();
      mockRun.mockResolvedValue({
        stdout: "     1\thello",
        stderr: "",
        exit_code: 0,
      });

      await sandbox.read("/tmp/file.txt");

      expect(mockRun).toHaveBeenCalledOnce();
      const [cmd] = mockRun.mock.calls[0] as [string, unknown];
      expect(typeof cmd).toBe("string");
      expect(cmd).toContain("/tmp/file.txt");
    });

    it("lsInfo() delegates to execute() via a shell command", async () => {
      const sandbox = makeSandbox();
      mockRun.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 });

      await sandbox.ls("/tmp");

      expect(mockRun).toHaveBeenCalledOnce();
      const [cmd] = mockRun.mock.calls[0] as [string, unknown];
      expect(typeof cmd).toBe("string");
      expect(cmd).toContain("find");
    });

    it("grepRaw() delegates to execute() via a shell command", async () => {
      const sandbox = makeSandbox();
      mockRun.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 });

      await sandbox.grep("pattern", "/tmp");

      expect(mockRun).toHaveBeenCalledOnce();
      const [cmd] = mockRun.mock.calls[0] as [string, unknown];
      expect(typeof cmd).toBe("string");
      expect(cmd).toContain("grep");
    });

    it("globInfo() delegates to execute() via a shell command", async () => {
      const sandbox = makeSandbox();
      mockRun.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 });

      await sandbox.glob("*.txt", "/tmp");

      expect(mockRun).toHaveBeenCalledOnce();
      const [cmd] = mockRun.mock.calls[0] as [string, unknown];
      expect(typeof cmd).toBe("string");
      expect(cmd).toContain("find");
    });

    it("write() delegates to uploadFiles() (not execute)", async () => {
      const sandbox = makeSandbox();
      // write() first checks if file exists via downloadFiles, then uploads
      // For a non-existent file: downloadFiles returns file_not_found, then uploadFiles is called
      mockRead.mockRejectedValue(new MockLangSmithResourceNotFoundError());
      mockWrite.mockResolvedValue(undefined);

      await sandbox.write("/tmp/new.txt", "content");

      expect(mockWrite).toHaveBeenCalledOnce();
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("edit() delegates to downloadFiles() and uploadFiles() (not execute)", async () => {
      const sandbox = makeSandbox();
      const existingContent = new TextEncoder().encode("hello world");
      mockRead.mockResolvedValue(existingContent);
      mockWrite.mockResolvedValue(undefined);

      await sandbox.edit("/tmp/file.txt", "hello", "goodbye");

      expect(mockRead).toHaveBeenCalledOnce();
      expect(mockWrite).toHaveBeenCalledOnce();
      expect(mockRun).not.toHaveBeenCalled();
    });
  });
});
