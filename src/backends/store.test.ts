import { describe, it, expect } from "vitest";
import { StoreBackend } from "./store.js";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";

/**
 * Helper to create a mock config with InMemoryStore
 */
function makeConfig() {
  const store = new InMemoryStore();
  const stateAndStore = {
    state: { files: {}, messages: [] },
    store,
  };
  const config = {
    store,
    configurable: {},
  };

  return { store, stateAndStore, config };
}

describe("StoreBackend", () => {
  it("should handle CRUD and search operations", async () => {
    const { stateAndStore } = makeConfig();
    const backend = new StoreBackend(stateAndStore);

    const writeResult = await backend.write("/docs/readme.md", "hello store");
    expect(writeResult).toBeDefined();
    expect(writeResult.error).toBeUndefined();
    expect(writeResult.path).toBe("/docs/readme.md");
    expect(writeResult.filesUpdate).toBeNull();

    const content = await backend.read("/docs/readme.md");
    expect(content).toContain("hello store");

    const editResult = await backend.edit(
      "/docs/readme.md",
      "hello",
      "hi",
      false,
    );
    expect(editResult).toBeDefined();
    expect(editResult.error).toBeUndefined();
    expect(editResult.occurrences).toBe(1);

    const infos = await backend.lsInfo("/docs/");
    expect(infos.some((i) => i.path === "/docs/readme.md")).toBe(true);

    const matches = await backend.grepRaw("hi", "/");
    expect(Array.isArray(matches)).toBe(true);
    if (Array.isArray(matches)) {
      expect(matches.some((m) => m.path === "/docs/readme.md")).toBe(true);
    }

    const glob1 = await backend.globInfo("*.md", "/");
    expect(glob1.length).toBe(0);

    const glob2 = await backend.globInfo("**/*.md", "/");
    expect(glob2.some((i) => i.path === "/docs/readme.md")).toBe(true);
  });

  it("should list nested directories correctly", async () => {
    const { stateAndStore } = makeConfig();
    const backend = new StoreBackend(stateAndStore);

    const files: Record<string, string> = {
      "/src/main.py": "main code",
      "/src/utils/helper.py": "helper code",
      "/src/utils/common.py": "common code",
      "/docs/readme.md": "readme",
      "/docs/api/reference.md": "api reference",
      "/config.json": "config",
    };

    for (const [path, content] of Object.entries(files)) {
      const res = await backend.write(path, content);
      expect(res.error).toBeUndefined();
    }

    const rootListing = await backend.lsInfo("/");
    const rootPaths = rootListing.map((fi) => fi.path);
    expect(rootPaths).toContain("/config.json");
    expect(rootPaths).toContain("/src/");
    expect(rootPaths).toContain("/docs/");
    expect(rootPaths).not.toContain("/src/main.py");
    expect(rootPaths).not.toContain("/src/utils/helper.py");
    expect(rootPaths).not.toContain("/docs/readme.md");
    expect(rootPaths).not.toContain("/docs/api/reference.md");

    const srcListing = await backend.lsInfo("/src/");
    const srcPaths = srcListing.map((fi) => fi.path);
    expect(srcPaths).toContain("/src/main.py");
    expect(srcPaths).toContain("/src/utils/");
    expect(srcPaths).not.toContain("/src/utils/helper.py");

    const utilsListing = await backend.lsInfo("/src/utils/");
    const utilsPaths = utilsListing.map((fi) => fi.path);
    expect(utilsPaths).toContain("/src/utils/helper.py");
    expect(utilsPaths).toContain("/src/utils/common.py");
    expect(utilsPaths).toHaveLength(2);

    const emptyListing = await backend.lsInfo("/nonexistent/");
    expect(emptyListing).toEqual([]);
  });

  it("should handle trailing slashes in ls", async () => {
    const { stateAndStore } = makeConfig();
    const backend = new StoreBackend(stateAndStore);

    const files: Record<string, string> = {
      "/file.txt": "content",
      "/dir/nested.txt": "nested",
    };

    for (const [path, content] of Object.entries(files)) {
      const res = await backend.write(path, content);
      expect(res.error).toBeUndefined();
    }

    const listingFromRoot = await backend.lsInfo("/");
    expect(listingFromRoot.length).toBeGreaterThan(0);

    const listing1 = await backend.lsInfo("/dir/");
    const listing2 = await backend.lsInfo("/dir");
    expect(listing1.length).toBe(listing2.length);
    expect(listing1.map((fi) => fi.path)).toEqual(
      listing2.map((fi) => fi.path),
    );
  });

  it("should handle errors correctly", async () => {
    const { stateAndStore } = makeConfig();
    const backend = new StoreBackend(stateAndStore);

    const editErr = await backend.edit("/missing.txt", "a", "b");
    expect(editErr.error).toBeDefined();
    expect(editErr.error).toContain("not found");

    const writeRes = await backend.write("/dup.txt", "x");
    expect(writeRes.error).toBeUndefined();

    const dupErr = await backend.write("/dup.txt", "y");
    expect(dupErr.error).toBeDefined();
    expect(dupErr.error).toContain("already exists");
  });

  it("should handle read with offset and limit", async () => {
    const { stateAndStore } = makeConfig();
    const backend = new StoreBackend(stateAndStore);

    const content = "line1\nline2\nline3\nline4\nline5";
    await backend.write("/multiline.txt", content);

    const readWithOffset = await backend.read("/multiline.txt", 2, 2);
    expect(readWithOffset).toContain("line3");
    expect(readWithOffset).toContain("line4");
    expect(readWithOffset).not.toContain("line1");
    expect(readWithOffset).not.toContain("line5");
  });

  it("should handle edit with replace_all", async () => {
    const { stateAndStore } = makeConfig();
    const backend = new StoreBackend(stateAndStore);

    await backend.write("/repeat.txt", "foo bar foo baz foo");

    const editSingle = await backend.edit("/repeat.txt", "foo", "qux", false);
    expect(editSingle.error).toBeDefined();
    expect(editSingle.error).toContain("appears 3 times");

    const editAll = await backend.edit("/repeat.txt", "foo", "qux", true);
    expect(editAll.error).toBeUndefined();
    expect(editAll.occurrences).toBe(3);

    const readAfter = await backend.read("/repeat.txt");
    expect(readAfter).toContain("qux bar qux baz qux");
    expect(readAfter).not.toContain("foo");
  });

  it("should handle grep with glob filter", async () => {
    const { stateAndStore } = makeConfig();
    const backend = new StoreBackend(stateAndStore);

    const files: Record<string, string> = {
      "/test.py": "import os",
      "/test.js": "import fs",
      "/readme.md": "import guide",
    };

    for (const [path, content] of Object.entries(files)) {
      await backend.write(path, content);
    }

    const matches = await backend.grepRaw("import", "/", "*.py");
    expect(Array.isArray(matches)).toBe(true);
    if (Array.isArray(matches)) {
      expect(matches).toHaveLength(1);
      expect(matches[0].path).toBe("/test.py");
    }
  });

  it("should return empty content warning for empty files", async () => {
    const { stateAndStore } = makeConfig();
    const backend = new StoreBackend(stateAndStore);

    await backend.write("/empty.txt", "");

    const content = await backend.read("/empty.txt");
    expect(content).toContain(
      "System reminder: File exists but has empty contents",
    );
  });

  it("should use custom namespace when assistant_id is provided", async () => {
    const { store } = makeConfig();
    const stateAndStoreWithAssistant = {
      state: { files: {}, messages: [] },
      store,
      assistantId: "test-assistant",
    };

    const backend = new StoreBackend(stateAndStoreWithAssistant);

    await backend.write("/test.txt", "content");

    const items = await store.search(["test-assistant", "filesystem"]);
    expect(items.some((item) => item.key === "/test.txt")).toBe(true);

    const defaultItems = await store.search(["filesystem"]);
    expect(defaultItems.some((item) => item.key === "/test.txt")).toBe(false);
  });

  describe("uploadFiles", () => {
    it("should upload files to store", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore);

      const files: Array<[string, Uint8Array]> = [
        ["/file1.txt", new TextEncoder().encode("content1")],
        ["/file2.txt", new TextEncoder().encode("content2")],
      ];

      const result = await backend.uploadFiles(files);
      expect(result).toHaveLength(2);
      expect(result[0].path).toBe("/file1.txt");
      expect(result[0].error).toBeNull();
      expect(result[1].path).toBe("/file2.txt");
      expect(result[1].error).toBeNull();

      // Verify files are stored
      const content1 = await backend.read("/file1.txt");
      expect(content1).toContain("content1");
      const content2 = await backend.read("/file2.txt");
      expect(content2).toContain("content2");
    });

    it("should handle binary content", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore);

      const binaryContent = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
      const files: Array<[string, Uint8Array]> = [
        ["/hello.txt", binaryContent],
      ];

      const result = await backend.uploadFiles(files);
      expect(result[0].error).toBeNull();

      const content = await backend.read("/hello.txt");
      expect(content).toContain("Hello");
    });
  });

  describe("downloadFiles", () => {
    it("should download existing files as Uint8Array", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore);

      await backend.write("/test.txt", "test content");

      const result = await backend.downloadFiles(["/test.txt"]);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("/test.txt");
      expect(result[0].error).toBeNull();
      expect(result[0].content).not.toBeNull();

      const content = new TextDecoder().decode(result[0].content!);
      expect(content).toBe("test content");
    });

    it("should return file_not_found for missing files", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore);

      const result = await backend.downloadFiles(["/nonexistent.txt"]);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("/nonexistent.txt");
      expect(result[0].content).toBeNull();
      expect(result[0].error).toBe("file_not_found");
    });

    it("should handle multiple files with mixed results", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore);

      await backend.write("/exists.txt", "I exist");

      const result = await backend.downloadFiles([
        "/exists.txt",
        "/missing.txt",
      ]);
      expect(result).toHaveLength(2);

      expect(result[0].error).toBeNull();
      expect(result[0].content).not.toBeNull();

      expect(result[1].error).toBe("file_not_found");
      expect(result[1].content).toBeNull();
    });
  });

  it("should handle large tool result interception via middleware", async () => {
    const { store, config } = makeConfig();
    const { createFilesystemMiddleware } = await import("../middleware/fs.js");
    const { ToolMessage } = await import("@langchain/core/messages");

    const middleware = createFilesystemMiddleware({
      backend: (stateAndStore) => new StoreBackend(stateAndStore),
      toolTokenLimitBeforeEvict: 1000,
    });

    const largeContent = "y".repeat(5000);
    const toolMessage = new ToolMessage({
      content: largeContent,
      tool_call_id: "test_456",
      name: "test_tool",
    });

    const mockToolFn = async () => toolMessage;
    const mockToolCall = { name: "test_tool", args: {}, id: "test_456" };

    const result = await (middleware as any).wrapToolCall(
      {
        toolCall: mockToolCall,
        config: config,
        state: { files: {}, messages: [] },
        runtime: {},
      },
      mockToolFn,
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect(result.content).toContain("Tool result too large");
    expect(result.content).toContain("/large_tool_results/test_456");

    const storedContent = await store.get(
      ["filesystem"],
      "/large_tool_results/test_456",
    );
    expect(storedContent).toBeDefined();
    expect((storedContent!.value as any).content).toEqual([largeContent]);
  });
});
