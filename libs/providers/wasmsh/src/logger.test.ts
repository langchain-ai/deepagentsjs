/**
 * Coverage for the `WasmshLogger` hook surface.
 *
 * The middleware swallows two classes of error so they don't break the agent
 * loop: PTC tool errors (round-tripped into an envelope the model sees) and
 * best-effort skill load failures. The logger gives the host a structured
 * surface to observe both — assertions below pin the exact event shape so
 * downstream observability code can rely on it.
 */
import { describe, it, expect, vi } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import type { BackendProtocolV2 } from "deepagents";
import {
  createWasmshInterpreterMiddleware,
  installPendingSkills,
  type SkillMetadata,
  type WasmshLogger,
} from "./index.js";
import type { WasmshSandbox } from "./sandbox.js";

class CapturingSandbox {
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
    this.lastOnHostCall = params.onHostCall;
    void params.code;
    return { ok: true as const, stdout: "", stderr: "", value: null };
  }

  async uploadFiles(files: Array<[string, Uint8Array]>) {
    return files.map(([p]) => ({ path: p, error: null }));
  }
}

async function exposeViaWrapModelCall(
  mw: ReturnType<typeof createWasmshInterpreterMiddleware>,
  agentTools: unknown[],
): Promise<void> {
  await mw.wrapModelCall!(
    {
      tools: agentTools,
      systemMessage: { concat: () => ({ concat: () => "" }) },
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

describe("WasmshLogger.ptcToolError", () => {
  it("fires with tool, callId, args, and the original error when a PTC tool throws", async () => {
    const sandbox = new CapturingSandbox();
    const ptcError = Object.assign(new Error("upstream blew up"), {
      name: "UpstreamError",
    });
    const boom = tool(
      async () => {
        throw ptcError;
      },
      {
        name: "boom",
        description: "always throws",
        schema: z.object({}),
      },
    );
    const ptcToolError = vi.fn();
    const logger: WasmshLogger = { ptcToolError };
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: ["boom"],
      logger,
    });
    await exposeViaWrapModelCall(mw, [boom]);
    await invokeEval(mw, "pass");

    const env = await sandbox.lastOnHostCall!({
      id: "hc_42",
      tool: "boom",
      args: { x: 1 },
    });

    expect(ptcToolError).toHaveBeenCalledTimes(1);
    expect(ptcToolError).toHaveBeenCalledWith({
      tool: "boom",
      callId: "hc_42",
      args: { x: 1 },
      error: ptcError,
    });

    // The envelope still reaches the sandbox: logger is observability, not
    // a side-channel that replaces the in-band error surface.
    expect(env.ok).toBe(false);
    expect(env.error).toBe("UpstreamError");
    expect(env.message).toBe("upstream blew up");
  });

  it("does not fire when the PTC tool resolves normally", async () => {
    const sandbox = new CapturingSandbox();
    const ok = tool(async () => "result", {
      name: "ok",
      description: "no-op",
      schema: z.object({}),
    });
    const ptcToolError = vi.fn();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: ["ok"],
      logger: { ptcToolError },
    });
    await exposeViaWrapModelCall(mw, [ok]);
    await invokeEval(mw, "pass");
    await sandbox.lastOnHostCall!({ id: "hc_1", tool: "ok", args: {} });
    expect(ptcToolError).not.toHaveBeenCalled();
  });

  it("does not fire on UnknownToolError envelopes (no tool actually invoked)", async () => {
    const sandbox = new CapturingSandbox();
    const ptcToolError = vi.fn();
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: ["known"],
      logger: { ptcToolError },
    });
    await exposeViaWrapModelCall(mw, [
      tool(async () => "x", {
        name: "known",
        description: "",
        schema: z.object({}),
      }),
    ]);
    await invokeEval(mw, "pass");
    const env = await sandbox.lastOnHostCall!({
      id: "hc_g",
      tool: "ghost",
      args: {},
    });
    expect(env.error).toBe("UnknownToolError");
    // The logger surface is for *tool errors* — an allowlist miss is a
    // protocol-level rejection, not a tool failure.
    expect(ptcToolError).not.toHaveBeenCalled();
  });

  it("swallows a logger that itself throws so the envelope still round-trips", async () => {
    const sandbox = new CapturingSandbox();
    const boom = tool(
      async () => {
        throw new Error("boom");
      },
      { name: "boom", description: "", schema: z.object({}) },
    );
    const ptcToolError = vi.fn(() => {
      throw new Error("logger is broken");
    });
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () => sandbox as unknown as WasmshSandbox,
      ptc: ["boom"],
      logger: { ptcToolError },
    });
    await exposeViaWrapModelCall(mw, [boom]);
    await invokeEval(mw, "pass");
    const env = await sandbox.lastOnHostCall!({
      id: "hc_1",
      tool: "boom",
      args: {},
    });
    expect(ptcToolError).toHaveBeenCalledTimes(1);
    expect(env.ok).toBe(false);
    expect(env.message).toBe("boom");
  });
});

