import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock state ──────────────────────────────────────────────────────────────

interface MockSession {
  run: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  listDir: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const mockState: {
  session: MockSession | null;
  createNodeCalls: unknown[];
  createBrowserCalls: unknown[];
} = {
  session: null,
  createNodeCalls: [],
  createBrowserCalls: [],
};

function createMockSession(): MockSession {
  return {
    run: vi.fn().mockResolvedValue({
      events: [],
      stdout: "",
      stderr: "",
      output: "",
      exitCode: 0,
    }),
    writeFile: vi.fn().mockResolvedValue({ events: [] }),
    readFile: vi.fn().mockResolvedValue({
      events: [],
      content: new Uint8Array(),
    }),
    listDir: vi.fn().mockResolvedValue({ events: [], output: "" }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Mock wasmsh-pyodide ─────────────────────────────────────────────────────

vi.mock("@mayflowergmbh/wasmsh-pyodide", () => ({
  DEFAULT_WORKSPACE_DIR: "/workspace",
  createNodeSession: vi.fn(async (options: unknown) => {
    mockState.createNodeCalls.push(options);
    const session = createMockSession();
    mockState.session = session;
    return session;
  }),
  createBrowserWorkerSession: vi.fn(async (options: unknown) => {
    mockState.createBrowserCalls.push(options);
    const session = createMockSession();
    mockState.session = session;
    return session;
  }),
}));

// Import AFTER mocks are defined
import { WasmshSandbox } from "./sandbox.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function diagnosticEvent(message: string): unknown[] {
  return [{ Diagnostic: ["Error", message] }];
}

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockState.session = null;
  mockState.createNodeCalls = [];
  mockState.createBrowserCalls = [];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("WasmshSandbox.createNode", () => {
  it("creates a session with default options", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      expect(mockState.createNodeCalls).toHaveLength(1);
      expect(mockState.createNodeCalls[0]).toEqual({
        assetDir: undefined,
        stepBudget: undefined,
        initialFiles: [],
      });
    } finally {
      await sandbox.stop();
    }
  });

  it("passes distPath as assetDir", async () => {
    const sandbox = await WasmshSandbox.createNode({
      distPath: "/custom/assets",
    });
    try {
      expect(mockState.createNodeCalls[0]).toMatchObject({
        assetDir: "/custom/assets",
      });
    } finally {
      await sandbox.stop();
    }
  });

  it("passes stepBudget through", async () => {
    const sandbox = await WasmshSandbox.createNode({ stepBudget: 5000 });
    try {
      expect(mockState.createNodeCalls[0]).toMatchObject({
        stepBudget: 5000,
      });
    } finally {
      await sandbox.stop();
    }
  });

  it("encodes string initialFiles as Uint8Array", async () => {
    const sandbox = await WasmshSandbox.createNode({
      initialFiles: { "/workspace/hello.txt": "hello" },
    });
    try {
      const call = mockState.createNodeCalls[0] as {
        initialFiles: Array<{ path: string; content: Uint8Array }>;
      };
      expect(call.initialFiles).toHaveLength(1);
      expect(call.initialFiles[0].path).toBe("/workspace/hello.txt");
      expect(decoder.decode(call.initialFiles[0].content)).toBe("hello");
    } finally {
      await sandbox.stop();
    }
  });

  it("passes Uint8Array initialFiles unchanged", async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x42]);
    const sandbox = await WasmshSandbox.createNode({
      initialFiles: { "/workspace/bin": bytes },
    });
    try {
      const call = mockState.createNodeCalls[0] as {
        initialFiles: Array<{ path: string; content: Uint8Array }>;
      };
      expect(call.initialFiles[0].content).toEqual(bytes);
    } finally {
      await sandbox.stop();
    }
  });
});

describe("WasmshSandbox.createBrowserWorker", () => {
  it("passes assetBaseUrl and worker", async () => {
    const fakeWorker = {} as Worker;
    const sandbox = await WasmshSandbox.createBrowserWorker({
      assetBaseUrl: "https://cdn.example.com/assets",
      worker: fakeWorker,
    });
    try {
      expect(mockState.createBrowserCalls).toHaveLength(1);
      expect(mockState.createBrowserCalls[0]).toMatchObject({
        assetBaseUrl: "https://cdn.example.com/assets",
        worker: fakeWorker,
      });
    } finally {
      await sandbox.stop();
    }
  });
});

