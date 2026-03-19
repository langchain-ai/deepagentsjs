import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";

// Mock deepagents to avoid langsmith/experimental/sandbox dependency
vi.mock("deepagents", () => ({
  adaptBackendProtocol: vi.fn((b) => b),
  StateBackend: vi.fn().mockImplementation(() => ({})),
}));

// Mock secure-exec — NodeRuntime must use `function` form to be constructable with `new`
vi.mock("secure-exec", () => {
  const MockNodeRuntime = vi.fn(function (
    this: { run: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> },
  ) {
    this.run = vi.fn().mockResolvedValue({ code: 0, exports: {} });
    this.dispose = vi.fn();
  });
  return {
    NodeRuntime: MockNodeRuntime,
    createNodeDriver: vi.fn().mockReturnValue({ type: "mock-system-driver" }),
    createNodeRuntimeDriverFactory: vi
      .fn()
      .mockReturnValue({ type: "mock-factory" }),
    allowAllFs: { fs: () => true },
    allowAllNetwork: { network: () => true },
  };
});

vi.mock("@secure-exec/typescript", () => ({
  createTypeScriptTools: vi.fn().mockReturnValue({
    compileSource: vi.fn().mockResolvedValue({ success: true, outputText: "" }),
  }),
}));

vi.mock("./transform.js", () => ({
  transformForEval: vi.fn().mockResolvedValue({
    fullSource: "(async () => { module.exports = { __result: undefined }; })()",
    result: {
      compiledCode: "",
      declarationSnippets: [],
      wasTypeScript: false,
      typeErrors: [],
    },
  }),
}));

import {
  SecureExecSession,
  DEFAULT_MEMORY_LIMIT_MB,
  DEFAULT_CPU_TIME_LIMIT_MS,
} from "./session.js";
import { transformForEval } from "./transform.js";
import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";

const TIMEOUT = 30_000;

