import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { collectSkillFiles, addSkill } from "./add-skill.js";

vi.mock("../utils.js", () => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  fatal: vi.fn((msg: string) => {
    throw new Error(msg);
  }),
  confirm: vi.fn(),
}));

import { fatal, confirm, success, info, warn } from "../utils.js";

describe("collectSkillFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepagents-skill-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return non-test files sorted alphabetically", async () => {
    fs.writeFileSync(path.join(tempDir, "index.ts"), "");
    fs.writeFileSync(path.join(tempDir, "utils.ts"), "");
    fs.writeFileSync(path.join(tempDir, "SKILL.md"), "");
    fs.writeFileSync(path.join(tempDir, "batching.ts"), "");

    const files = await collectSkillFiles(tempDir);
    expect(files).toEqual(["SKILL.md", "batching.ts", "index.ts", "utils.ts"]);
  });

  it("should exclude .test.ts files", async () => {
    fs.writeFileSync(path.join(tempDir, "index.ts"), "");
    fs.writeFileSync(path.join(tempDir, "index.test.ts"), "");
    fs.writeFileSync(path.join(tempDir, "utils.test.ts"), "");

    const files = await collectSkillFiles(tempDir);
    expect(files).toEqual(["index.ts"]);
  });

  it("should exclude .test.js files", async () => {
    fs.writeFileSync(path.join(tempDir, "index.js"), "");
    fs.writeFileSync(path.join(tempDir, "index.test.js"), "");

    const files = await collectSkillFiles(tempDir);
    expect(files).toEqual(["index.js"]);
  });

  it("should exclude .spec.ts and .spec.js files", async () => {
    fs.writeFileSync(path.join(tempDir, "index.ts"), "");
    fs.writeFileSync(path.join(tempDir, "index.spec.ts"), "");
    fs.writeFileSync(path.join(tempDir, "index.spec.js"), "");

    const files = await collectSkillFiles(tempDir);
    expect(files).toEqual(["index.ts"]);
  });

  it("should return an empty array for an empty directory", async () => {
    const files = await collectSkillFiles(tempDir);
    expect(files).toEqual([]);
  });
});

describe("addSkill", () => {
  let sourceDir: string;
  let projectDir: string;
  let originalCwd: () => string;

  beforeEach(() => {
    vi.clearAllMocks();
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepagents-src-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepagents-proj-"));
    originalCwd = process.cwd;
    process.cwd = () => projectDir;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  /**
   * Seeds the source directory with fake skill files.
   */
  function seedSource(files: string[]): void {
    for (const file of files) {
      fs.writeFileSync(path.join(sourceDir, file), `// ${file}`);
    }
  }

  it("should copy skill files into skills/<name> under cwd", async () => {
    seedSource(["index.ts", "SKILL.md", "utils.ts"]);

    await addSkill("fake", { sourceDir });

    const destDir = path.join(projectDir, "skills", "fake");
    expect(fs.existsSync(path.join(destDir, "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "utils.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(destDir, "index.ts"), "utf-8")).toBe(
      "// index.ts",
    );

    expect(success).toHaveBeenCalledWith(
      'Added skill module "fake" to /skills/fake/',
    );
  });

  it("should exclude test files from the copy", async () => {
    seedSource(["index.ts", "index.test.ts", "utils.test.ts", "foo.spec.ts"]);

    await addSkill("fake", { sourceDir });

    const destDir = path.join(projectDir, "skills", "fake");
    expect(fs.existsSync(path.join(destDir, "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "index.test.ts"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "utils.test.ts"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "foo.spec.ts"))).toBe(false);
  });

  it("should call fatal for a nonexistent source directory", async () => {
    const badDir = path.join(sourceDir, "nonexistent");

    await expect(addSkill("nope", { sourceDir: badDir })).rejects.toThrow(
      'Unknown skill module "nope"',
    );
    expect(fatal).toHaveBeenCalledWith('Unknown skill module "nope"');
  });

  it("should call fatal when source directory has no files", async () => {
    await expect(addSkill("empty", { sourceDir })).rejects.toThrow(
      /No skill module files found/,
    );
    expect(fatal).toHaveBeenCalled();
  });

  it("should prompt before overwriting an existing directory", async () => {
    seedSource(["index.ts"]);
    const destDir = path.join(projectDir, "skills", "fake");
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "old.ts"), "old");

    vi.mocked(confirm).mockResolvedValue(false);

    await addSkill("fake", { force: false, sourceDir });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
    );
    expect(confirm).toHaveBeenCalledWith("Overwrite existing files?");
    expect(info).toHaveBeenCalledWith("Aborted");
    expect(fs.readdirSync(destDir)).toEqual(["old.ts"]);
  });

  it("should overwrite when user confirms", async () => {
    seedSource(["index.ts"]);
    const destDir = path.join(projectDir, "skills", "fake");
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "old.ts"), "old");

    vi.mocked(confirm).mockResolvedValue(true);

    await addSkill("fake", { force: false, sourceDir });

    expect(confirm).toHaveBeenCalled();
    expect(fs.existsSync(path.join(destDir, "index.ts"))).toBe(true);
    expect(success).toHaveBeenCalled();
  });

  it("should skip prompt with --force flag", async () => {
    seedSource(["index.ts"]);
    const destDir = path.join(projectDir, "skills", "fake");
    fs.mkdirSync(destDir, { recursive: true });

    await addSkill("fake", { force: true, sourceDir });

    expect(confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(destDir, "index.ts"))).toBe(true);
    expect(success).toHaveBeenCalled();
  });

  it("should list all copied files in output", async () => {
    seedSource(["index.ts", "SKILL.md", "types.ts"]);

    await addSkill("fake", { sourceDir });

    expect(info).toHaveBeenCalledWith("Files copied:");
    expect(info).toHaveBeenCalledWith("  skills/fake/SKILL.md");
    expect(info).toHaveBeenCalledWith("  skills/fake/index.ts");
    expect(info).toHaveBeenCalledWith("  skills/fake/types.ts");
  });
});
