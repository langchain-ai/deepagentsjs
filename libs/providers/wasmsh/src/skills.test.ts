/**
 * Unit tests for the Python skills loader.
 *
 * `scanSkillReferences` is covered in middleware.test.ts (basic shape);
 * here we cover the full bundle path: `loadSkill` against a fake backend
 * and `installPendingSkills` against a stub backend + recording sandbox.
 */
import { describe, it, expect } from "vitest";
import {
  loadSkill,
  installPendingSkills,
  type SkillMetadata,
} from "./skills.js";
import type { WasmshSandbox } from "./sandbox.js";
import type {
  BackendProtocolV2,
  MaybePromise,
  FileDownloadResponse,
} from "deepagents";

type SkillBackend = Pick<BackendProtocolV2, "glob"> & {
  downloadFiles(paths: string[]): MaybePromise<FileDownloadResponse[]>;
};

function makeBackend(files: Record<string, string>): SkillBackend {
  const paths = Object.keys(files).sort();
  return {
    async glob(pattern: string, path?: string) {
      // The loader's enumerator passes `**/*<ext>`; match by extension suffix.
      const ext = pattern.replace(/^\*\*\/\*/, "");
      const base = path ?? "/";
      const matches = paths.filter(
        (p) =>
          p.startsWith(base.endsWith("/") ? base : `${base}/`) &&
          p.endsWith(ext),
      );
      return { files: matches.map((p) => ({ path: p })) };
    },
    async downloadFiles(requested: string[]) {
      return requested.map((p) => {
        const content = files[p];
        if (content == null) {
          return { path: p, content: null, error: "file_not_found" };
        }
        return {
          path: p,
          content: new TextEncoder().encode(content),
          error: null,
        };
      });
    },
  };
}

const ORDER_HELPERS_META: SkillMetadata = {
  name: "order-helpers",
  path: "/skills/order-helpers/SKILL.md",
  description: "score and validate orders",
  module: "helper.py",
};

describe("loadSkill", () => {
  it("bundles a single helper file under the package path", async () => {
    const backend = makeBackend({
      "/skills/order-helpers/helper.py": "def add(a, b):\n    return a + b\n",
    });
    const loaded = await loadSkill(ORDER_HELPERS_META, backend);
    expect(loaded.name).toBe("order-helpers");
    expect(loaded.packageName).toBe("order_helpers");
    // The author shipped no __init__.py → loader synthesises one re-exporting
    // the entrypoint (helper.py) so `import skills.order_helpers` works.
    expect([...loaded.files.keys()].sort()).toEqual([
      "/skills/order_helpers/__init__.py",
      "/skills/order_helpers/helper.py",
    ]);
    const init = new TextDecoder().decode(
      loaded.files.get("/skills/order_helpers/__init__.py")!,
    );
    expect(init).toContain("from .helper import *");
  });

  it("does not overwrite an author-shipped __init__.py", async () => {
    const backend = makeBackend({
      "/skills/order-helpers/__init__.py": "# author init\n",
      "/skills/order-helpers/helper.py": "x = 1\n",
    });
    const loaded = await loadSkill(ORDER_HELPERS_META, backend);
    const init = new TextDecoder().decode(
      loaded.files.get("/skills/order_helpers/__init__.py")!,
    );
    expect(init).toBe("# author init\n");
  });

  it("rewrites kebab-case skill names to snake-case package names", async () => {
    const backend = makeBackend({
      "/skills/order-helpers/helper.py": "x = 1\n",
    });
    const loaded = await loadSkill(ORDER_HELPERS_META, backend);
    expect(loaded.packageName).toBe("order_helpers");
    expect(
      [...loaded.files.keys()].every((p) =>
        p.startsWith("/skills/order_helpers/"),
      ),
    ).toBe(true);
  });

  it("rejects an invalid kebab-case skill name", async () => {
    const backend = makeBackend({});
    await expect(
      loadSkill({ ...ORDER_HELPERS_META, name: "Bad_Name" }, backend),
    ).rejects.toThrow(/not a valid kebab-case identifier/);
  });

  it("errors when the skill directory has no Python files", async () => {
    // Truly empty backend — no .py or data extensions matched. The loader's
    // enumerator returns zero paths and the early "no Python files" branch
    // fires before the module-not-matched check.
    const backend = makeBackend({});
    await expect(loadSkill(ORDER_HELPERS_META, backend)).rejects.toThrow(
      /no Python files/,
    );
  });

  it("errors when the declared module entrypoint isn't shipped", async () => {
    const backend = makeBackend({
      "/skills/order-helpers/other.py": "x = 1\n",
    });
    await expect(loadSkill(ORDER_HELPERS_META, backend)).rejects.toThrow(
      /module path .*helper\.py.* did not match/,
    );
  });

  it("propagates a backend download error", async () => {
    const backend: SkillBackend = {
      async glob() {
        return {
          files: [{ path: "/skills/order-helpers/helper.py" }],
        };
      },
      async downloadFiles() {
        return [
          {
            path: "/skills/order-helpers/helper.py",
            content: null,
            error: "file_not_found",
          },
        ];
      },
    };
    await expect(loadSkill(ORDER_HELPERS_META, backend)).rejects.toThrow(
      /failed to download/,
    );
  });

  it("bundles a skill without a declared module key", async () => {
    const backend = makeBackend({
      "/skills/order-helpers/__init__.py": "y = 2\n",
    });
    const loaded = await loadSkill(
      { ...ORDER_HELPERS_META, module: null },
      backend,
    );
    expect(loaded.files.get("/skills/order_helpers/__init__.py")).toBeDefined();
  });
});

