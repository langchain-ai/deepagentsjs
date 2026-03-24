import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { FilesystemBackend } from "./filesystem.js";

/**
 * Helper to write a file with automatic parent directory creation
 */
async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Helper to create a unique temporary directory for each test
 */
function createTempDir(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "deepagents-test-"));
}

/**
 * Helper to recursively remove a directory
 */
async function removeDir(dirPath: string) {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore errors during cleanup
  }
}

describe("FilesystemBackend", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(async () => {
    await removeDir(tmpDir);
  });

  it("should work in normal mode with absolute paths", async () => {
    const root = tmpDir;
    const f1 = path.join(root, "a.txt");
    const f2 = path.join(root, "dir", "b.py");
    await writeFile(f1, "hello fs");
    await writeFile(f2, "print('x')\nhello");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const lsResult = await backend.ls(root);
    expect(lsResult.error).toBeUndefined();
    const paths = new Set(lsResult.files!.map((i) => i.path));
    expect(paths.has(f1)).toBe(true);
    expect(paths.has(f2)).toBe(false);
    expect(paths.has(path.join(root, "dir") + path.sep)).toBe(true);

    const txt = await backend.read(f1);
    expect(txt.content).toContain("hello fs");

    const editMsg = await backend.edit(f1, "fs", "filesystem", false);
    expect(editMsg).toBeDefined();
    expect(editMsg.error).toBeUndefined();
    expect(editMsg.occurrences).toBe(1);

    const writeMsg = await backend.write(
      path.join(root, "new.txt"),
      "new content",
    );
    expect(writeMsg).toBeDefined();
    expect(writeMsg.error).toBeUndefined();
    expect(writeMsg.path).toContain("new.txt");

    const matches = await backend.grep("hello", root);
    expect(matches.matches).toBeDefined();
    expect(matches.matches!.some((m) => m.path.endsWith("a.txt"))).toBe(true);

    const globResults = await backend.glob("**/*.py", root);
    expect(globResults.error).toBeUndefined();
    expect(globResults.files!.some((i) => i.path === f2)).toBe(true);
  });

  it("should work in virtual mode with sandboxed paths", async () => {
    const root = tmpDir;
    const f1 = path.join(root, "a.txt");
    const f2 = path.join(root, "dir", "b.md");
    await writeFile(f1, "hello virtual");
    await writeFile(f2, "content");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: true,
    });

    const lsResult = await backend.ls("/");
    expect(lsResult.error).toBeUndefined();
    const paths = new Set(lsResult.files!.map((i) => i.path));
    expect(paths.has("/a.txt")).toBe(true);
    expect(paths.has("/dir/b.md")).toBe(false);
    expect(paths.has("/dir/")).toBe(true);

    const txt = await backend.read("/a.txt");
    expect(txt.content).toContain("hello virtual");

    const editMsg = await backend.edit("/a.txt", "virtual", "virt", false);
    expect(editMsg).toBeDefined();
    expect(editMsg.error).toBeUndefined();
    expect(editMsg.occurrences).toBe(1);

    const writeMsg = await backend.write("/new.txt", "x");
    expect(writeMsg).toBeDefined();
    expect(writeMsg.error).toBeUndefined();
    expect(fsSync.existsSync(path.join(root, "new.txt"))).toBe(true);

    const matches = await backend.grep("virt", "/");
    expect(matches.matches).toBeDefined();
    expect(matches.matches!.some((m) => m.path === "/a.txt")).toBe(true);

    const globResults = await backend.glob("**/*.md", "/");
    expect(globResults.error).toBeUndefined();
    expect(globResults.files!.some((i) => i.path === "/dir/b.md")).toBe(true);

    // Special characters like "[" are treated literally (not regex), returns empty list or matches
    const literalResult = await backend.grep("[", "/");
    expect(literalResult.matches).toBeDefined();

    const traversalError = await backend.read("/../a.txt");
    expect(traversalError.error).toBeDefined();
    expect(traversalError.error).toContain("Path traversal not allowed");
  });

  it("should list nested directories correctly in virtual mode", async () => {
    const root = tmpDir;

    const files: Record<string, string> = {
      [path.join(root, "config.json")]: "config",
      [path.join(root, "src", "main.py")]: "code",
      [path.join(root, "src", "utils", "helper.py")]: "utils code",
      [path.join(root, "src", "utils", "common.py")]: "common utils",
      [path.join(root, "docs", "readme.md")]: "documentation",
      [path.join(root, "docs", "api", "reference.md")]: "api docs",
    };

    for (const [filePath, content] of Object.entries(files)) {
      await writeFile(filePath, content);
    }

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: true,
    });

    const rootListing = await backend.ls("/");
    expect(rootListing.error).toBeUndefined();
    const rootPaths = rootListing.files!.map((fi) => fi.path);
    expect(rootPaths).toContain("/config.json");
    expect(rootPaths).toContain("/src/");
    expect(rootPaths).toContain("/docs/");
    expect(rootPaths).not.toContain("/src/main.py");
    expect(rootPaths).not.toContain("/src/utils/helper.py");

    const srcListing = await backend.ls("/src/");
    expect(srcListing.error).toBeUndefined();
    const srcPaths = srcListing.files!.map((fi) => fi.path);
    expect(srcPaths).toContain("/src/main.py");
    expect(srcPaths).toContain("/src/utils/");
    expect(srcPaths).not.toContain("/src/utils/helper.py");

    const utilsListing = await backend.ls("/src/utils/");
    expect(utilsListing.error).toBeUndefined();
    const utilsPaths = utilsListing.files!.map((fi) => fi.path);
    expect(utilsPaths).toContain("/src/utils/helper.py");
    expect(utilsPaths).toContain("/src/utils/common.py");
    expect(utilsPaths.length).toBe(2);

    const emptyListing = await backend.ls("/nonexistent/");
    expect(emptyListing.error).toBeUndefined();
    expect(emptyListing.files).toEqual([]);
  });

  it("should list nested directories correctly in normal mode", async () => {
    const root = tmpDir;

    const files: Record<string, string> = {
      [path.join(root, "file1.txt")]: "content1",
      [path.join(root, "subdir", "file2.txt")]: "content2",
      [path.join(root, "subdir", "nested", "file3.txt")]: "content3",
    };

    for (const [filePath, content] of Object.entries(files)) {
      await writeFile(filePath, content);
    }

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const rootListing = await backend.ls(root);
    expect(rootListing.error).toBeUndefined();
    const rootPaths = rootListing.files!.map((fi) => fi.path);
    expect(rootPaths).toContain(path.join(root, "file1.txt"));
    expect(rootPaths).toContain(path.join(root, "subdir") + path.sep);
    expect(rootPaths).not.toContain(path.join(root, "subdir", "file2.txt"));

    const subdirListing = await backend.ls(path.join(root, "subdir"));
    expect(subdirListing.error).toBeUndefined();
    const subdirPaths = subdirListing.files!.map((fi) => fi.path);
    expect(subdirPaths).toContain(path.join(root, "subdir", "file2.txt"));
    expect(subdirPaths).toContain(
      path.join(root, "subdir", "nested") + path.sep,
    );
    expect(subdirPaths).not.toContain(
      path.join(root, "subdir", "nested", "file3.txt"),
    );
  });

  it("should handle trailing slashes consistently", async () => {
    const root = tmpDir;

    const files: Record<string, string> = {
      [path.join(root, "file.txt")]: "content",
      [path.join(root, "dir", "nested.txt")]: "nested",
    };

    for (const [filePath, content] of Object.entries(files)) {
      await writeFile(filePath, content);
    }

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: true,
    });

    const listingWithSlash = await backend.ls("/");
    expect(listingWithSlash.error).toBeUndefined();
    expect(listingWithSlash.files!.length).toBeGreaterThan(0);

    const listing = await backend.ls("/");
    expect(listing.error).toBeUndefined();
    const paths = listing.files!.map((fi) => fi.path);
    expect(paths).toEqual([...paths].sort());

    const listing1 = await backend.ls("/dir/");
    expect(listing1.error).toBeUndefined();
    const listing2 = await backend.ls("/dir");
    expect(listing2.error).toBeUndefined();
    expect(listing1.files!.length).toBe(listing2.files!.length);
    expect(listing1.files!.map((fi) => fi.path)).toEqual(
      listing2.files!.map((fi) => fi.path),
    );

    const empty = await backend.ls("/nonexistent/");
    expect(empty.error).toBeUndefined();
    expect(empty.files).toEqual([]);
  });

  it("should handle large file writes correctly", async () => {
    const root = tmpDir;
    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: true,
    });

    const largeContent = "f".repeat(10000);
    const writeResult = await backend.write("/large_file.txt", largeContent);

    expect(writeResult.error).toBeUndefined();
    expect(writeResult.path).toBe("/large_file.txt");

    const readContent = await backend.read("/large_file.txt");
    expect(readContent.content).toContain(largeContent.substring(0, 100));

    const savedFile = path.join(root, "large_file.txt");
    expect(fsSync.existsSync(savedFile)).toBe(true);
  });

  it("should read multiline content", async () => {
    const root = tmpDir;
    const filePath = path.join(root, "multiline.txt");
    await writeFile(filePath, "line1\nline2\nline3");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const txt = await backend.read(filePath);
    expect(txt.content).toContain("line1");
    expect(txt.content).toContain("line2");
    expect(txt.content).toContain("line3");
  });

  it("should handle empty files", async () => {
    const root = tmpDir;
    const filePath = path.join(root, "empty.txt");
    await writeFile(filePath, "");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const txt = await backend.read(filePath);
    expect(txt.content).toContain("empty contents");
  });

  it("should return error when editing non-empty file with empty oldString", async () => {
    const root = tmpDir;
    const filePath = path.join(root, "test.txt");
    await writeFile(filePath, "hello world");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const result = await backend.edit(filePath, "", "replacement", false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("oldString cannot be empty");
    expect(result.occurrences).toBeUndefined();
  });

  it("should set initial content when editing empty file with empty oldString", async () => {
    const root = tmpDir;
    const filePath = path.join(root, "empty.txt");
    await writeFile(filePath, "");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const result = await backend.edit(filePath, "", "initial content", false);
    expect(result.error).toBeUndefined();
    expect(result.occurrences).toBe(0);
    expect(result.path).toBe(filePath);

    // Verify the file now has content
    const content = await backend.read(filePath);
    expect(content.content).toContain("initial content");
  });

  it("should handle files with trailing newlines", async () => {
    const root = tmpDir;
    const filePath = path.join(root, "trailing.txt");
    await writeFile(filePath, "line1\nline2\n");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const txt = await backend.read(filePath);
    expect(txt.content).toContain("line1");
    expect(txt.content).toContain("line2");
  });

  it("should handle unicode content", async () => {
    const root = tmpDir;
    const filePath = path.join(root, "unicode.txt");
    await writeFile(filePath, "Hello 世界\n🚀 emoji\nΩ omega");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const txt = await backend.read(filePath);
    expect(txt.content).toContain("Hello 世界");
    expect(txt.content).toContain("🚀 emoji");
    expect(txt.content).toContain("Ω omega");
  });

  it("should handle non-existent files consistently", async () => {
    const root = tmpDir;
    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const nonexistentPath = path.join(root, "nonexistent.txt");

    const readResult = await backend.read(nonexistentPath);
    expect(readResult.error).toBeDefined();
  });

  it("should handle symlinks securely", async () => {
    const root = tmpDir;
    const targetFile = path.join(root, "target.txt");
    const symlinkFile = path.join(root, "symlink.txt");

    await writeFile(targetFile, "target content");
    try {
      await fs.symlink(targetFile, symlinkFile);
    } catch {
      // Skip test if symlinks aren't supported (e.g., Windows without admin)
      return;
    }

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const readResult = await backend.read(symlinkFile);
    expect(readResult.error).toBeDefined();
  });

  describe("binary file handling", () => {
    it("should read binary files as Uint8Array", async () => {
      const root = tmpDir;
      // PNG header bytes
      const pngHeader = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const filePath = path.join(root, "image.png");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, pngHeader);

      const backend = new FilesystemBackend({
        rootDir: root,
        virtualMode: false,
      });

      const result = await backend.read(filePath);
      expect(result.error).toBeUndefined();
      expect(result.content).toBeInstanceOf(Uint8Array);
      expect(result.content).toEqual(new Uint8Array(pngHeader));
    });

    it("should write binary files by decoding base64", async () => {
      const root = tmpDir;
      const pngHeader = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const base64Content = pngHeader.toString("base64");

      const backend = new FilesystemBackend({
        rootDir: root,
        virtualMode: true,
      });

      const writeResult = await backend.write("/image.png", base64Content);
      expect(writeResult.error).toBeUndefined();

      // Verify raw bytes on disk match the original
      const rawBytes = await fs.readFile(path.join(root, "image.png"));
      expect(Buffer.compare(rawBytes, pngHeader)).toBe(0);
    });

    it("should roundtrip binary files through write and read", async () => {
      const root = tmpDir;
      const pngHeader = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const base64Content = Buffer.from(pngHeader).toString("base64");

      const backend = new FilesystemBackend({
        rootDir: root,
        virtualMode: true,
      });

      await backend.write("/image.png", base64Content);
      const result = await backend.read("/image.png");
      expect(result.content).toBeInstanceOf(Uint8Array);
      expect(result.content).toEqual(pngHeader);
    });

    it("should not paginate binary files", async () => {
      const root = tmpDir;
      // Create binary content larger than a few lines
      const binaryData = Buffer.alloc(2000, 0xab);
      const filePath = path.join(root, "data.pdf");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, binaryData);

      const backend = new FilesystemBackend({
        rootDir: root,
        virtualMode: false,
      });

      // Read with a small limit — should still return full Uint8Array content
      const result = await backend.read(filePath, 0, 1);
      expect(result.error).toBeUndefined();
      expect(result.content).toBeInstanceOf(Uint8Array);
      expect(result.content).toEqual(new Uint8Array(binaryData));
    });
  });

  describe("readRaw", () => {
    it("should return v2 format for text files", async () => {
      const root = tmpDir;
      const filePath = path.join(root, "test.txt");
      await writeFile(filePath, "line1\nline2");

      const backend = new FilesystemBackend({
        rootDir: root,
        virtualMode: false,
      });

      const result = await backend.readRaw(filePath);
      expect(result.error).toBeUndefined();
      expect(typeof result.data!.content).toBe("string");
      expect(result.data!.content).toBe("line1\nline2");
      expect(result.data!.created_at).toBeDefined();
      expect(result.data!.modified_at).toBeDefined();
    });

    it("should return Uint8Array v2 format for binary files", async () => {
      const root = tmpDir;
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const filePath = path.join(root, "image.png");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, pngHeader);

      const backend = new FilesystemBackend({
        rootDir: root,
        virtualMode: false,
      });

      const result = await backend.readRaw(filePath);
      expect(result.error).toBeUndefined();
      expect(result.data!.content).toBeInstanceOf(Uint8Array);
      expect(result.data!.content).toEqual(new Uint8Array(pngHeader));
    });
  });
});
