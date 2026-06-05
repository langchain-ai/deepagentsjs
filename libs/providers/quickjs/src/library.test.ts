import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { parseFrontmatter, loadLibrary } from "./library.js";

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  const FILE = "test/LIBRARY.md";

  describe("valid input", () => {
    it("parses name, description, and docs from valid frontmatter", () => {
      const content = [
        "---",
        "name: my-lib",
        "description: A test library",
        "---",
        "",
        "# Usage",
        "",
        "Import and go.",
      ].join("\n");

      const result = parseFrontmatter(content, FILE);

      expect(result.name).toBe("my-lib");
      expect(result.description).toBe("A test library");
      expect(result.docs).toBe("# Usage\n\nImport and go.");
      expect(result.ptcTools).toEqual([]);
    });

    it("parses ptcTools as a YAML array", () => {
      const content = [
        "---",
        "name: my-lib",
        "description: A test library",
        "ptcTools:",
        "  - read_file",
        "  - write_file",
        "---",
        "",
        "Docs here.",
      ].join("\n");

      const result = parseFrontmatter(content, FILE);

      expect(result.ptcTools).toEqual(["read_file", "write_file"]);
    });

    it("parses ptcTools from a space-separated string", () => {
      const content = [
        "---",
        "name: my-lib",
        "description: A test library",
        "ptcTools: read_file write_file",
        "---",
        "",
        "Docs.",
      ].join("\n");

      const result = parseFrontmatter(content, FILE);

      expect(result.ptcTools).toEqual(["read_file", "write_file"]);
    });

    it("returns empty ptcTools when not specified", () => {
      const content = [
        "---",
        "name: my-lib",
        "description: A test library",
        "---",
        "Docs.",
      ].join("\n");

      const result = parseFrontmatter(content, FILE);

      expect(result.ptcTools).toEqual([]);
    });

    it("returns empty docs when body is missing", () => {
      const content = ["---", "name: my-lib", "description: test", "---"].join(
        "\n",
      );

      const result = parseFrontmatter(content, FILE);

      expect(result.docs).toBe("");
    });

    it("accepts multi-segment kebab-case names", () => {
      const content = [
        "---",
        "name: my-cool-lib-v2",
        "description: test",
        "---",
      ].join("\n");

      const result = parseFrontmatter(content, FILE);

      expect(result.name).toBe("my-cool-lib-v2");
    });

    it("trims whitespace from name and description", () => {
      const content = [
        "---",
        "name: '  my-lib  '",
        "description: '  A test library  '",
        "---",
      ].join("\n");

      const result = parseFrontmatter(content, FILE);

      expect(result.name).toBe("my-lib");
      expect(result.description).toBe("A test library");
    });

    it("filters empty strings from ptcTools array", () => {
      const content = [
        "---",
        "name: my-lib",
        "description: test",
        "ptcTools:",
        "  - read_file",
        "  - ''",
        "  - write_file",
        "---",
      ].join("\n");

      const result = parseFrontmatter(content, FILE);

      expect(result.ptcTools).toEqual(["read_file", "write_file"]);
    });
  });

  describe("validation errors", () => {
    it("throws when no frontmatter delimiters are present", () => {
      expect(() => parseFrontmatter("just markdown", FILE)).toThrow(
        "no valid YAML frontmatter found",
      );
    });

    it("throws when frontmatter is not a YAML mapping", () => {
      const content = ["---", "- just a list", "---"].join("\n");

      expect(() => parseFrontmatter(content, FILE)).toThrow(
        "not a YAML mapping",
      );
    });

    it("throws when name is missing", () => {
      const content = ["---", "description: test", "---"].join("\n");

      expect(() => parseFrontmatter(content, FILE)).toThrow(
        "missing required 'name' field",
      );
    });

    it("throws when name is empty after trimming", () => {
      const content = ["---", "name: '  '", "description: test", "---"].join(
        "\n",
      );

      expect(() => parseFrontmatter(content, FILE)).toThrow(
        "missing required 'name' field",
      );
    });

    it("throws when name contains uppercase letters", () => {
      const content = ["---", "name: MyLib", "description: test", "---"].join(
        "\n",
      );

      expect(() => parseFrontmatter(content, FILE)).toThrow(
        "must be lowercase kebab-case",
      );
    });

    it("throws when name contains underscores", () => {
      const content = ["---", "name: my_lib", "description: test", "---"].join(
        "\n",
      );

      expect(() => parseFrontmatter(content, FILE)).toThrow(
        "must be lowercase kebab-case",
      );
    });

    it("throws when name starts with a hyphen", () => {
      const content = ["---", "name: -mylib", "description: test", "---"].join(
        "\n",
      );

      expect(() => parseFrontmatter(content, FILE)).toThrow(
        "must be lowercase kebab-case",
      );
    });

    it("throws when description is missing", () => {
      const content = ["---", "name: my-lib", "---"].join("\n");

      expect(() => parseFrontmatter(content, FILE)).toThrow(
        "missing required 'description' field",
      );
    });

    it("throws when description is empty after trimming", () => {
      const content = ["---", "name: my-lib", "description: '   '", "---"].join(
        "\n",
      );

      expect(() => parseFrontmatter(content, FILE)).toThrow(
        "missing required 'description' field",
      );
    });

    it("includes the file path in error messages", () => {
      const customPath = "/libs/my-lib/LIBRARY.md";

      expect(() => parseFrontmatter("no frontmatter", customPath)).toThrow(
        customPath,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// loadLibrary
// ---------------------------------------------------------------------------

describe("loadLibrary", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lib-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Write a LIBRARY.md and optional source files into the temp directory.
   */
  async function writeLibrary(opts: {
    frontmatter: string;
    body?: string;
    entryFilename?: string;
    entrySource?: string;
  }) {
    const md =
      `---\n${opts.frontmatter}\n---\n` + (opts.body ? `\n${opts.body}` : "");
    await fs.writeFile(path.join(tmpDir, "LIBRARY.md"), md, "utf-8");

    if (opts.entrySource !== undefined) {
      const filename = opts.entryFilename ?? "index.ts";
      await fs.writeFile(
        path.join(tmpDir, filename),
        opts.entrySource,
        "utf-8",
      );
    }
  }

  describe("happy path", () => {
    it("loads a library with all fields", async () => {
      await writeLibrary({
        frontmatter: [
          "name: my-lib",
          "description: A test library",
          "ptcTools:",
          "  - read_file",
          "  - write_file",
        ].join("\n"),
        body: "# My Lib\n\nUsage instructions.",
        entrySource: "export const x = 1;",
      });

      const lib = await loadLibrary(tmpDir);

      expect(lib.name).toBe("my-lib");
      expect(lib.description).toBe("A test library");
      expect(lib.ptcTools).toEqual(["read_file", "write_file"]);
      expect(lib.source).toContain("export const x = 1");
      expect(lib.docs).toBe("# My Lib\n\nUsage instructions.");
    });

    it("strips TypeScript syntax from the entrypoint", async () => {
      await writeLibrary({
        frontmatter: "name: my-lib\ndescription: test",
        entrySource:
          "export function greet(name: string): string { return name; }",
      });

      const lib = await loadLibrary(tmpDir);

      expect(lib.source).toContain("function greet");
      expect(lib.source).not.toContain(": string");
    });

    it("resolves index.js when index.ts is absent", async () => {
      await writeLibrary({
        frontmatter: "name: my-lib\ndescription: test",
        entryFilename: "index.js",
        entrySource: 'export const x = "js";',
      });

      const lib = await loadLibrary(tmpDir);

      expect(lib.source).toContain('export const x = "js"');
    });

    it("resolves index.mjs when index.js and index.ts are absent", async () => {
      await writeLibrary({
        frontmatter: "name: my-lib\ndescription: test",
        entryFilename: "index.mjs",
        entrySource: 'export const x = "mjs";',
      });

      const lib = await loadLibrary(tmpDir);

      expect(lib.source).toContain('export const x = "mjs"');
    });

    it("prefers index.js over index.ts (priority order)", async () => {
      await writeLibrary({
        frontmatter: "name: my-lib\ndescription: test",
        entryFilename: "index.js",
        entrySource: 'export const from = "js";',
      });
      await fs.writeFile(
        path.join(tmpDir, "index.ts"),
        'export const from = "ts";',
        "utf-8",
      );

      const lib = await loadLibrary(tmpDir);

      expect(lib.source).toContain('"js"');
    });

    it("returns empty docs when LIBRARY.md body is empty", async () => {
      await writeLibrary({
        frontmatter: "name: my-lib\ndescription: test",
        entrySource: "export const x = 1;",
      });

      const lib = await loadLibrary(tmpDir);

      expect(lib.docs).toBe("");
    });

    it("returns empty ptcTools when not specified in frontmatter", async () => {
      await writeLibrary({
        frontmatter: "name: my-lib\ndescription: test",
        entrySource: "export const x = 1;",
      });

      const lib = await loadLibrary(tmpDir);

      expect(lib.ptcTools).toEqual([]);
    });
  });

  describe("error cases", () => {
    it("throws when LIBRARY.md is missing", async () => {
      await expect(loadLibrary(tmpDir)).rejects.toThrow("missing LIBRARY.md");
    });

    it("throws when no entrypoint is found", async () => {
      await writeLibrary({
        frontmatter: "name: my-lib\ndescription: test",
      });

      await expect(loadLibrary(tmpDir)).rejects.toThrow("no entrypoint found");
    });

    it("throws when entrypoint exceeds size limit", async () => {
      const bigSource = "x".repeat(1 * 1024 * 1024 + 1);
      await writeLibrary({
        frontmatter: "name: my-lib\ndescription: test",
        entrySource: bigSource,
      });

      await expect(loadLibrary(tmpDir)).rejects.toThrow("source exceeds");
    });

    it("propagates frontmatter validation errors", async () => {
      await writeLibrary({
        frontmatter: "name: InvalidName\ndescription: test",
        entrySource: "export const x = 1;",
      });

      await expect(loadLibrary(tmpDir)).rejects.toThrow(
        "must be lowercase kebab-case",
      );
    });

    it("throws when directory does not exist", async () => {
      await expect(
        loadLibrary(path.join(tmpDir, "nonexistent")),
      ).rejects.toThrow("missing LIBRARY.md");
    });
  });
});