describe("installPendingSkills", () => {
  function makeSandbox() {
    const uploads: Array<[string, Uint8Array]> = [];
    return {
      uploads,
      sandbox: {
        async uploadFiles(files: Array<[string, Uint8Array]>) {
          for (const f of files) uploads.push(f);
          return files.map(([p]) => ({ path: p, error: null }));
        },
      } as unknown as WasmshSandbox,
    };
  }

  it("stages exactly the skills the source references", async () => {
    const backend = makeBackend({
      "/skills/order-helpers/helper.py": "x = 1\n",
      "/skills/other-skill/main.py": "y = 2\n",
    });
    const metadata = new Map<string, SkillMetadata>([
      ["order-helpers", { ...ORDER_HELPERS_META }],
      [
        "other-skill",
        {
          name: "other-skill",
          path: "/skills/other-skill/SKILL.md",
          description: "",
          module: "main.py",
        },
      ],
    ]);
    const installed = new Set<string>();
    const { uploads, sandbox } = makeSandbox();
    await installPendingSkills({
      source: "import skills.order_helpers\n",
      metadata,
      backend,
      sandbox,
      installed,
    });
    expect(installed).toEqual(new Set(["order_helpers"]));
    // The other skill was not referenced — no upload for it.
    expect(uploads.some(([p]) => p.includes("other_skill"))).toBe(false);
    expect(uploads.some(([p]) => p === "/skills/order_helpers/helper.py")).toBe(
      true,
    );
  });

  it("skips already-installed skills on subsequent calls", async () => {
    const backend = makeBackend({
      "/skills/order-helpers/helper.py": "x = 1\n",
    });
    const metadata = new Map([["order-helpers", { ...ORDER_HELPERS_META }]]);
    const installed = new Set<string>();
    const { uploads, sandbox } = makeSandbox();
    await installPendingSkills({
      source: "import skills.order_helpers",
      metadata,
      backend,
      sandbox,
      installed,
    });
    const firstCount = uploads.length;
    await installPendingSkills({
      source: "from skills.order_helpers import helper",
      metadata,
      backend,
      sandbox,
      installed,
    });
    expect(uploads.length).toBe(firstCount);
  });

  it("isolates per-skill load failures — one bad skill doesn't stop the others", async () => {
    const backend: SkillBackend = {
      async glob(pattern: string, path?: string) {
        const ext = pattern.replace(/^\*\*\/\*/, "");
        const map: Record<string, string[]> = {
          "/skills/good": ["/skills/good/main.py"],
          "/skills/bad": ["/skills/bad/main.py"],
        };
        return {
          files: (map[path ?? ""] ?? [])
            .filter((p) => p.endsWith(ext))
            .map((p) => ({ path: p })),
        };
      },
      async downloadFiles(paths) {
        return paths.map((p) =>
          p.includes("/bad/")
            ? { path: p, content: null, error: "file_not_found" }
            : {
                path: p,
                content: new TextEncoder().encode("z = 3\n"),
                error: null,
              },
        );
      },
    };
    const metadata = new Map<string, SkillMetadata>([
      [
        "good",
        {
          name: "good",
          path: "/skills/good/SKILL.md",
          description: "",
          module: "main.py",
        },
      ],
      [
        "bad",
        {
          name: "bad",
          path: "/skills/bad/SKILL.md",
          description: "",
          module: "main.py",
        },
      ],
    ]);
    const installed = new Set<string>();
    const { sandbox } = makeSandbox();
    await installPendingSkills({
      source: "import skills.good\nimport skills.bad\n",
      metadata,
      backend,
      sandbox,
      installed,
    });
    expect(installed.has("good")).toBe(true);
    expect(installed.has("bad")).toBe(false);
  });

  it("is a no-op when the source references no skills", async () => {
    const backend = makeBackend({});
    const metadata = new Map<string, SkillMetadata>();
    const installed = new Set<string>();
    const { uploads, sandbox } = makeSandbox();
    await installPendingSkills({
      source: "print('hi')",
      metadata,
      backend,
      sandbox,
      installed,
    });
    expect(uploads).toHaveLength(0);
    expect(installed.size).toBe(0);
  });
});