describe("WasmshLogger.skillLoadError", () => {
  function makeSkillsBackend(
    fail: Partial<Pick<BackendProtocolV2, "glob">> = {},
  ) {
    return {
      async glob() {
        return {
          files: [{ path: "/skills/order-helpers/helper.py" }],
        };
      },
      async downloadFiles() {
        // The default failure path: backend returns the file with an error
        // marker, which `loadSkill` surfaces as "failed to download …".
        return [
          {
            path: "/skills/order-helpers/helper.py",
            content: null,
            error: "file_not_found" as const,
          },
        ];
      },
      ...fail,
    };
  }

  const META: SkillMetadata = {
    name: "order-helpers",
    path: "/skills/order-helpers/SKILL.md",
    description: "",
    module: "helper.py",
  };

  it("fires with the skill name and original error on a load failure", async () => {
    const skillLoadError = vi.fn();
    const backend = makeSkillsBackend();
    const sandbox = new CapturingSandbox();
    await installPendingSkills({
      source: "import skills.order_helpers",
      metadata: new Map([["order-helpers", META]]),
      backend,
      sandbox: sandbox as unknown as WasmshSandbox,
      installed: new Set(),
      logger: { skillLoadError },
    });
    expect(skillLoadError).toHaveBeenCalledTimes(1);
    const event = skillLoadError.mock.calls[0][0];
    expect(event.skill).toBe("order-helpers");
    expect(event.error).toBeInstanceOf(Error);
    expect((event.error as Error).message).toMatch(/failed to download/);
  });

  it("does not fire when every referenced skill loads cleanly", async () => {
    const skillLoadError = vi.fn();
    const backend = {
      async glob() {
        return {
          files: [{ path: "/skills/order-helpers/helper.py" }],
        };
      },
      async downloadFiles(paths: string[]) {
        return paths.map((p) => ({
          path: p,
          content: new TextEncoder().encode("x = 1\n"),
          error: null,
        }));
      },
    };
    const sandbox = new CapturingSandbox();
    await installPendingSkills({
      source: "import skills.order_helpers",
      metadata: new Map([["order-helpers", META]]),
      backend,
      sandbox: sandbox as unknown as WasmshSandbox,
      installed: new Set(),
      logger: { skillLoadError },
    });
    expect(skillLoadError).not.toHaveBeenCalled();
  });

  it("falls back to stderr when no logger is configured", async () => {
    const backend = makeSkillsBackend();
    const sandbox = new CapturingSandbox();
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // Vitest's `vi.spyOn(process.stderr, "write")` returns a non-callable
    // mock on Node; reassign directly so the stderr-capture path still
    // calls a real function. Restore on the next line.
    process.stderr.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await installPendingSkills({
        source: "import skills.order_helpers",
        metadata: new Map([["order-helpers", META]]),
        backend,
        sandbox: sandbox as unknown as WasmshSandbox,
        installed: new Set(),
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(writes.join("")).toMatch(
      /\[wasmsh\] failed to load skill "order-helpers"/,
    );
  });

  it("does not write to stderr when a logger is configured (logger is authoritative)", async () => {
    const backend = makeSkillsBackend();
    const sandbox = new CapturingSandbox();
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await installPendingSkills({
        source: "import skills.order_helpers",
        metadata: new Map([["order-helpers", META]]),
        backend,
        sandbox: sandbox as unknown as WasmshSandbox,
        installed: new Set(),
        logger: { skillLoadError: () => {} },
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(writes.join("")).toBe("");
  });

  it("swallows a logger that itself throws and keeps loading the next skill", async () => {
    // Two skills: the first throws inside the logger, the second must still
    // be loaded successfully so a buggy logger can't take the agent down.
    const backend = {
      async glob(_pattern: string, path?: string) {
        return path?.includes("good")
          ? { files: [{ path: "/skills/good/main.py" }] }
          : { files: [{ path: "/skills/bad/helper.py" }] };
      },
      async downloadFiles(paths: string[]) {
        return paths.map((p) =>
          p.includes("bad")
            ? { path: p, content: null, error: "file_not_found" as const }
            : {
                path: p,
                content: new TextEncoder().encode("y = 2\n"),
                error: null,
              },
        );
      },
    };
    const skillLoadError = vi.fn(() => {
      throw new Error("logger is broken");
    });
    const sandbox = new CapturingSandbox();
    const installed = new Set<string>();
    await installPendingSkills({
      source: "import skills.bad\nimport skills.good\n",
      metadata: new Map<string, SkillMetadata>([
        [
          "bad",
          {
            name: "bad",
            path: "/skills/bad/SKILL.md",
            description: "",
            module: "helper.py",
          },
        ],
        [
          "good",
          {
            name: "good",
            path: "/skills/good/SKILL.md",
            description: "",
            module: "main.py",
          },
        ],
      ]),
      backend,
      sandbox: sandbox as unknown as WasmshSandbox,
      installed,
      logger: { skillLoadError },
    });
    expect(skillLoadError).toHaveBeenCalledTimes(1);
    expect(installed.has("good")).toBe(true);
  });
});
