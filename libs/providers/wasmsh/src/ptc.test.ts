/**
 * PTC dispatch coverage.
 *
 * Exercises the middleware's tool-filter logic + the host_call → tool.invoke
 * pipeline without booting Pyodide. Each test stubs the sandbox factory and
 * intercepts the dispatcher the middleware hands to `sandbox.runPtc`.
 */
import { describe, it, expect } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import {
  createWasmshInterpreterMiddleware,
  DEFAULT_PTC_EXCLUDED_TOOLS,
} from "./middleware.js";
import type { WasmshSandbox } from "./sandbox.js";

class CapturingSandbox {
  lastTools: string[] | null = null;
  lastOnHostCall:
    | ((call: {
        id: string;
        tool: string;
        args: Record<string, unknown>;
      }) => Promise<{
        ok: boolean;
        value?: unknown;
        error?: string;
        message?: string;
      }>)
    | null = null;

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
    this.lastTools = params.tools ?? [];
    this.lastOnHostCall = params.onHostCall;
    return {
      ok: true as const,
      stdout: "",
      stderr: "",
      value: null,
    };
  }
}

function makeTool(name: string, returnValue: unknown) {
  return tool(async () => returnValue, {
    name,
    description: `tool ${name}`,
    schema: z.object({ q: z.string().optional() }),
  });
}

async function exposeViaWrapModelCall(
  mw: ReturnType<typeof createWasmshInterpreterMiddleware>,
  agentTools: unknown[],
): Promise<void> {
  // Drive the wrapModelCall hook directly so the middleware refreshes its
  // per-turn PTC tool list. The handler is a no-op stub.
  await mw.wrapModelCall!(
    {
      tools: agentTools,
      systemMessage: {
        concat: () => ({ concat: () => "" }),
      },
    } as never,
    () => Promise.resolve({} as never),
  );
}

async function invokeEval(
  mw: ReturnType<typeof createWasmshInterpreterMiddleware>,
  code: string,
): Promise<string> {
  return (
    mw.tools![0] as unknown as {
      invoke: (input: { code: string }, config: unknown) => Promise<string>;
    }
  ).invoke({ code }, {});
}

describe("PTC tool filtering", () => {
  it("ptc: false exposes nothing", async () => {
    const sandbox = new CapturingSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
    });
    await exposeViaWrapModelCall(mw, [makeTool("search", "hit")]);
    await invokeEval(mw, "pass");
    expect(sandbox.lastTools).toEqual([]);
  });

  it("ptc: true exposes every agent tool except the default vfs helpers", async () => {
    const sandbox = new CapturingSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: true,
    });
    await exposeViaWrapModelCall(mw, [
      makeTool("search", "hit"),
      makeTool("read_file", "skip"),
      makeTool("ls", "skip"),
      makeTool("custom_tool", "ok"),
    ]);
    await invokeEval(mw, "pass");
    expect(sandbox.lastTools!.sort()).toEqual(["custom_tool", "search"]);
    // sanity: the defaults we're testing the exclusion against
    expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("read_file");
    expect(DEFAULT_PTC_EXCLUDED_TOOLS).toContain("ls");
  });

  it("ptc: string[] exposes only the listed tools", async () => {
    const sandbox = new CapturingSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: ["search"],
    });
    await exposeViaWrapModelCall(mw, [
      makeTool("search", "hit"),
      makeTool("other", "skip"),
    ]);
    await invokeEval(mw, "pass");
    expect(sandbox.lastTools).toEqual(["search"]);
  });

  it("ptc: { include } exposes only the named tools", async () => {
    const sandbox = new CapturingSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: { include: ["search"] },
    });
    await exposeViaWrapModelCall(mw, [
      makeTool("search", "hit"),
      makeTool("other", "skip"),
    ]);
    await invokeEval(mw, "pass");
    expect(sandbox.lastTools).toEqual(["search"]);
  });

  it("ptc: { exclude } unions with the default exclusions", async () => {
    const sandbox = new CapturingSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: { exclude: ["secret_tool"] },
    });
    await exposeViaWrapModelCall(mw, [
      makeTool("search", "hit"),
      makeTool("secret_tool", "no"),
      makeTool("execute", "no"),
      makeTool("custom_tool", "ok"),
    ]);
    await invokeEval(mw, "pass");
    expect(sandbox.lastTools!.sort()).toEqual(["custom_tool", "search"]);
  });

  it("excludes the middleware's own tool from the PTC list", async () => {
    const sandbox = new CapturingSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: true,
      toolName: "py_eval",
    });
    await exposeViaWrapModelCall(mw, [
      makeTool("search", "hit"),
      makeTool("py_eval", "self"),
    ]);
    await invokeEval(mw, "pass");
    expect(sandbox.lastTools).toEqual(["search"]);
  });

  it("rejects tools whose name can't become a Python identifier", async () => {
    const sandbox = new CapturingSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: true,
    });
    await expect(
      exposeViaWrapModelCall(mw, [makeTool("1bad-name", "x")]),
    ).rejects.toThrow(/cannot be exposed as Python identifier/);
  });
});

