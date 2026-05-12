import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SkillModuleBackend } from "./skill-module-backend.js";

describe("SkillModuleBackend", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-module-backend-"));
    fs.writeFileSync(
      path.join(tmpDir, "index.ts"),
      "export const x = 1;\nexport const y = 2;\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, "utils.ts"),
      "export function add(a: number, b: number) { return a + b; }\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, "SKILL.md"),
      "---\nname: test\ndescription: A test skill\n---\n# Test\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("loads .ts and .md files from the directory", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.ls("/");
      const paths = result.files!.map((f) => f.path).sort();
      expect(paths).toEqual(["/SKILL.md", "/index.ts", "/utils.ts"]);
    });

    it("excludes test files", () => {
      fs.writeFileSync(path.join(tmpDir, "index.test.ts"), "test");
      fs.writeFileSync(path.join(tmpDir, "utils.spec.ts"), "spec");
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.ls("/");
      const paths = result.files!.map((f) => f.path).sort();
      expect(paths).toEqual(["/SKILL.md", "/index.ts", "/utils.ts"]);
    });

    it("excludes non-skill file extensions", () => {
      fs.writeFileSync(path.join(tmpDir, "data.json"), "{}");
      fs.writeFileSync(path.join(tmpDir, "notes.txt"), "hello");
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.ls("/");
      const paths = result.files!.map((f) => f.path).sort();
      expect(paths).toEqual(["/SKILL.md", "/index.ts", "/utils.ts"]);
    });
  });

  describe("ls", () => {
    it("lists files at root", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.ls("/");
      expect(result.error).toBeUndefined();
      expect(result.files).toHaveLength(3);
      for (const f of result.files!) {
        expect(f.is_dir).toBe(false);
      }
    });

    it("returns empty for non-existent subdirectory", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.ls("/nonexistent");
      expect(result.files).toEqual([]);
    });

    it("handles empty string as root", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.ls("");
      expect(result.files).toHaveLength(3);
    });
  });

  describe("read", () => {
    it("reads file content by path", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.read("/index.ts");
      expect(result.error).toBeUndefined();
      expect(result.content).toBe("export const x = 1;\nexport const y = 2;\n");
      expect(result.mimeType).toBe("text/plain");
    });

    it("reads file without leading slash", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.read("index.ts");
      expect(result.error).toBeUndefined();
      expect(result.content).toBe("export const x = 1;\nexport const y = 2;\n");
    });

    it("returns error for missing file", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.read("/missing.ts");
      expect(result.error).toBe("File not found: /missing.ts");
      expect(result.content).toBeUndefined();
    });
  });

  describe("readRaw", () => {
    it("returns FileData with content", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.readRaw("/SKILL.md");
      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data!.content).toContain("name: test");
      expect(result.data!.mimeType).toBe("text/plain");
    });

    it("returns error for missing file", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.readRaw("/nope.ts");
      expect(result.error).toBe("File not found: /nope.ts");
    });
  });

  describe("grep", () => {
    it("finds matches across files", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.grep("export");
      expect(result.matches).toBeDefined();
      expect(result.matches!.length).toBeGreaterThanOrEqual(3);
    });

    it("filters by search path", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.grep("export", "/utils.ts");
      expect(result.matches).toHaveLength(1);
      expect(result.matches![0].path).toBe("/utils.ts");
    });

    it("returns empty for no matches", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.grep("nonexistent_string_xyz");
      expect(result.matches).toEqual([]);
    });
  });

  describe("glob", () => {
    it("matches by extension", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.glob("*.ts");
      expect(result.files).toBeDefined();
      const paths = result.files!.map((f) => f.path).sort();
      expect(paths).toEqual(["/index.ts", "/utils.ts"]);
    });

    it("matches markdown", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.glob("*.md");
      expect(result.files).toHaveLength(1);
      expect(result.files![0].path).toBe("/SKILL.md");
    });

    it("returns empty for no matches", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.glob("*.py");
      expect(result.files).toEqual([]);
    });
  });

  describe("write operations", () => {
    it("write returns error", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.write("/new.ts", "content");
      expect(result.error).toBe("Skill module backend is read-only");
    });

    it("edit returns error", () => {
      const backend = new SkillModuleBackend(tmpDir);
      const result = backend.edit("/index.ts", "old", "new");
      expect(result.error).toBe("Skill module backend is read-only");
    });
  });
});