describe("lifecycle", () => {
  it("id starts with wasmsh- prefix", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      expect(sandbox.id).toMatch(
        /^wasmsh-node-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      await sandbox.stop();
    }
  });

  it("isRunning is true after creation", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      expect(sandbox.isRunning).toBe(true);
    } finally {
      await sandbox.stop();
    }
  });

  it("isRunning is false after stop", async () => {
    const sandbox = await WasmshSandbox.createNode();
    await sandbox.stop();
    expect(sandbox.isRunning).toBe(false);
  });

  it("stop calls session.close", async () => {
    const sandbox = await WasmshSandbox.createNode();
    const session = mockState.session!;
    await sandbox.stop();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("stop is idempotent", async () => {
    const sandbox = await WasmshSandbox.createNode();
    const session = mockState.session!;
    await sandbox.stop();
    await sandbox.stop();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("close delegates to stop", async () => {
    const sandbox = await WasmshSandbox.createNode();
    const session = mockState.session!;
    await sandbox.close();
    expect(session.close).toHaveBeenCalledOnce();
    expect(sandbox.isRunning).toBe(false);
  });
});

describe("execute", () => {
  it("prepends cd to working directory", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      await sandbox.execute("echo hi");
      expect(mockState.session!.run).toHaveBeenCalledWith(
        "cd '/workspace' && echo hi",
      );
    } finally {
      await sandbox.stop();
    }
  });

  it("uses custom working directory", async () => {
    const sandbox = await WasmshSandbox.createNode({
      workingDirectory: "/home/user",
    });
    try {
      await sandbox.execute("ls");
      expect(mockState.session!.run).toHaveBeenCalledWith(
        "cd '/home/user' && ls",
      );
    } finally {
      await sandbox.stop();
    }
  });

  it("shell-quotes directory with single quotes", async () => {
    const sandbox = await WasmshSandbox.createNode({
      workingDirectory: "/path/with's",
    });
    try {
      await sandbox.execute("pwd");
      expect(mockState.session!.run).toHaveBeenCalledWith(
        "cd '/path/with'\\''s' && pwd",
      );
    } finally {
      await sandbox.stop();
    }
  });

  it("returns output and exitCode from session result", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      mockState.session!.run.mockResolvedValueOnce({
        events: [],
        stdout: "hello\n",
        stderr: "",
        output: "hello\n",
        exitCode: 0,
      });
      const result = await sandbox.execute("echo hello");
      expect(result).toEqual({
        output: "hello\n",
        exitCode: 0,
        truncated: false,
      });
    } finally {
      await sandbox.stop();
    }
  });

  it("returns non-zero exit code", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      mockState.session!.run.mockResolvedValueOnce({
        events: [],
        stdout: "",
        stderr: "fail",
        output: "fail",
        exitCode: 1,
      });
      const result = await sandbox.execute("false");
      expect(result.exitCode).toBe(1);
    } finally {
      await sandbox.stop();
    }
  });

  it("throws if not initialized", async () => {
    const sandbox = await WasmshSandbox.createNode();
    await sandbox.stop();
    await expect(sandbox.execute("echo")).rejects.toThrow(
      "WasmshSandbox is not initialized",
    );
  });
});

