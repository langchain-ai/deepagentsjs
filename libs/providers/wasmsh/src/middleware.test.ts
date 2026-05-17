/**
 * Unit tests for the wasmsh interpreter middleware.
 *
 * These don't boot Pyodide — they stub the sandbox factory with a recording
 * stand-in that satisfies just enough of the WasmshSandbox surface to drive
 * `runPtc`. End-to-end coverage against real Pyodide lives in the e2e
 * `ptc-round-trip.test.mjs` next to the npm package.
 */
import { describe, it, expect } from "vitest";
import {
  createWasmshInterpreterMiddleware,
  DEFAULT_PTC_EXCLUDED_TOOLS,
} from "./middleware.js";
import {
  scanSkillReferences,
  toSnakeCase,
  isValidPythonIdentifier,
  formatEnvelope,
} from "./index.js";

class StubSandbox {
  runPtcCalls: Array<{ code: string; tools: string[] }> = [];
  envelope: {
    ok: boolean;
    stdout: string;
    stderr: string;
    value?: unknown;
    error?: string;
    message?: string;
  } = { ok: true, stdout: "", stderr: "", value: null };

  // The dispatcher we expose for assertion in tests.
  capturedDispatcher: ((
    call: { id: string; tool: string; args: Record<string, unknown> },
  ) => Promise<{
    ok: boolean;
    value?: unknown;
    error?: string;
    message?: string;
  }>) | null = null;

  async runPtc(params: {
    code: string;
    tools?: string[];
    onHostCall: (call: {
      id: string;
      tool: string;
      args: Record<string, unknown>;
    }) => Promise<{
      ok: boolean;
      value?: unknown;
      error?: string;
      message?: string;
    }>;
  }) {
    this.runPtcCalls.push({ code: params.code, tools: params.tools ?? [] });
    this.capturedDispatcher = params.onHostCall;
    return this.envelope;
  }
}

describe("createWasmshInterpreterMiddleware", () => {
  it("registers a py_eval tool by default", () => {
    const stub = new StubSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () =>
        stub as unknown as Awaited<
          ReturnType<typeof import("./sandbox.js").WasmshSandbox.createNode>
        >,
    });
    expect(mw.tools!.map((t: { name: string }) => t.name)).toEqual(["py_eval"]);
  });

  it("supports a custom tool name", () => {
    const stub = new StubSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () =>
        stub as unknown as Awaited<
          ReturnType<typeof import("./sandbox.js").WasmshSandbox.createNode>
        >,
      toolName: "run_python",
    });
    expect(mw.tools![0].name).toBe("run_python");
  });

  it("invokes the eval tool against the underlying sandbox.runPtc", async () => {
    const stub = new StubSandbox();
    stub.envelope = { ok: true, stdout: "hi\n", stderr: "", value: 42 };
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () =>
        stub as unknown as Awaited<
          ReturnType<typeof import("./sandbox.js").WasmshSandbox.createNode>
        >,
    });
    const result = await (mw.tools![0] as unknown as {
      invoke: (input: { code: string }, config: unknown) => Promise<string>;
    }).invoke({ code: "2 * 21" }, {});
    expect(stub.runPtcCalls).toHaveLength(1);
    expect(stub.runPtcCalls[0].code).toBe("2 * 21");
    expect(stub.runPtcCalls[0].tools).toEqual([]);
    expect(result).toContain("42");
    expect(result).toContain("hi");
  });

  it("formats sandbox errors into the agent ToolMessage body", async () => {
    const stub = new StubSandbox();
    stub.envelope = {
      ok: false,
      stdout: "",
      stderr: "",
      error: "NameError",
      message: "name 'foo' is not defined",
    };
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () =>
        stub as unknown as Awaited<
          ReturnType<typeof import("./sandbox.js").WasmshSandbox.createNode>
        >,
    });
    const result = await (mw.tools![0] as unknown as {
      invoke: (input: { code: string }, config: unknown) => Promise<string>;
    }).invoke({ code: "foo" }, {});
    expect(result).toContain("NameError");
    expect(result).toContain("name 'foo' is not defined");
  });

  it("exposes the default PTC excluded tool list", () => {
    expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("execute");
    expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("read_file");
  });
});

describe("skills scanner", () => {
  it("detects import skills.<name>", () => {
    const refs = scanSkillReferences("import skills.foo\nimport skills.bar");
    expect([...refs].sort()).toEqual(["bar", "foo"]);
  });

  it("detects from skills.<name> import …", () => {
    const refs = scanSkillReferences(
      "from skills.alpha import helper\nfrom skills.beta import x, y",
    );
    expect([...refs].sort()).toEqual(["alpha", "beta"]);
  });

  it("ignores unrelated imports", () => {
    expect(scanSkillReferences("import os\nfrom json import loads").size).toBe(0);
  });
});

describe("utils", () => {
  it("toSnakeCase converts kebab to snake but leaves snake untouched", () => {
    expect(toSnakeCase("my-tool")).toBe("my_tool");
    expect(toSnakeCase("my_tool")).toBe("my_tool");
    expect(toSnakeCase("plain")).toBe("plain");
  });

  it("isValidPythonIdentifier accepts simple names", () => {
    expect(isValidPythonIdentifier("foo")).toBe(true);
    expect(isValidPythonIdentifier("foo_bar1")).toBe(true);
    expect(isValidPythonIdentifier("1foo")).toBe(false);
    expect(isValidPythonIdentifier("foo-bar")).toBe(false);
  });

  it("formatEnvelope renders stdout + value blocks", () => {
    const out = formatEnvelope(
      { ok: true, stdout: "hi\n", stderr: "", value: 42 },
      4000,
    );
    expect(out).toContain("<stdout>");
    expect(out).toContain("hi");
    expect(out).toContain("<value>");
    expect(out).toContain("42");
  });

  it("formatEnvelope shows <no output> when nothing to render", () => {
    const out = formatEnvelope({ ok: true, stdout: "", stderr: "" }, 4000);
    expect(out).toContain("<no output>");
  });

  it("formatEnvelope renders error blocks with traceback", () => {
    const out = formatEnvelope(
      {
        ok: false,
        stdout: "",
        stderr: "",
        error: "NameError",
        message: "name 'foo' is not defined",
        traceback: "Traceback (most recent call last):\n  ...",
      },
      4000,
    );
    expect(out).toContain("<error NameError>");
    expect(out).toContain("Traceback");
  });

  it("formatEnvelope truncates long bodies", () => {
    const huge = "x".repeat(10_000);
    const out = formatEnvelope({ ok: true, stdout: huge, stderr: "" }, 100);
    expect(out).toContain("…");
  });
});
