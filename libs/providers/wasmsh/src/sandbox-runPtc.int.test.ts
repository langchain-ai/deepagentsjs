/**
 * Adapter-layer integration test for `WasmshSandbox.runPtc` against real
 * Pyodide.
 *
 * The unit test (`sandbox-runPtc.test.ts`) stubs the underlying npm session
 * and only checks the passthrough wiring. This file boots an actual
 * Pyodide-backed session and exercises the full round-trip:
 *
 *   - Plain code with no host calls (single-shot eval, stdout + value)
 *   - Code that emits a `host_call`, host satisfies it via `onHostCall`,
 *     Python sees the resolved value
 *   - Persistent state across two `runPtc` calls on the same sandbox
 *
 * Gated on built Pyodide assets so CI can opt-in by building them first.
 */
import { existsSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { resolveAssetPath } from "@mayflowergmbh/wasmsh-pyodide";

import { WasmshSandbox } from "./sandbox.js";

const assetsAvailable = existsSync(resolveAssetPath("pyodide.asm.wasm"));

describe.skipIf(!assetsAvailable)("WasmshSandbox.runPtc (real Pyodide)", () => {
  let sandbox: WasmshSandbox | undefined;

  afterEach(async () => {
    if (sandbox) {
      await sandbox.stop();
      sandbox = undefined;
    }
  });

  it(
    "evaluates plain Python with no host calls and returns the trailing value",
    { timeout: 60_000 },
    async () => {
      sandbox = await WasmshSandbox.createNode({});
      const envelope = await sandbox.runPtc({
        code: "print('hello'); 2 * 21",
        tools: [],
        onHostCall: async () => {
          throw new Error("onHostCall should not fire when tools is empty");
        },
      });
      expect(envelope.ok).toBe(true);
      expect(envelope.stdout).toContain("hello");
      // Pyodide returns the trailing expression natively when it's not None.
      expect(envelope.value).toBe(42);
    },
  );

  it(
    "round-trips a host_call: Python awaits a host tool, sees the resolved value",
    { timeout: 60_000 },
    async () => {
      sandbox = await WasmshSandbox.createNode({});
      const hostCalls: Array<{
        id: string;
        tool: string;
        args: Record<string, unknown>;
      }> = [];
      const envelope = await sandbox.runPtc({
        code: "x = await tools.echo(value='ping'); x",
        tools: ["echo"],
        onHostCall: async (call) => {
          hostCalls.push(call);
          // Echo back a synthetic value the in-sandbox Python can inspect.
          return { ok: true, value: `pong:${call.args.value as string}` };
        },
      });
      expect(envelope.ok).toBe(true);
      expect(hostCalls).toHaveLength(1);
      expect(hostCalls[0].tool).toBe("echo");
      expect(hostCalls[0].args).toEqual({ value: "ping" });
      expect(envelope.value).toBe("pong:ping");
    },
  );

  it(
    "surfaces a host_call error envelope to Python as an exception",
    { timeout: 60_000 },
    async () => {
      sandbox = await WasmshSandbox.createNode({});
      // Python tries to use the result; the runtime should raise an error
      // inside the user code (model sees it as a normal Python traceback).
      const code = `
try:
    await tools.boom()
    result = 'no_error'
except Exception as e:
    result = f"caught:{type(e).__name__}:{e}"
result
`;
      const envelope = await sandbox.runPtc({
        code,
        tools: ["boom"],
        onHostCall: async () => ({
          ok: false,
          error: "BoomError",
          message: "blew up",
        }),
      });
      expect(envelope.ok).toBe(true);
      expect(typeof envelope.value).toBe("string");
      expect(String(envelope.value)).toContain("caught:");
      expect(String(envelope.value)).toContain("blew up");
    },
  );

  it(
    "persists globals across successive runPtc calls on the same sandbox",
    { timeout: 60_000 },
    async () => {
      sandbox = await WasmshSandbox.createNode({});
      const first = await sandbox.runPtc({
        code: "counter = 41\ncounter",
        tools: [],
        onHostCall: async () => ({ ok: false }),
      });
      expect(first.ok).toBe(true);
      expect(first.value).toBe(41);

      const second = await sandbox.runPtc({
        code: "counter += 1\ncounter",
        tools: [],
        onHostCall: async () => ({ ok: false }),
      });
      expect(second.ok).toBe(true);
      expect(second.value).toBe(42);
    },
  );

  it(
    "propagates a Python exception into the envelope's error fields",
    { timeout: 60_000 },
    async () => {
      sandbox = await WasmshSandbox.createNode({});
      const envelope = await sandbox.runPtc({
        code: "undefined_name",
        tools: [],
        onHostCall: async () => ({ ok: false }),
      });
      expect(envelope.ok).toBe(false);
      expect(envelope.error).toMatch(/NameError/);
      expect(envelope.message).toMatch(/undefined_name/);
    },
  );
});
