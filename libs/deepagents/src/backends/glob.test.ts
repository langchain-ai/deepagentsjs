import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { glob } from "./glob.js";

/**
 * Helper to write a file with automatic parent directory creation
 */
async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Create symlinks, returning false when the platform does not allow it
 * (e.g. Windows without developer mode).
 */
async function trySymlinks(links: Array<[target: string, link: string]>) {
  try {
    for (const [target, link] of links) await fs.symlink(target, link);
    return true;
  } catch {
    return false;
  }
}

describe("glob", () => {
  let tmpDir: string;
  let root: string;
  let symlinksSupported: boolean;

  beforeAll(async () => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "deepagents-glob-"));
    root = path.join(tmpDir, "root");
    await writeFile(path.join(root, "real.ts"), "real");
    await writeFile(path.join(root, "README.md"), "readme");
    await writeFile(path.join(root, ".env"), "env");
    await writeFile(path.join(root, "src/a.ts"), "a");
    await writeFile(path.join(root, "src/lib/b.ts"), "b");
    await writeFile(path.join(root, "src/lib/deep/c.ts"), "c");
    await writeFile(path.join(tmpDir, "outside/secret.txt"), "secret");
    symlinksSupported = await trySymlinks([
      ["real.ts", path.join(root, "alias.ts")],
      ["../outside", path.join(root, "outdir")],
      [".", path.join(root, "src/loop")],
    ]);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("matches files relative to cwd with forward slashes", async () => {
    const files = await glob("**/*.ts", { cwd: root });
    expect(files.sort()).toEqual(
      ["real.ts", "src/a.ts", "src/lib/b.ts", "src/lib/deep/c.ts"].sort(),
    );
  });

  it("honours dot", async () => {
    expect(await glob("*", { cwd: root })).not.toContain(".env");
    expect(await glob("*", { cwd: root, dot: true })).toContain(".env");
  });

  it("supports brace patterns", async () => {
    const files = await glob("*.{ts,md}", { cwd: root });
    expect(files.sort()).toEqual(["README.md", "real.ts"]);
  });

  it("returns absolute paths when requested", async () => {
    const files = await glob("src/*.ts", { cwd: root, absolute: true });
    expect(files).toEqual([
      path.posix.join(root.split(path.sep).join("/"), "src/a.ts"),
    ]);
  });

  it("keeps a leading ./ on relative results", async () => {
    expect(await glob("./src/*.ts", { cwd: root })).toEqual(["./src/a.ts"]);
  });

  it("includes directories without a trailing slash when onlyFiles is false", async () => {
    const entries = await glob("src/**", { cwd: root, onlyFiles: false });
    expect(entries).toContain("src/lib");
    expect(entries).toContain("src/lib/deep");
    // The static base of a dynamic pattern is not itself a match.
    expect(entries).not.toContain("src");
    expect(entries.every((e) => !e.endsWith("/"))).toBe(true);
  });

  it("returns an empty list when nothing matches", async () => {
    expect(await glob("missing/**", { cwd: root })).toEqual([]);
  });

  describe("symlinks", () => {
    it("drops symlink entries when onlyFiles is true", async (ctx) => {
      if (!symlinksSupported) ctx.skip();
      const files = await glob("**/*", { cwd: root, dot: true });
      expect(files).not.toContain("alias.ts");
      expect(files).not.toContain("outdir");
      expect(files.some((f) => f.includes("secret"))).toBe(false);
    });

    it("reports symlink entries without descending into them when onlyFiles is false", async (ctx) => {
      if (!symlinksSupported) ctx.skip();
      const entries = await glob("**/*", { cwd: root, onlyFiles: false });
      expect(entries).toContain("alias.ts");
      expect(entries).toContain("outdir");
      expect(entries).toContain("src/loop");
      expect(entries.some((e) => e.includes("secret"))).toBe(false);
      expect(entries.some((e) => e.startsWith("src/loop/"))).toBe(false);
    });

    it("does not traverse a symlink named as a literal pattern segment", async (ctx) => {
      if (!symlinksSupported) ctx.skip();
      expect(await glob("outdir/*", { cwd: root, onlyFiles: false })).toEqual(
        [],
      );
      expect(await glob("src/loop/*", { cwd: root })).toEqual([]);
    });
  });
});
