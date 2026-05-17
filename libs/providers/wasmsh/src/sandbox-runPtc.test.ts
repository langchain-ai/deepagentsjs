/**
 * `WasmshSandbox.runPtc` passthrough + capability duck-check.
 *
 * The sandbox class forwards runPtc to the underlying npm session. We
 * verify the call shape is preserved and that a session without runPtc
 * surfaces a clear error rather than a TypeError on undefined.
 */
import { describe, it, expect, vi } from "vitest";
import * as npmModule from "@mayflowergmbh/wasmsh-pyodide";
import { WasmshSandbox } from "./sandbox.js";

describe("WasmshSandbox.runPtc", () => {
  it("delegates to the session.runPtc when present", async () => {
    const sessionRunPtc = vi.fn().mockResolvedValue({
      ok: true,
      stdout: "out",
      stderr: "",
      value: "v",
    });
    const fakeSession = {
      runPtc: sessionRunPtc,
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(npmModule, "createNodeSession").mockResolvedValue(
      fakeSession as never,
    );

    const sandbox = await WasmshSandbox.createNode({});
    const onHostCall = vi.fn();
    const result = await sandbox.runPtc({
      code: "1 + 1",
      tools: ["search"],
      onHostCall,
    });

    expect(sessionRunPtc).toHaveBeenCalledOnce();
    expect(sessionRunPtc.mock.calls[0][0].code).toBe("1 + 1");
    expect(sessionRunPtc.mock.calls[0][0].tools).toEqual(["search"]);
    expect(sessionRunPtc.mock.calls[0][0].onHostCall).toBe(onHostCall);
    expect(result.ok).toBe(true);
    expect(result.value).toBe("v");

    await sandbox.stop();
    vi.restoreAllMocks();
  });

  it("throws a clear error against an older session that lacks runPtc", async () => {
    const fakeSession = {
      // Deliberately no runPtc — simulates @mayflowergmbh/wasmsh-pyodide < 0.6.4.
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(npmModule, "createNodeSession").mockResolvedValue(
      fakeSession as never,
    );

    const sandbox = await WasmshSandbox.createNode({});
    await expect(
      sandbox.runPtc({
        code: "pass",
        tools: [],
        onHostCall: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/does not expose runPtc/);

    await sandbox.stop();
    vi.restoreAllMocks();
  });

  it("throws when called before initialize", async () => {
    // Construct a sandbox with a factory that captures the instance before
    // initialize completes — we test the post-stop case which leaves
    // #session null.
    const fakeSession = {
      runPtc: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(npmModule, "createNodeSession").mockResolvedValue(
      fakeSession as never,
    );
    const sandbox = await WasmshSandbox.createNode({});
    await sandbox.stop();
    await expect(
      sandbox.runPtc({
        code: "pass",
        tools: [],
        onHostCall: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/is not initialized/);
    vi.restoreAllMocks();
  });
});
