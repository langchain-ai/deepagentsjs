import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  FilesystemSkillProvider,
  MAX_SKILL_BUNDLE_BYTES,
} from "./filesystem-provider.js";

/**
 * Tests for `FilesystemSkillProvider`. Coverage focuses on real
 * behaviors that matter at runtime: kebab-case name validation,
 * traversal rejection, symlink rejection where the platform supports
 * `O_NOFOLLOW`, the per-skill bundle-size cap, and the file-shape
 * filters (test files excluded, non-code extensions excluded,
 * frontmatter stripped).
 */

interface MakeSkillOpts {
  frontmatter?: Record<string, string>;
  body?: string;
  scripts?: Record<string, string>;
  extraFiles?: Record<string, string>;
}

/**
 * Helper that materializes a skill directory under `rootDir` with a
 * SKILL.md, optional `scripts/` files, and arbitrary extra files at the
 * skill root. Returns the absolute path of the created skill directory.
 */
function makeSkill(
  rootDir: string,
  name: string,
  opts: MakeSkillOpts = {},
): string {
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
  const body = opts.body ?? `# ${name}\n\nSome instructions.`;
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

  if (opts.extraFiles) {
    for (const [rel, content] of Object.entries(opts.extraFiles)) {
      const full = path.join(skillDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  return skillDir;
}

describe("FilesystemSkillProvider", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-skill-provider-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("list", () => {
    it("returns metadata for every child directory containing SKILL.md", async () => {
      makeSkill(tempDir, "alpha");
      makeSkill(tempDir, "beta");

      const provider = new FilesystemSkillProvider({ root: tempDir });
      const skills = await provider.list();

      expect(skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    });

    it("returns an empty list when the root does not exist", async () => {
      const provider = new FilesystemSkillProvider({
        root: path.join(tempDir, "does-not-exist"),
      });
      expect(await provider.list()).toEqual([]);
    });

    it("skips directories without a SKILL.md", async () => {
      makeSkill(tempDir, "alpha");
      fs.mkdirSync(path.join(tempDir, "not-a-skill"));

      const provider = new FilesystemSkillProvider({ root: tempDir });
      const skills = await provider.list();
      expect(skills.map((s) => s.name)).toEqual(["alpha"]);
    });

    it("skips directories with malformed SKILL.md without failing the listing", async () => {
      makeSkill(tempDir, "good");
      const badDir = path.join(tempDir, "bad");
      fs.mkdirSync(badDir);
      fs.writeFileSync(
        path.join(badDir, "SKILL.md"),
        "no frontmatter at all, just prose",
      );

      const provider = new FilesystemSkillProvider({ root: tempDir });
      const skills = await provider.list();
      expect(skills.map((s) => s.name)).toEqual(["good"]);
    });

    it("derives a stable id from the absolute root", () => {
      const provider = new FilesystemSkillProvider({ root: tempDir });
      expect(provider.id).toBe(`fs:${path.resolve(tempDir)}`);
    });

    it("honors an explicit id override", () => {
      const provider = new FilesystemSkillProvider({
        root: tempDir,
        id: "custom-id",
      });
      expect(provider.id).toBe("custom-id");
    });
  });

  describe("load", () => {
    it("returns metadata, body, and source files keyed by relative POSIX path", async () => {
      makeSkill(tempDir, "swarm", {
        body: "# Swarm body",
        scripts: {
          "index.ts": "export const x = 1;",
          "util.ts": "export const y = 2;",
        },
      });

      const provider = new FilesystemSkillProvider({ root: tempDir });
      const loaded = await provider.load("swarm");

      expect(loaded.metadata.name).toBe("swarm");
      expect(loaded.body.trim()).toBe("# Swarm body");
      expect([...loaded.files.keys()].sort()).toEqual([
        "scripts/index.ts",
        "scripts/util.ts",
      ]);
      expect(loaded.files.get("scripts/index.ts")).toBe("export const x = 1;");
    });

    it("returns an empty files map for prose-only skills", async () => {
      makeSkill(tempDir, "prose");
      const provider = new FilesystemSkillProvider({ root: tempDir });
      const loaded = await provider.load("prose");
      expect(loaded.files.size).toBe(0);
    });

    it("excludes .test and .spec files from the bundle", async () => {
      makeSkill(tempDir, "swarm", {
        scripts: {
          "index.ts": "export {};",
          "index.test.ts": "test stuff",
          "thing.spec.ts": "spec stuff",
        },
      });

      const provider = new FilesystemSkillProvider({ root: tempDir });
      const loaded = await provider.load("swarm");
      expect([...loaded.files.keys()]).toEqual(["scripts/index.ts"]);
    });

    it("excludes non-code extensions from the bundle", async () => {
      makeSkill(tempDir, "swarm", {
        scripts: {
          "index.ts": "export {};",
        },
        extraFiles: {
          "README.md": "readme",
          "scripts/notes.md": "notes",
          "scripts/config.json": "{}",
        },
      });

      const provider = new FilesystemSkillProvider({ root: tempDir });
      const loaded = await provider.load("swarm");
      expect([...loaded.files.keys()]).toEqual(["scripts/index.ts"]);
    });

    it.each([
      ["leading traversal", "../etc"],
      ["embedded slash", "a/b"],
      ["bare dotdot", ".."],
      ["uppercase letter", "Foo"],
      ["empty string", ""],
    ])("rejects unsafe skill name %s", async (_label, name) => {
      const provider = new FilesystemSkillProvider({ root: tempDir });
      await expect(provider.load(name)).rejects.toThrow(/invalid skill name/);
    });

    it("throws a useful error when the skill directory does not exist", async () => {
      const provider = new FilesystemSkillProvider({ root: tempDir });
      await expect(provider.load("missing")).rejects.toThrow(/cannot read/);
    });

    it("throws when the SKILL.md frontmatter is invalid", async () => {
      const dir = path.join(tempDir, "bad");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "SKILL.md"), "no frontmatter");

      const provider = new FilesystemSkillProvider({ root: tempDir });
      await expect(provider.load("bad")).rejects.toThrow(
        /invalid or missing SKILL\.md/,
      );
    });

    it("enforces the per-skill bundle size cap", async () => {
      const oversized = "x".repeat(MAX_SKILL_BUNDLE_BYTES + 1);
      makeSkill(tempDir, "huge", {
        scripts: { "index.ts": oversized },
      });

      const provider = new FilesystemSkillProvider({ root: tempDir });
      await expect(provider.load("huge")).rejects.toThrow(/bundle exceeds/);
    });

    it("strips the YAML frontmatter from the returned body", async () => {
      makeSkill(tempDir, "trim", { body: "Just a body, no frontmatter here." });
      const provider = new FilesystemSkillProvider({ root: tempDir });
      const loaded = await provider.load("trim");
      expect(loaded.body).not.toMatch(/^---/);
      expect(loaded.body).toContain("Just a body");
    });

    it("skips symlinked source files inside the skill dir", async () => {
      makeSkill(tempDir, "linky", {
        scripts: { "real.ts": "export const r = 1;" },
      });

      const target = path.join(tempDir, "linky", "scripts", "real.ts");
      const link = path.join(tempDir, "linky", "scripts", "linked.ts");
      try {
        fs.symlinkSync(target, link);
      } catch {
        // Platforms or environments without symlink permission skip
        // this test rather than fail.
        return;
      }

      const provider = new FilesystemSkillProvider({ root: tempDir });
      const loaded = await provider.load("linky");
      expect([...loaded.files.keys()]).toEqual(["scripts/real.ts"]);
    });

    it("walks nested directories under scripts/", async () => {
      makeSkill(tempDir, "nested", {
        scripts: {
          "index.ts": "export {};",
          "lib/util.ts": "export const u = 1;",
          "lib/inner/deep.ts": "export const d = 2;",
        },
      });

      const provider = new FilesystemSkillProvider({ root: tempDir });
      const loaded = await provider.load("nested");
      expect([...loaded.files.keys()].sort()).toEqual([
        "scripts/index.ts",
        "scripts/lib/inner/deep.ts",
        "scripts/lib/util.ts",
      ]);
    });
  });
});
