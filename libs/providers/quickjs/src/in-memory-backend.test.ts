import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { InMemoryBackend } from "./in-memory-backend.js";

describe("InMemoryBackend", () => {
  let tmpDir: string;
  let skillDir: string;
  const SKILL_NAME = "test-skill";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "in-memory-backend-"));
    skillDir = path.join(tmpDir, SKILL_NAME);
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, "index.ts"),
      "export const x = 1;\nexport const y = 2;\n",
    );
    fs.writeFileSync(
      path.join(skillDir, "utils.ts"),
      "export function add(a: number, b: number) { return a + b; }\n",
    );
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: test\ndescription: A test skill\n---\n# Test\n",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("creates backend from a Map", () => {
      const files = new Map([
        ["/foo/bar.ts", "export const bar = 1;"],
        ["/foo/baz.ts", "export const baz = 2;"],
      ]);
      const backend = new InMemoryBackend(files);
      const result = backend.read("/foo/bar.ts");
      expect(result.content).toBe("export const bar = 1;");
    });
  });

  describe("fromDirectory", () => {
    it("loads files under /<subdirName>/ prefix", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.ls(`/${SKILL_NAME}`);
      const paths = result.files!.map((f) => f.path).sort();
      expect(paths).toEqual([
        `/${SKILL_NAME}/SKILL.md`,
        `/${SKILL_NAME}/index.ts`,
        `/${SKILL_NAME}/utils.ts`,
      ]);
    });

    it("loads multiple subdirectories", () => {
      const otherDir = path.join(tmpDir, "other-skill");
      fs.mkdirSync(otherDir);
      fs.writeFileSync(path.join(otherDir, "index.ts"), "export default 2;");

      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.ls("/");
      const dirs = result
        .files!.filter((f) => f.is_dir)
        .map((f) => f.path)
        .sort();
      expect(dirs).toEqual(["/other-skill/", `/${SKILL_NAME}/`]);
    });

    it("loads all file types without filtering", () => {
      fs.writeFileSync(path.join(skillDir, "data.json"), "{}");
      fs.writeFileSync(path.join(skillDir, "notes.txt"), "hello");
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.ls(`/${SKILL_NAME}`);
      const paths = result.files!.map((f) => f.path).sort();
      expect(paths).toEqual([
        `/${SKILL_NAME}/SKILL.md`,
        `/${SKILL_NAME}/data.json`,
        `/${SKILL_NAME}/index.ts`,
        `/${SKILL_NAME}/notes.txt`,
        `/${SKILL_NAME}/utils.ts`,
      ]);
    });

    it("loads files at the root level", () => {
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Skills");
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.read("/README.md");
      expect(result.content).toBe("# Skills");
    });

    it("recursively loads nested directories", () => {
      const nestedDir = path.join(skillDir, "sub");
      fs.mkdirSync(nestedDir);
      fs.writeFileSync(path.join(nestedDir, "deep.ts"), "export const d = 1;");
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.read(`/${SKILL_NAME}/sub/deep.ts`);
      expect(result.content).toBe("export const d = 1;");
    });

    it("skips symlinks pointing outside the root directory", () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
      const secretFile = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(secretFile, "sensitive data");

      try {
        fs.symlinkSync(secretFile, path.join(skillDir, "exfil.ts"));
        const backend = InMemoryBackend.fromDirectory(tmpDir);
        const result = backend.read(`/${SKILL_NAME}/exfil.ts`);
        expect(result.error).toBeDefined();
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("skips symlinked directories", () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
      fs.writeFileSync(path.join(outsideDir, "secret.ts"), "sensitive");

      try {
        fs.symlinkSync(outsideDir, path.join(tmpDir, "linked-skill"));
        const backend = InMemoryBackend.fromDirectory(tmpDir);
        const result = backend.ls("/linked-skill");
        expect(result.files).toEqual([]);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe("ls", () => {
    it("lists subdirectories at root", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.ls("/");
      expect(result.error).toBeUndefined();
      const dirs = result.files!.filter((f) => f.is_dir);
      expect(dirs).toHaveLength(1);
      expect(dirs[0].path).toBe(`/${SKILL_NAME}/`);
    });

    it("lists files inside a subdirectory", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.ls(`/${SKILL_NAME}`);
      expect(result.error).toBeUndefined();
      expect(result.files).toHaveLength(3);
      for (const f of result.files!) {
        expect(f.is_dir).toBe(false);
        expect(f.path).toMatch(new RegExp(`^/${SKILL_NAME}/`));
      }
    });

    it("returns empty for non-existent subdirectory", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.ls("/nonexistent");
      expect(result.files).toEqual([]);
    });

    it("handles empty string as root", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.ls("");
      const dirs = result.files!.filter((f) => f.is_dir);
      expect(dirs).toHaveLength(1);
      expect(dirs[0].is_dir).toBe(true);
    });
  });

  describe("read", () => {
    it("reads file content by path", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.read(`/${SKILL_NAME}/index.ts`);
      expect(result.error).toBeUndefined();
      expect(result.content).toBe("export const x = 1;\nexport const y = 2;\n");
      expect(result.mimeType).toBe("text/plain");
    });

    it("reads file without leading slash", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.read(`${SKILL_NAME}/index.ts`);
      expect(result.error).toBeUndefined();
      expect(result.content).toBe("export const x = 1;\nexport const y = 2;\n");
    });

    it("returns error for missing file", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.read(`/${SKILL_NAME}/missing.ts`);
      expect(result.error).toBe(`File not found: /${SKILL_NAME}/missing.ts`);
      expect(result.content).toBeUndefined();
    });
  });

  describe("readRaw", () => {
    it("returns FileData with content", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.readRaw(`/${SKILL_NAME}/SKILL.md`);
      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data!.content).toContain("name: test");
      expect(result.data!.mimeType).toBe("text/plain");
    });

    it("returns error for missing file", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.readRaw(`/${SKILL_NAME}/nope.ts`);
      expect(result.error).toBe(`File not found: /${SKILL_NAME}/nope.ts`);
    });
  });

  describe("grep", () => {
    it("finds matches across files", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.grep("export");
      expect(result.matches).toBeDefined();
      expect(result.matches!.length).toBeGreaterThanOrEqual(3);
    });

    it("filters by search path", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.grep("export", `/${SKILL_NAME}/utils.ts`);
      expect(result.matches).toHaveLength(1);
      expect(result.matches![0].path).toBe(`/${SKILL_NAME}/utils.ts`);
    });

    it("returns empty for no matches", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.grep("nonexistent_string_xyz");
      expect(result.matches).toEqual([]);
    });
  });

  describe("glob", () => {
    it("matches by extension", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.glob("**/*.ts");
      expect(result.files).toBeDefined();
      const paths = result.files!.map((f) => f.path).sort();
      expect(paths).toEqual([
        `/${SKILL_NAME}/index.ts`,
        `/${SKILL_NAME}/utils.ts`,
      ]);
    });

    it("matches markdown", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.glob("**/*.md");
      expect(result.files).toHaveLength(1);
      expect(result.files![0].path).toBe(`/${SKILL_NAME}/SKILL.md`);
    });

    it("returns empty for no matches", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.glob("**/*.py");
      expect(result.files).toEqual([]);
    });
  });

  describe("write operations", () => {
    it("write returns error", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.write(`/${SKILL_NAME}/new.ts`, "content");
      expect(result.error).toBe("InMemoryBackend is read-only");
    });

    it("edit returns error", () => {
      const backend = InMemoryBackend.fromDirectory(tmpDir);
      const result = backend.edit(`/${SKILL_NAME}/index.ts`, "old", "new");
      expect(result.error).toBe("InMemoryBackend is read-only");
    });
  });
});
