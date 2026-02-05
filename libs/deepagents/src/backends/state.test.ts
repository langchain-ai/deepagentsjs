import { describe, it, expect, vi, beforeEach } from "vitest";
import { StateBackend } from "./state.js";
import type { FileData } from "./protocol.js";
import { getCurrentTaskInput, Command } from "@langchain/langgraph";
import { ToolMessage } from "@langchain/core/messages";

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getCurrentTaskInput: vi.fn(),
  };
});

/**
 * Helper to create a mock config with state
 */
function makeConfig(files: Record<string, FileData> = {}) {
  const state = {
    messages: [],
    files,
  };
  vi.mocked(getCurrentTaskInput).mockReturnValue(state);
  return {
    state,
    stateAndStore: { state, store: undefined },
    config: {},
  };
}

describe("StateBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should write, read, edit, ls, grep, and glob", () => {
    const { state, stateAndStore } = makeConfig();
    const backend = new StateBackend(stateAndStore);

    const writeRes = backend.write("/notes.txt", "hello world");
    expect(writeRes).toBeDefined();
    expect(writeRes.error).toBeUndefined();
    expect(writeRes.filesUpdate).toBeDefined();

    Object.assign(state.files, writeRes.filesUpdate);

    const content = backend.read("/notes.txt");
    expect(content).toContain("hello world");

    const editRes = backend.edit("/notes.txt", "hello", "hi", false);
    expect(editRes).toBeDefined();
    expect(editRes.error).toBeUndefined();
    expect(editRes.filesUpdate).toBeDefined();
    Object.assign(state.files, editRes.filesUpdate);

    const content2 = backend.read("/notes.txt");
    expect(content2).toContain("hi world");

    const listing = backend.lsInfo("/");
    expect(listing.some((fi) => fi.path === "/notes.txt")).toBe(true);

    const matches = backend.grepRaw("hi", "/");
    expect(Array.isArray(matches)).toBe(true);
    if (Array.isArray(matches)) {
      expect(matches.some((m) => m.path === "/notes.txt")).toBe(true);
    }

    // Special characters like "[" are treated literally (not regex), returns empty list or matches
    const literalResult = backend.grepRaw("[", "/");
    expect(Array.isArray(literalResult)).toBe(true);

    const infos = backend.globInfo("*.txt", "/");
    expect(infos.some((i) => i.path === "/notes.txt")).toBe(true);
  });

  it("should handle errors correctly", () => {
    const { state, stateAndStore } = makeConfig();
    const backend = new StateBackend(stateAndStore);

    const editErr = backend.edit("/missing.txt", "a", "b");
    expect(editErr.error).toBeDefined();
    expect(editErr.error).toContain("not found");

    const writeRes = backend.write("/dup.txt", "x");
    expect(writeRes.filesUpdate).toBeDefined();
    Object.assign(state.files, writeRes.filesUpdate);

    const dupErr = backend.write("/dup.txt", "y");
    expect(dupErr.error).toBeDefined();
    expect(dupErr.error).toContain("already exists");
  });

  it("should list nested directories correctly", () => {
    const { state, stateAndStore } = makeConfig();
    const backend = new StateBackend(stateAndStore);

    const files: Record<string, string> = {
      "/src/main.py": "main code",
      "/src/utils/helper.py": "helper code",
      "/src/utils/common.py": "common code",
      "/docs/readme.md": "readme",
      "/docs/api/reference.md": "api reference",
      "/config.json": "config",
    };

    for (const [path, content] of Object.entries(files)) {
      const res = backend.write(path, content);
      expect(res.error).toBeUndefined();
      Object.assign(state.files, res.filesUpdate!);
    }

    const rootListing = backend.lsInfo("/");
    const rootPaths = rootListing.map((fi) => fi.path);
    expect(rootPaths).toContain("/config.json");
    expect(rootPaths).toContain("/src/");
    expect(rootPaths).toContain("/docs/");
    expect(rootPaths).not.toContain("/src/main.py");
    expect(rootPaths).not.toContain("/src/utils/helper.py");

    const srcListing = backend.lsInfo("/src/");
    const srcPaths = srcListing.map((fi) => fi.path);
    expect(srcPaths).toContain("/src/main.py");
    expect(srcPaths).toContain("/src/utils/");
    expect(srcPaths).not.toContain("/src/utils/helper.py");

    const utilsListing = backend.lsInfo("/src/utils/");
    const utilsPaths = utilsListing.map((fi) => fi.path);
    expect(utilsPaths).toContain("/src/utils/helper.py");
    expect(utilsPaths).toContain("/src/utils/common.py");
    expect(utilsPaths).toHaveLength(2);

    const emptyListing = backend.lsInfo("/nonexistent/");
    expect(emptyListing).toEqual([]);
  });

  it("should handle trailing slashes in ls", () => {
    const { state, stateAndStore } = makeConfig();
    const backend = new StateBackend(stateAndStore);

    const files: Record<string, string> = {
      "/file.txt": "content",
      "/dir/nested.txt": "nested",
    };

    for (const [path, content] of Object.entries(files)) {
      const res = backend.write(path, content);
      expect(res.error).toBeUndefined();
      Object.assign(state.files, res.filesUpdate!);
    }

    const listingWithSlash = backend.lsInfo("/");
    expect(listingWithSlash).toHaveLength(2);
    const rootPaths = listingWithSlash.map((fi) => fi.path);
    expect(rootPaths).toContain("/file.txt");
    expect(rootPaths).toContain("/dir/");

    const listingFromDir = backend.lsInfo("/dir/");
    expect(listingFromDir).toHaveLength(1);
    expect(listingFromDir[0].path).toBe("/dir/nested.txt");
  });

  it("should handle read with offset and limit", () => {
    const { state, stateAndStore } = makeConfig();
    const backend = new StateBackend(stateAndStore);

    const content = "line1\nline2\nline3\nline4\nline5";
    const writeRes = backend.write("/multiline.txt", content);
    Object.assign(state.files, writeRes.filesUpdate!);

    const readWithOffset = backend.read("/multiline.txt", 2, 2);
    expect(readWithOffset).toContain("line3");
    expect(readWithOffset).toContain("line4");
    expect(readWithOffset).not.toContain("line1");
    expect(readWithOffset).not.toContain("line5");
  });

  it("should handle edit with replace_all", () => {
    const { state, stateAndStore } = makeConfig();
    const backend = new StateBackend(stateAndStore);

    const writeRes = backend.write("/repeat.txt", "foo bar foo baz foo");
    Object.assign(state.files, writeRes.filesUpdate!);

    const editSingle = backend.edit("/repeat.txt", "foo", "qux", false);
    expect(editSingle.error).toBeDefined();
    expect(editSingle.error).toContain("appears 3 times");

    const editAll = backend.edit("/repeat.txt", "foo", "qux", true);
    expect(editAll.error).toBeUndefined();
    expect(editAll.occurrences).toBe(3);
    Object.assign(state.files, editAll.filesUpdate!);

    const readAfter = backend.read("/repeat.txt");
    expect(readAfter).toContain("qux bar qux baz qux");
    expect(readAfter).not.toContain("foo");
  });

  it("should handle grep with glob filter", () => {
    const { state, stateAndStore } = makeConfig();
    const backend = new StateBackend(stateAndStore);

    const files: Record<string, string> = {
      "/test.py": "import os",
      "/test.js": "import fs",
      "/readme.md": "import guide",
    };

    for (const [path, content] of Object.entries(files)) {
      const res = backend.write(path, content);
      Object.assign(state.files, res.filesUpdate!);
    }

    const matches = backend.grepRaw("import", "/", "*.py");
    expect(Array.isArray(matches)).toBe(true);
    if (Array.isArray(matches)) {
      expect(matches).toHaveLength(1);
      expect(matches[0].path).toBe("/test.py");
    }
  });

  it("should return empty content warning for empty files", () => {
    const { state, stateAndStore } = makeConfig();
    const backend = new StateBackend(stateAndStore);

    const writeRes = backend.write("/empty.txt", "");
    Object.assign(state.files, writeRes.filesUpdate!);

    const content = backend.read("/empty.txt");
    expect(content).toContain(
      "System reminder: File exists but has empty contents",
    );
  });

  describe("uploadFiles", () => {
    it("should upload files and return filesUpdate", () => {
      const { stateAndStore } = makeConfig();
      const backend = new StateBackend(stateAndStore);

      const files: Array<[string, Uint8Array]> = [
        ["/file1.txt", new TextEncoder().encode("content1")],
        ["/file2.txt", new TextEncoder().encode("content2")],
      ];

      const result = backend.uploadFiles(files);
      expect(result).toHaveLength(2);
      expect(result[0].path).toBe("/file1.txt");
      expect(result[0].error).toBeNull();
      expect(result[1].path).toBe("/file2.txt");
      expect(result[1].error).toBeNull();

      // Check filesUpdate is attached
      expect((result as any).filesUpdate).toBeDefined();
      expect((result as any).filesUpdate["/file1.txt"]).toBeDefined();
      expect((result as any).filesUpdate["/file2.txt"]).toBeDefined();
    });

    it("should handle binary content", () => {
      const { stateAndStore } = makeConfig();
      const backend = new StateBackend(stateAndStore);

      const binaryContent = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
      const files: Array<[string, Uint8Array]> = [
        ["/hello.txt", binaryContent],
      ];

      const result = backend.uploadFiles(files);
      expect(result[0].error).toBeNull();
      expect((result as any).filesUpdate["/hello.txt"].content).toEqual([
        "Hello",
      ]);
    });
  });

  describe("downloadFiles", () => {
    it("should download existing files as Uint8Array", () => {
      const { state, stateAndStore } = makeConfig();
      const backend = new StateBackend(stateAndStore);

      const writeRes = backend.write("/test.txt", "test content");
      Object.assign(state.files, writeRes.filesUpdate);

      const result = backend.downloadFiles(["/test.txt"]);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("/test.txt");
      expect(result[0].error).toBeNull();
      expect(result[0].content).not.toBeNull();

      const content = new TextDecoder().decode(result[0].content!);
      expect(content).toBe("test content");
    });

    it("should return file_not_found for missing files", () => {
      const { stateAndStore } = makeConfig();
      const backend = new StateBackend(stateAndStore);

      const result = backend.downloadFiles(["/nonexistent.txt"]);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("/nonexistent.txt");
      expect(result[0].content).toBeNull();
      expect(result[0].error).toBe("file_not_found");
    });

    it("should handle multiple files with mixed results", () => {
      const { state, stateAndStore } = makeConfig();
      const backend = new StateBackend(stateAndStore);

      const writeRes = backend.write("/exists.txt", "I exist");
      Object.assign(state.files, writeRes.filesUpdate);

      const result = backend.downloadFiles(["/exists.txt", "/missing.txt"]);
      expect(result).toHaveLength(2);

      expect(result[0].error).toBeNull();
      expect(result[0].content).not.toBeNull();

      expect(result[1].error).toBe("file_not_found");
      expect(result[1].content).toBeNull();
    });
  });

  it("should handle large tool result interception via middleware", async () => {
    const { config } = makeConfig();
    const { createFilesystemMiddleware } = await import("../middleware/fs.js");

    const middleware = createFilesystemMiddleware({
      toolTokenLimitBeforeEvict: 1000,
    });

    const largeContent = "x".repeat(5000);
    const toolMessage = new ToolMessage({
      content: largeContent,
      tool_call_id: "test_123",
      name: "test_tool",
    });

    const mockToolFn = async () => toolMessage;
    const mockToolCall = { name: "test_tool", args: {}, id: "test_123" };

    const result = await (middleware as any).wrapToolCall(
      {
        toolCall: mockToolCall,
        config: config,
        state: { files: {}, messages: [] },
        runtime: {},
      },
      mockToolFn,
    );

    expect(result).toBeInstanceOf(Command);
    expect(result.update.files).toBeDefined();
    expect(result.update.files["/large_tool_results/test_123"]).toBeDefined();
    expect(result.update.files["/large_tool_results/test_123"].content).toEqual(
      [largeContent],
    );

    expect(result.update.messages).toHaveLength(1);
    expect(result.update.messages[0].content).toContain(
      "Tool result too large",
    );
    expect(result.update.messages[0].content).toContain(
      "/large_tool_results/test_123",
    );
  });
});