describe("uploadFiles", () => {
  it("writes file via session.writeFile", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      const content = encoder.encode("data");
      const result = await sandbox.uploadFiles([["/workspace/a.txt", content]]);
      expect(mockState.session!.writeFile).toHaveBeenCalledWith(
        "/workspace/a.txt",
        content,
      );
      expect(result).toEqual([{ path: "/workspace/a.txt", error: null }]);
    } finally {
      await sandbox.stop();
    }
  });

  it("rejects relative paths", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      const result = await sandbox.uploadFiles([
        ["relative.txt", encoder.encode("data")],
      ]);
      expect(result).toEqual([{ path: "relative.txt", error: "invalid_path" }]);
      expect(mockState.session!.writeFile).not.toHaveBeenCalled();
    } finally {
      await sandbox.stop();
    }
  });

  it("maps diagnostic not-found to file_not_found", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      mockState.session!.writeFile.mockResolvedValueOnce({
        events: diagnosticEvent("path not found"),
      });
      const result = await sandbox.uploadFiles([
        ["/workspace/a.txt", encoder.encode("")],
      ]);
      expect(result[0].error).toBe("file_not_found");
    } finally {
      await sandbox.stop();
    }
  });

  it("maps diagnostic directory to is_directory", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      mockState.session!.writeFile.mockResolvedValueOnce({
        events: diagnosticEvent("is a directory"),
      });
      const result = await sandbox.uploadFiles([
        ["/workspace/dir", encoder.encode("")],
      ]);
      expect(result[0].error).toBe("is_directory");
    } finally {
      await sandbox.stop();
    }
  });

  it("maps session exception to invalid_path", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      mockState.session!.writeFile.mockRejectedValueOnce(new Error("boom"));
      const result = await sandbox.uploadFiles([
        ["/workspace/a.txt", encoder.encode("")],
      ]);
      expect(result[0].error).toBe("invalid_path");
    } finally {
      await sandbox.stop();
    }
  });

  it("throws if not initialized", async () => {
    const sandbox = await WasmshSandbox.createNode();
    await sandbox.stop();
    await expect(
      sandbox.uploadFiles([["/workspace/a.txt", encoder.encode("")]]),
    ).rejects.toThrow("WasmshSandbox is not initialized");
  });
});

describe("downloadFiles", () => {
  it("returns decoded content from session.readFile", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      const expected = encoder.encode("file content");
      mockState.session!.readFile.mockResolvedValueOnce({
        events: [],
        content: expected,
      });
      const result = await sandbox.downloadFiles(["/workspace/a.txt"]);
      expect(result).toEqual([
        { path: "/workspace/a.txt", content: expected, error: null },
      ]);
    } finally {
      await sandbox.stop();
    }
  });

  it("rejects relative paths", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      const result = await sandbox.downloadFiles(["relative.txt"]);
      expect(result).toEqual([
        { path: "relative.txt", content: null, error: "invalid_path" },
      ]);
      expect(mockState.session!.readFile).not.toHaveBeenCalled();
    } finally {
      await sandbox.stop();
    }
  });

  it("maps diagnostic not-found to file_not_found", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      mockState.session!.readFile.mockResolvedValueOnce({
        events: diagnosticEvent("not found"),
        content: new Uint8Array(),
      });
      const result = await sandbox.downloadFiles(["/workspace/missing.txt"]);
      expect(result[0].error).toBe("file_not_found");
      expect(result[0].content).toBeNull();
    } finally {
      await sandbox.stop();
    }
  });

  it("maps diagnostic directory to is_directory", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      mockState.session!.readFile.mockResolvedValueOnce({
        events: diagnosticEvent("is a directory"),
        content: new Uint8Array(),
      });
      const result = await sandbox.downloadFiles(["/workspace/dir"]);
      expect(result[0].error).toBe("is_directory");
    } finally {
      await sandbox.stop();
    }
  });

  it("maps diagnostic permission to permission_denied", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      mockState.session!.readFile.mockResolvedValueOnce({
        events: diagnosticEvent("permission denied"),
        content: new Uint8Array(),
      });
      const result = await sandbox.downloadFiles(["/workspace/secret"]);
      expect(result[0].error).toBe("permission_denied");
    } finally {
      await sandbox.stop();
    }
  });

  it("maps session exception to invalid_path", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      mockState.session!.readFile.mockRejectedValueOnce(new Error("boom"));
      const result = await sandbox.downloadFiles(["/workspace/a.txt"]);
      expect(result[0].error).toBe("invalid_path");
      expect(result[0].content).toBeNull();
    } finally {
      await sandbox.stop();
    }
  });

  it("throws if not initialized", async () => {
    const sandbox = await WasmshSandbox.createNode();
    await sandbox.stop();
    await expect(sandbox.downloadFiles(["/workspace/a.txt"])).rejects.toThrow(
      "WasmshSandbox is not initialized",
    );
  });
});

describe("inherited BaseSandbox methods", () => {
  it("exposes read, write, edit, ls, grep, glob", async () => {
    const sandbox = await WasmshSandbox.createNode();
    try {
      expect(typeof sandbox.read).toBe("function");
      expect(typeof sandbox.write).toBe("function");
      expect(typeof sandbox.edit).toBe("function");
      expect(typeof sandbox.ls).toBe("function");
      expect(typeof sandbox.grep).toBe("function");
      expect(typeof sandbox.glob).toBe("function");
    } finally {
      await sandbox.stop();
    }
  });
});
