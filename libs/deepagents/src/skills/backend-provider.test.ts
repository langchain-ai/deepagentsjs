import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { FilesystemBackend } from "../backends/filesystem.js";
import type { AnyBackendProtocol } from "../backends/protocol.js";

import { BackendSkillProvider } from "./backend-provider.js";
import { MAX_SKILL_BUNDLE_BYTES } from "./filesystem-provider.js";

/**
 * Tests for `BackendSkillProvider`. Covers the canonical end-to-end
 * behavior over a `FilesystemBackend`, then drops to in-memory stub
 * backends to exercise the two branches that only the protocol layer
 * can: backends that implement `downloadFiles` (the binary-safe path)
 * vs backends that only implement `read` (the text-only fallback).
 */

interface MakeSkillOpts {
  body?: string;
  scripts?: Record<string, string>;
  frontmatter?: Record<string, string>;
}

/**
 * Materialize a single skill on disk under `rootDir`. Used to build
 * realistic backends for the integration-style tests at the top of
 * the file.
 */
function makeSkillOnDisk(
  rootDir: string,
  name: string,
  opts: MakeSkillOpts = {},
): void {
  const skillDir = path.join(rootDir, name);
  fs.mkdirSync(skillDir, { recursive: true });

  const frontmatter = {
    name,
    description: `Description for ${name}`,
    ...opts.frontmatter,
  };
  const yamlBody = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const body = opts.body ?? `# ${name}\n\nUse this skill.`;
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\n${yamlBody}\n---\n\n${body}`,
  );

  if (opts.scripts) {
    const scriptsDir = path.join(skillDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const [rel, content] of Object.entries(opts.scripts)) {
      const full = path.join(scriptsDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
}

describe("BackendSkillProvider", () => {
  let tempDir: string;
  let backend: FilesystemBackend;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backend-skill-provider-"));
    backend = new FilesystemBackend({ rootDir: tempDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists skills via the wrapped backend", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    makeSkillOnDisk(skillsDir, "alpha");
    makeSkillOnDisk(skillsDir, "beta");

    const provider = new BackendSkillProvider({
      backend,
      sourcePath: path.join(tempDir, "skills"),
    });

    const skills = await provider.list();
    expect(skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("loads body + scripts via the wrapped backend", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    makeSkillOnDisk(skillsDir, "swarm", {
      body: "# Swarm body",
      scripts: {
        "index.ts": "export const x = 1;",
        "util.ts": "export const y = 2;",
      },
    });

    const provider = new BackendSkillProvider({
      backend,
      sourcePath: path.join(tempDir, "skills"),
    });
    const loaded = await provider.load("swarm");

    expect(loaded.metadata.name).toBe("swarm");
    expect(loaded.body.trim()).toBe("# Swarm body");
    expect([...loaded.files.keys()].sort()).toEqual([
      "scripts/index.ts",
      "scripts/util.ts",
    ]);
  });

  it("excludes test and spec files from the bundle", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    makeSkillOnDisk(skillsDir, "swarm", {
      scripts: {
        "index.ts": "export {};",
        "index.test.ts": "test",
        "thing.spec.ts": "spec",
      },
    });

    const provider = new BackendSkillProvider({
      backend,
      sourcePath: path.join(tempDir, "skills"),
    });
    const loaded = await provider.load("swarm");
    expect([...loaded.files.keys()]).toEqual(["scripts/index.ts"]);
  });

  it.each([
    ["traversal in name", "../etc"],
    ["slash in name", "a/b"],
    ["uppercase letter", "Foo"],
  ])("rejects unsafe skill name %s", async (_label, name) => {
    const provider = new BackendSkillProvider({
      backend,
      sourcePath: path.join(tempDir, "skills"),
    });
    await expect(provider.load(name)).rejects.toThrow(/invalid skill name/);
  });

  it("derives a stable id from the source path", () => {
    const provider = new BackendSkillProvider({
      backend,
      sourcePath: "/skills/user/",
    });
    expect(provider.id).toBe("backend:/skills/user/");
  });

  it("honors an explicit id override", () => {
    const provider = new BackendSkillProvider({
      backend,
      sourcePath: "/skills/user/",
      id: "custom",
    });
    expect(provider.id).toBe("custom");
  });

  it("throws when the SKILL.md frontmatter is malformed", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(path.join(skillsDir, "bad"), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "bad", "SKILL.md"), "no frontmatter");

    const provider = new BackendSkillProvider({
      backend,
      sourcePath: skillsDir,
    });
    await expect(provider.load("bad")).rejects.toThrow(
      /invalid or missing SKILL\.md/,
    );
  });

  it("enforces the per-skill bundle size cap", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    makeSkillOnDisk(skillsDir, "huge", {
      scripts: { "index.ts": "x".repeat(MAX_SKILL_BUNDLE_BYTES + 1) },
    });

    const provider = new BackendSkillProvider({
      backend,
      sourcePath: skillsDir,
    });
    await expect(provider.load("huge")).rejects.toThrow(/bundle exceeds/);
  });

  it("strips frontmatter from the returned body", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    makeSkillOnDisk(skillsDir, "trim", {
      body: "Just a body, no frontmatter.",
    });

    const provider = new BackendSkillProvider({
      backend,
      sourcePath: skillsDir,
    });
    const loaded = await provider.load("trim");
    expect(loaded.body).not.toMatch(/^---/);
    expect(loaded.body).toContain("Just a body");
  });

  it("normalizes source paths without a trailing slash", async () => {
    const skillsDir = path.join(tempDir, "skills");
    fs.mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: x\n---\n",
    );

    const provider = new BackendSkillProvider({
      backend,
      sourcePath: skillsDir, // no trailing slash
    });
    const loaded = await provider.load("alpha");
    expect(loaded.metadata.name).toBe("alpha");
  });

  describe("backend protocol variants", () => {
    /**
     * Stub backend whose only file primitive is `read`. Exercises the
     * fallback path inside `readBackendFile` for backends that do not
     * implement `downloadFiles`.
     */
    function readOnlyBackend(
      files: Record<string, string>,
    ): AnyBackendProtocol {
      return {
        async read(filePath: string) {
          const content = files[filePath];
          if (content === undefined) {
            return { error: "not_found", content: null };
          }
          return { error: null, content };
        },
        async ls(dir: string) {
          const prefix = dir.endsWith("/") ? dir : `${dir}/`;
          const children = new Set<string>();
          for (const p of Object.keys(files)) {
            if (!p.startsWith(prefix)) {
              continue;
            }
            const rest = p.slice(prefix.length).split("/")[0];
            children.add(rest);
          }
          return {
            files: [...children].map((name) => ({
              path: `${prefix}${name}`,
              is_dir: true,
            })),
          };
        },
        async glob() {
          return { files: [] };
        },
      } as unknown as AnyBackendProtocol;
    }

    it("reads SKILL.md through `read` when downloadFiles is absent", async () => {
      const stub = readOnlyBackend({
        "/skills/alpha/SKILL.md":
          "---\nname: alpha\ndescription: prose only\n---\n\nbody",
      });

      const provider = new BackendSkillProvider({
        backend: stub,
        sourcePath: "/skills/",
      });
      const loaded = await provider.load("alpha");
      expect(loaded.metadata.name).toBe("alpha");
      expect(loaded.body.trim()).toBe("body");
    });

    it("throws when downloadFiles is required but absent (skill has scripts)", async () => {
      const stub = {
        async read(filePath: string) {
          if (filePath === "/skills/alpha/SKILL.md") {
            return {
              error: null,
              content: "---\nname: alpha\ndescription: x\n---\n",
            };
          }
          return { error: "not_found", content: null };
        },
        async ls() {
          return { files: [{ path: "/skills/alpha/", is_dir: true }] };
        },
        async glob(pattern: string) {
          if (pattern.endsWith(".ts")) {
            return { files: [{ path: "/skills/alpha/scripts/index.ts" }] };
          }
          return { files: [] };
        },
        // No downloadFiles defined.
      } as unknown as AnyBackendProtocol;

      const provider = new BackendSkillProvider({
        backend: stub,
        sourcePath: "/skills/",
      });
      await expect(provider.load("alpha")).rejects.toThrow(
        /backend does not implement downloadFiles/,
      );
    });
  });
});
