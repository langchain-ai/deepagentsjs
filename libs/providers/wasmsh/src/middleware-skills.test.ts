/**
 * Integration coverage for the middleware ↔ skills loader seam.
 *
 * Other test files cover each side in isolation (`skills.test.ts` against a
 * hand-rolled backend; `middleware.test.ts` against a stubbed sandbox).
 * This file wires them together: configure `createWasmshInterpreterMiddleware`
 * with a `skillsBackend`, mock `getCurrentTaskInput` to return state with
 * `skills_metadata`, invoke the eval tool with `import skills.<name>`
 * source, and assert that `installPendingSkills` actually fires uploads
 * onto the underlying sandbox.
 */
import { describe, it, expect, vi } from "vitest";
import type { BackendProtocolV2 } from "deepagents";

// Mock `getCurrentTaskInput` so the middleware sees a state carrying
// `skills_metadata`. The mock is hoisted by vitest before module evaluation.
vi.mock("@langchain/langgraph", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@langchain/langgraph",
  );
  return {
    ...actual,
    getCurrentTaskInput: vi.fn(() => ({
      skills_metadata: [
        {
          name: "order-helpers",
          path: "/skills/order-helpers/SKILL.md",
          description: "validate orders",
          module: "helper.py",
        },
      ],
    })),
  };
});

const { createWasmshInterpreterMiddleware } = await import("./middleware.js");

class RecordingSandbox {
  uploads: Array<[string, Uint8Array]> = [];
  runPtcCode: string | null = null;

  async uploadFiles(files: Array<[string, Uint8Array]>) {
    for (const f of files) this.uploads.push(f);
    return files.map(([p]) => ({ path: p, error: null }));
  }

  async runPtc(params: {
    code: string;
    tools?: string[];
    onHostCall: unknown;
  }) {
    this.runPtcCode = params.code;
    return {
      ok: true as const,
      stdout: "",
      stderr: "",
      value: null,
    };
  }
}

function makeBackend(files: Record<string, string>) {
  const sortedPaths = Object.keys(files).sort();
  return {
    async glob(pattern: string, path?: string) {
      const ext = pattern.replace(/^\*\*\/\*/, "");
      const base = path ?? "/";
      const match = (p: string) =>
        p.startsWith(base.endsWith("/") ? base : `${base}/`) && p.endsWith(ext);
      return { files: sortedPaths.filter(match).map((p) => ({ path: p })) };
    },
    async downloadFiles(paths: string[]) {
      return paths.map((p) => {
        const content = files[p];
        return content == null
          ? {
              path: p,
              content: null,
              error: "file_not_found" as const,
            }
          : {
              path: p,
              content: new TextEncoder().encode(content),
              error: null,
            };
      });
    },
  };
}

describe("WasmshInterpreterMiddleware ↔ skills loader integration", () => {
  it("stages a referenced skill into the sandbox VFS before the eval runs", async () => {
    const sandbox = new RecordingSandbox();
    const skillsBackend = makeBackend({
      "/skills/order-helpers/helper.py": "def add(a, b): return a + b\n",
    });
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () =>
        sandbox as unknown as Awaited<
          ReturnType<typeof import("./sandbox.js").WasmshSandbox.createNode>
        >,
      // Cast: the middleware only uses `glob` + `downloadFiles` on the
      // skills backend; the full `BackendProtocolV2` surface is overkill
      // for a skills-only stub.
      skillsBackend: skillsBackend as unknown as BackendProtocolV2,
    });

    // Drive the wrapModelCall hook first so any per-turn state (PTC list,
    // prompts) is set up before the tool fires. Source code references the
    // skill that the mocked state advertises.
    const code = "import skills.order_helpers\nresult = 1";
    await (
      mw.tools![0] as unknown as {
        invoke: (input: { code: string }, config: unknown) => Promise<string>;
      }
    ).invoke({ code }, {});

    // The skill was uploaded under its snake-cased package name before the
    // eval ran, so user code can `import skills.order_helpers` cleanly.
    const uploaded = sandbox.uploads.map(([p]) => p);
    expect(uploaded).toContain("/skills/order_helpers/helper.py");
    // An auto-synthesised __init__.py also lands so plain `import
    // skills.<pkg>` works even when the author ships only flat helpers.
    expect(uploaded).toContain("/skills/order_helpers/__init__.py");
    // The eval was actually invoked afterwards.
    expect(sandbox.runPtcCode).toBe(code);
  });

  it("does not stage skills the source doesn't reference", async () => {
    const sandbox = new RecordingSandbox();
    const skillsBackend = makeBackend({
      "/skills/order-helpers/helper.py": "x = 1\n",
    });
    const mw = createWasmshInterpreterMiddleware({
      sandboxFactory: async () =>
        sandbox as unknown as Awaited<
          ReturnType<typeof import("./sandbox.js").WasmshSandbox.createNode>
        >,
      // Cast: the middleware only uses `glob` + `downloadFiles` on the
      // skills backend; the full `BackendProtocolV2` surface is overkill
      // for a skills-only stub.
      skillsBackend: skillsBackend as unknown as BackendProtocolV2,
    });

    await (
      mw.tools![0] as unknown as {
        invoke: (input: { code: string }, config: unknown) => Promise<string>;
      }
    ).invoke({ code: "result = 1" }, {});

    // No `import skills.*` in the source → no uploads at all.
    expect(sandbox.uploads).toHaveLength(0);
  });
});
