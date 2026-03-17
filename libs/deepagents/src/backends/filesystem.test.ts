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

    const infos = await backend.lsInfo(root);
    const paths = new Set(infos.map((i) => i.path));
    expect(paths.has(f1)).toBe(true);
    expect(paths.has(f2)).toBe(false);
    expect(paths.has(path.join(root, "dir") + path.sep)).toBe(true);

    const txt = await backend.read(f1);
    expect(txt).toContain("hello fs");

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

    const matches = await backend.grepRaw("hello", root);
    expect(Array.isArray(matches)).toBe(true);
    if (Array.isArray(matches)) {
      expect(matches.some((m) => m.path.endsWith("a.txt"))).toBe(true);
    }

    const globResults = await backend.globInfo("**/*.py", root);
    expect(globResults.some((i) => i.path === f2)).toBe(true);
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

    const infos = await backend.lsInfo("/");
    const paths = new Set(infos.map((i) => i.path));
    expect(paths.has("/a.txt")).toBe(true);
    expect(paths.has("/dir/b.md")).toBe(false);
    expect(paths.has("/dir/")).toBe(true);

    const txt = await backend.read("/a.txt");
    expect(txt).toContain("hello virtual");

    const editMsg = await backend.edit("/a.txt", "virtual", "virt", false);
    expect(editMsg).toBeDefined();
    expect(editMsg.error).toBeUndefined();
    expect(editMsg.occurrences).toBe(1);

    const writeMsg = await backend.write("/new.txt", "x");
    expect(writeMsg).toBeDefined();
    expect(writeMsg.error).toBeUndefined();
    expect(fsSync.existsSync(path.join(root, "new.txt"))).toBe(true);

    const matches = await backend.grepRaw("virt", "/");
    expect(Array.isArray(matches)).toBe(true);
    if (Array.isArray(matches)) {
      expect(matches.some((m) => m.path === "/a.txt")).toBe(true);
    }

    const globResults = await backend.globInfo("**/*.md", "/");
    expect(globResults.some((i) => i.path === "/dir/b.md")).toBe(true);

    // Special characters like "[" are treated literally (not regex), returns empty list or matches
    const literalResult = await backend.grepRaw("[", "/");
    expect(Array.isArray(literalResult)).toBe(true);

    const traversalError = await backend.read("/../a.txt");
    expect(traversalError).toContain("Error");
    expect(traversalError).toContain("Path traversal not allowed");
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

    const rootListing = await backend.lsInfo("/");
    const rootPaths = rootListing.map((fi) => fi.path);
    expect(rootPaths).toContain("/config.json");
    expect(rootPaths).toContain("/src/");
    expect(rootPaths).toContain("/docs/");
    expect(rootPaths).not.toContain("/src/main.py");
    expect(rootPaths).not.toContain("/src/utils/helper.py");

    const srcListing = await backend.lsInfo("/src/");
    const srcPaths = srcListing.map((fi) => fi.path);
    expect(srcPaths).toContain("/src/main.py");
    expect(srcPaths).toContain("/src/utils/");
    expect(srcPaths).not.toContain("/src/utils/helper.py");

    const utilsListing = await backend.lsInfo("/src/utils/");
    const utilsPaths = utilsListing.map((fi) => fi.path);
    expect(utilsPaths).toContain("/src/utils/helper.py");
    expect(utilsPaths).toContain("/src/utils/common.py");
    expect(utilsPaths.length).toBe(2);

    const emptyListing = await backend.lsInfo("/nonexistent/");
    expect(emptyListing).toEqual([]);
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

    const rootListing = await backend.lsInfo(root);
    const rootPaths = rootListing.map((fi) => fi.path);
    expect(rootPaths).toContain(path.join(root, "file1.txt"));
    expect(rootPaths).toContain(path.join(root, "subdir") + path.sep);
    expect(rootPaths).not.toContain(path.join(root, "subdir", "file2.txt"));

    const subdirListing = await backend.lsInfo(path.join(root, "subdir"));
    const subdirPaths = subdirListing.map((fi) => fi.path);
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

    const listingWithSlash = await backend.lsInfo("/");
    expect(listingWithSlash.length).toBeGreaterThan(0);

    const listing = await backend.lsInfo("/");
    const paths = listing.map((fi) => fi.path);
    expect(paths).toEqual([...paths].sort());

    const listing1 = await backend.lsInfo("/dir/");
    const listing2 = await backend.lsInfo("/dir");
    expect(listing1.length).toBe(listing2.length);
    expect(listing1.map((fi) => fi.path)).toEqual(
      listing2.map((fi) => fi.path),
    );

    const empty = await backend.lsInfo("/nonexistent/");
    expect(empty).toEqual([]);
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
    expect(readContent).toContain(largeContent.substring(0, 100));

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
    expect(txt).toContain("line1");
    expect(txt).toContain("line2");
    expect(txt).toContain("line3");
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
    expect(txt).toContain("empty contents");
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
    expect(content).toContain("initial content");
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
    expect(txt).toContain("line1");
    expect(txt).toContain("line2");
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
    expect(txt).toContain("Hello 世界");
    expect(txt).toContain("🚀 emoji");
    expect(txt).toContain("Ω omega");
  });

  it("should handle non-existent files consistently", async () => {
    const root = tmpDir;
    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const nonexistentPath = path.join(root, "nonexistent.txt");

    const readResult = await backend.read(nonexistentPath);
    expect(readResult).toContain("Error");
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
    expect(readResult).toContain("Error");
  });

  it("should support encoding parameter for file operations", async () => {
    const root = tmpDir;
    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const file = path.join(root, "encoding-test.txt");
    const text = "Hello 你好, café";
    const encoding = "utf-16le";
    const decoder = new TextDecoder(encoding);

    // 1. Write with utf-16le encoding
    const writeRes = await backend.write(file, text, encoding);
    expect(writeRes.error).toBeUndefined();

    // Verify raw file content on disk is actually utf-16le encoded
    const diskContentRaw = await fs.readFile(file);
    const decodedDiskContent = decoder.decode(diskContentRaw);
    expect(decodedDiskContent).toBe(text);

    // 2. Read with utf-16le encoding
    const readTxt = await backend.read(file, 0, 500, encoding);
    expect(readTxt).toContain(text);

    // 3. ReadRaw with utf-16le encoding
    const readRawResult = await backend.readRaw(file, encoding);
    expect(readRawResult.content.join("\n")).toContain(text);

    // 4. Edit with utf-16le encoding
    const oldTextSegment = "你好";
    const newTextSegment = "世界";
    const replacedText = text.replace(oldTextSegment, newTextSegment);

    const editRes = await backend.edit(
      file,
      oldTextSegment,
      newTextSegment,
      false,
      encoding,
    );
    expect(editRes.error).toBeUndefined();
    expect(editRes.occurrences).toBe(1);

    const newDiskContentRaw = await fs.readFile(file);
    const newDecodedDiskContent = decoder.decode(newDiskContentRaw);
    expect(newDecodedDiskContent).toBe(replacedText);

    // 5. Grep with utf-16le encoding
    const grepRes = await backend.grepRaw(newTextSegment, root, null, encoding);
    expect(Array.isArray(grepRes)).toBe(true);
    if (Array.isArray(grepRes)) {
      expect(grepRes.length).toBeGreaterThan(0);
      expect(grepRes[0].path).toBe(file);
      expect(grepRes[0].text).toContain(newTextSegment);
    }
  });
});