describe("PTC tool name mapping (kebab → snake)", () => {
  it("exposes a kebab-cased agent tool name in snake form", async () => {
    const sandbox = new CapturingSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: true,
    });
    await exposeViaWrapModelCall(mw, [makeTool("look-up", "ok")]);
    await invokeEval(mw, "pass");
    expect(sandbox.lastTools).toEqual(["look_up"]);
  });

  it("preserves already-snake names", async () => {
    const sandbox = new CapturingSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: true,
    });
    await exposeViaWrapModelCall(mw, [makeTool("snake_case", "ok")]);
    await invokeEval(mw, "pass");
    expect(sandbox.lastTools).toEqual(["snake_case"]);
  });
});

describe("PTC onHostCall dispatcher", () => {
  it("routes host_call.tool to the matching LangChain tool", async () => {
    const sandbox = new CapturingSandbox();
    const lookup = tool(async ({ q }: { q: string }) => `found:${q}`, {
      name: "lookup",
      description: "find by q",
      schema: z.object({ q: z.string() }),
    });
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: ["lookup"],
    });
    await exposeViaWrapModelCall(mw, [lookup]);
    await invokeEval(mw, "pass");
    expect(sandbox.lastOnHostCall).not.toBeNull();
    const env = await sandbox.lastOnHostCall!({
      id: "hc_1",
      tool: "lookup",
      args: { q: "alice" },
    });
    expect(env.ok).toBe(true);
    expect(env.value).toBe("found:alice");
  });

  it("returns an UnknownToolError envelope for tools not on the allowlist", async () => {
    const sandbox = new CapturingSandbox();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: ["lookup"],
    });
    await exposeViaWrapModelCall(mw, [makeTool("lookup", "ok")]);
    await invokeEval(mw, "pass");
    const env = await sandbox.lastOnHostCall!({
      id: "hc_x",
      tool: "ghost",
      args: {},
    });
    expect(env.ok).toBe(false);
    expect(env.error).toBe("UnknownToolError");
    expect(env.message).toContain("ghost");
  });

  it("isolates a thrown tool error into the envelope's error fields", async () => {
    const sandbox = new CapturingSandbox();
    const boom = tool(
      async () => {
        const err = new Error("kaboom");
        err.name = "BoomError";
        throw err;
      },
      {
        name: "boom",
        description: "always throws",
        schema: z.object({}),
      },
    );
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: ["boom"],
    });
    await exposeViaWrapModelCall(mw, [boom]);
    await invokeEval(mw, "pass");
    const env = await sandbox.lastOnHostCall!({
      id: "hc_b",
      tool: "boom",
      args: {},
    });
    expect(env.ok).toBe(false);
    expect(env.error).toBe("BoomError");
    expect(env.message).toBe("kaboom");
  });
});