type MockRuntimeInstance = {
  run: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

/** Helper to create a function-form mock implementation for NodeRuntime */
function makeRuntimeMock(
  runFn: () => Promise<unknown>,
): (this: MockRuntimeInstance) => void {
  return function (this: MockRuntimeInstance) {
    this.run = vi.fn().mockImplementation(runFn);
    this.dispose = vi.fn();
  };
}

/** Helper to create a runtime mock that captures onStdio from constructor args */
function makeRuntimeMockWithStdio(
  emitFn: (onStdio: (e: { channel: string; message: string }) => void) => Promise<unknown>,
): (this: MockRuntimeInstance, opts: { onStdio?: (e: { channel: string; message: string }) => void }) => void {
  return function (
    this: MockRuntimeInstance,
    opts: { onStdio?: (e: { channel: string; message: string }) => void },
  ) {
    const onStdio = opts.onStdio;
    this.run = vi.fn().mockImplementation(async () => {
      return onStdio ? emitFn(onStdio) : { code: 0, exports: {} };
    });
    this.dispose = vi.fn();
  };
}

function createMockBackend(files: Record<string, string> = {}) {
  const store = { ...files };
  const written: Record<string, string> = {};
  return {
    written,
    ls: vi.fn().mockResolvedValue({ files: [] }),
    read: vi.fn(async (p: string) => ({ content: store[p] ?? "" })),
    readRaw: vi.fn(async (p: string) => {
      if (!(p in store)) return { error: `ENOENT: ${p}` };
      const now = new Date().toISOString();
      return {
        data: {
          content: store[p],
          mimeType: "text/plain",
          created_at: now,
          modified_at: now,
        },
      };
    }),
    grep: vi.fn().mockResolvedValue({ matches: [] }),
    glob: vi.fn().mockResolvedValue({ files: [] }),
    write: vi.fn(async (p: string, c: string) => {
      store[p] = c;
      written[p] = c;
      return { path: p };
    }),
    edit: vi.fn().mockResolvedValue({ error: "not implemented" }),
  };
}

describe("SecureExecSession", () => {
  beforeEach(() => {
    SecureExecSession.clearCache();
    vi.clearAllMocks();

    (transformForEval as ReturnType<typeof vi.fn>).mockResolvedValue({
      fullSource:
        "(async () => { module.exports = { __result: undefined }; })()",
      result: {
        compiledCode: "",
        declarationSnippets: [],
        wasTypeScript: false,
        typeErrors: [],
      },
    });

    // Reset to default function-form mock
    (NodeRuntime as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function (this: MockRuntimeInstance) {
        this.run = vi.fn().mockResolvedValue({ code: 0, exports: {} });
        this.dispose = vi.fn();
      },
    );
  });

  afterEach(() => {
    SecureExecSession.clearCache();
  });

  describe("exports", () => {
    it("exports DEFAULT_MEMORY_LIMIT_MB as 64", () => {
      expect(DEFAULT_MEMORY_LIMIT_MB).toBe(64);
    });

    it("exports DEFAULT_CPU_TIME_LIMIT_MS as 30_000", () => {
      expect(DEFAULT_CPU_TIME_LIMIT_MS).toBe(30_000);
    });
  });

  describe("getOrCreate()", () => {
    it("returns the same session for the same id", () => {
      const s1 = SecureExecSession.getOrCreate("thread-1");
      const s2 = SecureExecSession.getOrCreate("thread-1");
      expect(s1).toBe(s2);
    });

    it("creates a new session for a new id", () => {
      const s1 = SecureExecSession.getOrCreate("thread-a");
      const s2 = SecureExecSession.getOrCreate("thread-b");
      expect(s1).not.toBe(s2);
      expect(s1.id).toBe("thread-a");
      expect(s2.id).toBe("thread-b");
    });

    it("re-attaches backend on existing session when backend option provided", () => {
      const s1 = SecureExecSession.getOrCreate("thread-backend");
      const backend = createMockBackend();
      const s2 = SecureExecSession.getOrCreate("thread-backend", {
        backend: backend as never,
      });
      expect(s1).toBe(s2);
    });

    it("stores session in static cache", () => {
      const s = SecureExecSession.getOrCreate("thread-cache");
      expect(SecureExecSession.get("thread-cache")).toBe(s);
    });
  });

  describe("get()", () => {
    it("returns null for unknown id", () => {
      expect(SecureExecSession.get("does-not-exist")).toBeNull();
    });

    it("returns the session for a known id", () => {
      const s = SecureExecSession.getOrCreate("known");
      expect(SecureExecSession.get("known")).toBe(s);
    });
  });

  describe("eval()", () => {
    it("lazily starts the NodeRuntime on first call", async () => {
      const session = SecureExecSession.getOrCreate("lazy-start");
      expect(NodeRuntime).not.toHaveBeenCalled();
      await session.eval("42", TIMEOUT);
      expect(NodeRuntime).toHaveBeenCalledTimes(1);
    });

    it("does not create a second NodeRuntime on subsequent calls", async () => {
      const session = SecureExecSession.getOrCreate("no-double");
      await session.eval("1", TIMEOUT);
      await session.eval("2", TIMEOUT);
      expect(NodeRuntime).toHaveBeenCalledTimes(1);
    });

    it("constructs NodeRuntime with cpuTimeLimitMs from first eval call", async () => {
      const session = SecureExecSession.getOrCreate("cpu-limit");
      await session.eval("42", 5000);
      expect(NodeRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ cpuTimeLimitMs: 5000 }),
      );
    });

    it("constructs NodeRuntime with memoryLimit from session options", async () => {
      const session = SecureExecSession.getOrCreate("mem-limit", {
        memoryLimitMb: 128,
      });
      await session.eval("42", TIMEOUT);
      expect(NodeRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ memoryLimit: 128 }),
      );
    });

    it("captures stdout logs via onStdio", async () => {
      const session = SecureExecSession.getOrCreate("stdout-logs");

      (NodeRuntime as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        makeRuntimeMockWithStdio(async (onStdio) => {
          onStdio({ channel: "stdout", message: "hello" });
          return { code: 0, exports: {} };
        }),
      );

      const result = await session.eval('console.log("hello")', TIMEOUT);
      expect(result.logs).toContain("hello");
    });

    it("captures stderr logs prefixed with [stderr]", async () => {
      const session = SecureExecSession.getOrCreate("stderr-logs");

      (NodeRuntime as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        makeRuntimeMockWithStdio(async (onStdio) => {
          onStdio({ channel: "stderr", message: "oops" });
          return { code: 0, exports: {} };
        }),
      );

      const result = await session.eval("throw new Error()", TIMEOUT);
      expect(result.logs).toContain("[stderr] oops");
    });

    it("returns ok:false and errorMessage when exit code is non-zero", async () => {
      (NodeRuntime as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        makeRuntimeMock(async () => ({
          code: 1,
          errorMessage: "ReferenceError: x is not defined",
        })),
      );

      const session = SecureExecSession.getOrCreate("error-exit");
      const result = await session.eval("x", TIMEOUT);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe("ReferenceError: x is not defined");
    });

    it("returns Execution failed when errorMessage is missing", async () => {
      (NodeRuntime as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        makeRuntimeMock(async () => ({ code: 1 })),
      );

      const session = SecureExecSession.getOrCreate("error-no-msg");
      const result = await session.eval("bad", TIMEOUT);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe("Execution failed");
    });

    it("returns ok:true with __result export on success", async () => {
      (NodeRuntime as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        makeRuntimeMock(async () => ({ code: 0, exports: { __result: 42 } })),
      );

      const session = SecureExecSession.getOrCreate("result-export");
      const result = await session.eval("42", TIMEOUT);
      expect(result.ok).toBe(true);
      expect(result.value).toBe(42);
    });

    it("accumulates declaration snippets across multiple evals", async () => {
      (transformForEval as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          fullSource: "const x = 42;",
          result: {
            compiledCode: "const x = 42;",
            declarationSnippets: ["const x = 42;"],
            wasTypeScript: false,
            typeErrors: [],
          },
        })
        .mockResolvedValueOnce({
          fullSource: "const y = x + 1;",
          result: {
            compiledCode: "const y = x + 1;",
            declarationSnippets: ["const y = x + 1;"],
            wasTypeScript: false,
            typeErrors: [],
          },
        });

      const session = SecureExecSession.getOrCreate("snippets");
      await session.eval("const x = 42;", TIMEOUT);
      await session.eval("const y = x + 1;", TIMEOUT);

      // Second eval should see the accumulated snippets from the first
      const secondCallArgs = (
        transformForEval as ReturnType<typeof vi.fn>
      ).mock.calls[1];
      const previousSnippets = secondCallArgs[2] as string[];
      expect(previousSnippets).toContain("const x = 42;");
    });

    it("does NOT accumulate expression statements", async () => {
      (transformForEval as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        fullSource: "console.log(1)",
        result: {
          compiledCode: "console.log(1)",
          declarationSnippets: [],
          wasTypeScript: false,
          typeErrors: [],
        },
      });

      const session = SecureExecSession.getOrCreate("no-expr-snippets");
      await session.eval("console.log(1)", TIMEOUT);
      await session.eval("2 + 2", TIMEOUT);

      const secondCallArgs = (
        transformForEval as ReturnType<typeof vi.fn>
      ).mock.calls[1];
      const previousSnippets = secondCallArgs[2] as string[];
      expect(previousSnippets).toHaveLength(0);
    });

    it("re-runs previous snippets as preamble on subsequent evals", async () => {
      (transformForEval as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          fullSource: "const x = 1;",
          result: {
            compiledCode: "const x = 1;",
            declarationSnippets: ["const x = 1;"],
            wasTypeScript: false,
            typeErrors: [],
          },
        })
        .mockResolvedValueOnce({
          fullSource: "const x = 1;\nconst y = 2;",
          result: {
            compiledCode: "const y = 2;",
            declarationSnippets: ["const y = 2;"],
            wasTypeScript: false,
            typeErrors: [],
          },
        });

      const session = SecureExecSession.getOrCreate("preamble");
      await session.eval("const x = 1;", TIMEOUT);
      await session.eval("const y = 2;", TIMEOUT);

      // The second call to transformForEval should receive previous snippets
      const secondCallArgs = (
        transformForEval as ReturnType<typeof vi.fn>
      ).mock.calls[1];
      const previousSnippets = secondCallArgs[2] as string[];
      expect(previousSnippets).toEqual(["const x = 1;"]);
    });

    it("passes ptcBridgeUrl and tool names to transformForEval when tools configured", async () => {
      const echoTool = tool(async (input: { msg: string }) => input.msg, {
        name: "echo_msg",
        description: "Echo",
        schema: z.object({ msg: z.string() }),
      });

      const session = SecureExecSession.getOrCreate("ptc-tools", {
        tools: [echoTool],
      });
      await session.eval("tools.echoMsg({ msg: 'hi' })", TIMEOUT);

      const callArgs = (transformForEval as ReturnType<typeof vi.fn>).mock
        .calls[0];
      const ptcBridgeUrl = callArgs[3] as string | undefined;
      const ptcToolNames = callArgs[4] as string[];
      expect(ptcBridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(ptcToolNames).toContain("echoMsg");
      session.dispose();
    });

    it("returns empty logs when no output", async () => {
      const session = SecureExecSession.getOrCreate("no-logs");
      const result = await session.eval("42", TIMEOUT);
      expect(result.logs).toEqual([]);
    });

    it("clears logs between consecutive evals", async () => {
      let callCount = 0;
      (NodeRuntime as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        function (
          this: MockRuntimeInstance,
          opts: { onStdio?: (e: { channel: string; message: string }) => void },
        ) {
          const onStdio = opts.onStdio;
          this.run = vi.fn().mockImplementation(async () => {
            callCount++;
            // Only emit "first-log" on the first run call
            if (callCount === 1 && onStdio) {
              onStdio({ channel: "stdout", message: "first-log" });
            }
            return { code: 0, exports: {} };
          });
          this.dispose = vi.fn();
        },
      );

      const session = SecureExecSession.getOrCreate("clear-logs");
      const r1 = await session.eval("first", TIMEOUT);
      expect(r1.logs).toContain("first-log");

      const r2 = await session.eval("second", TIMEOUT);
      expect(r2.logs).not.toContain("first-log");
    });
  });

  describe("flushWrites()", () => {
    it("writes all pending writes to the backend and clears the queue", async () => {
      const backend = createMockBackend();
      const session = SecureExecSession.getOrCreate("flush-writes", {
        backend: backend as never,
      });

      await session.eval('writeFile("/out.txt", "hello")', TIMEOUT);

      // Manually add pending writes to simulate VFS write
      session["vfs"].pendingWrites.push({ path: "/out.txt", content: "hello" });
      expect(session["vfs"].pendingWrites).toHaveLength(1);

      await session.flushWrites(backend as never);
      expect(backend.write).toHaveBeenCalledWith("/out.txt", "hello");
      expect(session["vfs"].pendingWrites).toHaveLength(0);
    });

    it("is a no-op when pendingWrites is empty", async () => {
      const backend = createMockBackend();
      const session = SecureExecSession.getOrCreate("flush-empty");
      await session.flushWrites(backend as never);
      expect(backend.write).not.toHaveBeenCalled();
    });
  });

  describe("dispose()", () => {
    it("calls NodeRuntime.dispose()", async () => {
      const session = SecureExecSession.getOrCreate("dispose-test");
      await session.eval("42", TIMEOUT);

      const instance = (NodeRuntime as unknown as ReturnType<typeof vi.fn>).mock
        .instances[0] as MockRuntimeInstance;
      session.dispose();
      expect(instance.dispose).toHaveBeenCalled();
    });

    it("removes the session from the static cache", async () => {
      const session = SecureExecSession.getOrCreate("dispose-cache");
      await session.eval("1", TIMEOUT);
      session.dispose();
      expect(SecureExecSession.get("dispose-cache")).toBeNull();
    });

    it("does not throw when runtime is null", () => {
      const session = SecureExecSession.getOrCreate("dispose-null");
      // Never started
      expect(() => session.dispose()).not.toThrow();
    });
  });

  describe("serialization", () => {
    it("toJSON returns { id }", () => {
      const session = SecureExecSession.getOrCreate("serial-1");
      expect(session.toJSON()).toEqual({ id: "serial-1" });
    });

    it("fromJSON returns existing session if cached", () => {
      const session = SecureExecSession.getOrCreate("serial-2");
      const restored = SecureExecSession.fromJSON({ id: "serial-2" });
      expect(restored).toBe(session);
    });

    it("fromJSON returns new empty session if not cached", () => {
      const session = SecureExecSession.fromJSON({ id: "not-cached-999" });
      expect(session).toBeInstanceOf(SecureExecSession);
      expect(session.id).toBe("not-cached-999");
    });

    it("survives round-trip through JSON.stringify/parse", () => {
      const session = SecureExecSession.getOrCreate("round-trip");
      const serialized = JSON.stringify(session);
      const restored = SecureExecSession.fromJSON(
        JSON.parse(serialized) as { id: string },
      );
      expect(restored).toBe(session);
    });
  });

  describe("clearCache()", () => {
    it("disposes all sessions and empties the map", async () => {
      const s1 = SecureExecSession.getOrCreate("clear-1");
      const s2 = SecureExecSession.getOrCreate("clear-2");
      await s1.eval("1", TIMEOUT);
      await s2.eval("2", TIMEOUT);

      SecureExecSession.clearCache();
      expect(SecureExecSession.get("clear-1")).toBeNull();
      expect(SecureExecSession.get("clear-2")).toBeNull();
    });

    it("does not throw when cache is already empty", () => {
      expect(() => SecureExecSession.clearCache()).not.toThrow();
    });
  });

  describe("NodeRuntime construction", () => {
    it("creates NodeRuntime with systemDriver and runtimeDriverFactory", async () => {
      const session = SecureExecSession.getOrCreate("construction");
      await session.eval("42", TIMEOUT);
      expect(NodeRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          systemDriver: expect.any(Object),
          runtimeDriverFactory: expect.any(Object),
        }),
      );
    });

    it("calls createNodeDriver and createNodeRuntimeDriverFactory", async () => {
      const session = SecureExecSession.getOrCreate("drivers");
      await session.eval("42", TIMEOUT);
      expect(createNodeDriver).toHaveBeenCalled();
      expect(createNodeRuntimeDriverFactory).toHaveBeenCalled();
    });

    it("passes onStdio handler to NodeRuntime constructor", async () => {
      const session = SecureExecSession.getOrCreate("onstdio-ctor");
      await session.eval("42", TIMEOUT);
      expect(NodeRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ onStdio: expect.any(Function) }),
      );
    });
  });
});
