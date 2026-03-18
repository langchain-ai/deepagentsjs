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

    const readRes = await backend.read("/docs/readme.md");
    expect(readRes.error).toBeUndefined();
    expect(readRes.content).toContain("hello store");

    const editResult = await backend.edit(
      "/docs/readme.md",
      "hello",
      "hi",
      false,
    );
    expect(editResult).toBeDefined();
    expect(editResult.error).toBeUndefined();
    expect(editResult.occurrences).toBe(1);

    const infos = await backend.ls("/docs/");
    expect(infos.error).toBeUndefined();
    expect(infos.files!.some((i) => i.path === "/docs/readme.md")).toBe(true);

    const grepRes = await backend.grep("hi", "/");
    expect(grepRes.error).toBeUndefined();
    expect(grepRes.matches).toBeDefined();
    expect(grepRes.matches!.some((m) => m.path === "/docs/readme.md")).toBe(
      true,
    );

    const glob1 = await backend.glob("*.md", "/");
    expect(glob1.error).toBeUndefined();
    expect(glob1.files!.length).toBe(0);

    const glob2 = await backend.glob("**/*.md", "/");
    expect(glob2.error).toBeUndefined();
    expect(glob2.files!.some((i) => i.path === "/docs/readme.md")).toBe(true);
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

    const rootListing = await backend.ls("/");
    expect(rootListing.error).toBeUndefined();
    const rootPaths = rootListing.files!.map((fi) => fi.path);
    expect(rootPaths).toContain("/config.json");
    expect(rootPaths).toContain("/src/");
    expect(rootPaths).toContain("/docs/");
    expect(rootPaths).not.toContain("/src/main.py");
    expect(rootPaths).not.toContain("/src/utils/helper.py");
    expect(rootPaths).not.toContain("/docs/readme.md");
    expect(rootPaths).not.toContain("/docs/api/reference.md");

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
    expect(utilsPaths).toHaveLength(2);

    const emptyListing = await backend.ls("/nonexistent/");
    expect(emptyListing.error).toBeUndefined();
    expect(emptyListing.files).toEqual([]);
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

    const listingFromRoot = await backend.ls("/");
    expect(listingFromRoot.error).toBeUndefined();
    expect(listingFromRoot.files!.length).toBeGreaterThan(0);

    const listing1 = await backend.ls("/dir/");
    expect(listing1.error).toBeUndefined();
    const listing2 = await backend.ls("/dir");
    expect(listing2.error).toBeUndefined();
    expect(listing1.files!.length).toBe(listing2.files!.length);
    expect(listing1.files!.map((fi) => fi.path)).toEqual(
      listing2.files!.map((fi) => fi.path),
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
    expect(readWithOffset.error).toBeUndefined();
    expect(readWithOffset.content).toContain("line3");
    expect(readWithOffset.content).toContain("line4");
    expect(readWithOffset.content).not.toContain("line1");
    expect(readWithOffset.content).not.toContain("line5");
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
    expect(readAfter.content).toContain("qux bar qux baz qux");
    expect(readAfter.content).not.toContain("foo");
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

    const grepRes = await backend.grep("import", "/", "*.py");
    expect(grepRes.error).toBeUndefined();
    expect(grepRes.matches).toHaveLength(1);
    expect(grepRes.matches![0].path).toBe("/test.py");
  });

  it("should return empty content warning for empty files", async () => {
    const { stateAndStore } = makeConfig();
    const backend = new StoreBackend(stateAndStore);

    await backend.write("/empty.txt", "");

    const readRes = await backend.read("/empty.txt");
    expect(readRes.content).toBe("");
  });

  it("should use assistantId-based namespace when no custom namespace provided", async () => {
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
      const readRes1 = await backend.read("/file1.txt");
      expect(readRes1.content).toContain("content1");
      const readRes2 = await backend.read("/file2.txt");
      expect(readRes2.content).toContain("content2");
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

      const readRes = await backend.read("/hello.txt");
      expect(readRes.content).toContain("Hello");
    });

    it("should upload binary (image) files as Uint8Array", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const result = await backend.uploadFiles([["/image.png", pngBytes]]);
      expect(result[0].error).toBeNull();

      const raw = await backend.readRaw("/image.png");
      expect(raw.error).toBeUndefined();
      expect(raw.data!.content).toBeInstanceOf(Uint8Array);
      expect(raw.data!.content).toEqual(pngBytes);
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

    it("should download binary files as raw bytes", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);

      await backend.uploadFiles([["/image.png", pngBytes]]);

      const result = await backend.downloadFiles(["/image.png"]);
      expect(result).toHaveLength(1);
      expect(result[0].error).toBeNull();
      expect(result[0].content).not.toBeNull();
      expect(new Uint8Array(result[0].content!)).toEqual(pngBytes);
    });
  });

  describe("binary file round-trip", () => {
    it("should upload and download binary files with identical bytes", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore);

      const originalBytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) originalBytes[i] = i;

      const uploadResult = await backend.uploadFiles([
        ["/data.png", originalBytes],
      ]);
      expect(uploadResult[0].error).toBeNull();

      const downloadResult = await backend.downloadFiles(["/data.png"]);
      expect(downloadResult[0].error).toBeNull();
      expect(new Uint8Array(downloadResult[0].content!)).toEqual(originalBytes);
    });

    it("should read binary files as Uint8Array content", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);

      await backend.uploadFiles([["/photo.png", pngBytes]]);

      const readResult = await backend.read("/photo.png");
      expect(readResult.error).toBeUndefined();
      expect(readResult.content).toBeInstanceOf(Uint8Array);
      expect(readResult.content).toEqual(pngBytes);
    });

    it("should skip binary files in grep", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      await backend.uploadFiles([["/image.png", pngBytes]]);
      await backend.write("/notes.txt", "hello PNG");

      const grepRes = await backend.grep("PNG", "/");
      expect(grepRes.matches).toHaveLength(1);
      expect(grepRes.matches![0].path).toBe("/notes.txt");
    });

    it("should ignore offset/limit for binary reads", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      await backend.uploadFiles([["/img.png", pngBytes]]);

      const full = await backend.read("/img.png");
      const withOffsetLimit = await backend.read("/img.png", 5, 2);
      expect(withOffsetLimit.content).toBe(full.content);
    });
  });

  it("should use custom namespace", async () => {
    const { store } = makeConfig();
    const stateAndStore = {
      state: { files: {}, messages: [] },
      store,
    };

    const backend = new StoreBackend(stateAndStore, {
      namespace: ["org-123", "user-456", "filesystem"],
    });

    await backend.write("/test.txt", "namespaced content");

    const items = await store.search(["org-123", "user-456", "filesystem"]);
    expect(items.some((item) => item.key === "/test.txt")).toBe(true);

    const defaultItems = await store.search(["filesystem"]);
    expect(defaultItems.some((item) => item.key === "/test.txt")).toBe(false);
  });

  it("should isolate data between different namespaces", async () => {
    const { store } = makeConfig();
    const stateAndStore = {
      state: { files: {}, messages: [] },
      store,
    };

    const userABackend = new StoreBackend(stateAndStore, {
      namespace: ["org-1", "user-a", "filesystem"],
    });

    const userBBackend = new StoreBackend(stateAndStore, {
      namespace: ["org-1", "user-b", "filesystem"],
    });

    await userABackend.write("/notes.txt", "user A notes");
    await userBBackend.write("/notes.txt", "user B notes");

    const readA = await userABackend.read("/notes.txt");
    expect(readA.content).toContain("user A notes");

    const readB = await userBBackend.read("/notes.txt");
    expect(readB.content).toContain("user B notes");

    const userAItems = await store.search(["org-1", "user-a", "filesystem"]);
    const userBItems = await store.search(["org-1", "user-b", "filesystem"]);
    expect(userAItems).toHaveLength(1);
    expect(userBItems).toHaveLength(1);
  });

  it("should validate namespace components", async () => {
    const { store } = makeConfig();
    const stateAndStore = {
      state: { files: {}, messages: [] },
      store,
    };

    expect(
      () =>
        new StoreBackend(stateAndStore, {
          namespace: ["filesystem", "*"],
        }),
    ).toThrow("disallowed characters");

    expect(
      () =>
        new StoreBackend(stateAndStore, {
          namespace: [],
        }),
    ).toThrow("must not be empty");
  });

  it("should work with backend factory pattern for dynamic namespaces", async () => {
    const { store } = makeConfig();
    const userId = "ctx-user-789";

    const backendFactory = (stateAndStore: any) =>
      new StoreBackend(stateAndStore, {
        namespace: ["filesystem", userId],
      });

    const stateAndStore = {
      state: { files: {}, messages: [] },
      store,
    };
    const backend = backendFactory(stateAndStore);

    await backend.write("/test.txt", "context-derived namespace");

    const items = await store.search(["filesystem", "ctx-user-789"]);
    expect(items.some((item) => item.key === "/test.txt")).toBe(true);
  });

  it("should handle large tool result interception via middleware", async () => {
    const { store } = makeConfig();
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
        state: { files: {}, messages: [] },
        runtime: { store },
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
    expect((storedContent!.value as any).content).toBe(largeContent);
  });

  describe("fileFormat: v1", () => {
    it("should write v1 format (content as line array)", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore, { fileFormat: "v1" });

      await backend.write("/notes.txt", "line1\nline2");

      const raw = await backend.readRaw("/notes.txt");
      expect(raw.error).toBeUndefined();
      expect(Array.isArray(raw.data!.content)).toBe(true);
      expect(raw.data!.content).toEqual(["line1", "line2"]);
    });

    it("should read v1 data correctly", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore, { fileFormat: "v1" });

      await backend.write("/notes.txt", "hello world");

      const readRes = await backend.read("/notes.txt");
      expect(readRes.error).toBeUndefined();
      expect(readRes.content).toContain("hello world");
    });

    it("should edit v1 data correctly", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore, { fileFormat: "v1" });

      await backend.write("/notes.txt", "hello world");
      const editRes = await backend.edit("/notes.txt", "hello", "hi");
      expect(editRes.error).toBeUndefined();

      const readRes = await backend.read("/notes.txt");
      expect(readRes.content).toContain("hi world");
    });

    it("should upload files as v1 format", async () => {
      const { stateAndStore } = makeConfig();
      const backend = new StoreBackend(stateAndStore, { fileFormat: "v1" });

      const files: Array<[string, Uint8Array]> = [
        ["/hello.txt", new TextEncoder().encode("Hello")],
      ];

      const result = await backend.uploadFiles(files);
      expect(result[0].error).toBeNull();

      const raw = await backend.readRaw("/hello.txt");
      expect(raw.error).toBeUndefined();
      expect(Array.isArray(raw.data!.content)).toBe(true);
      expect(raw.data!.content).toEqual(["Hello"]);
    });
  });

  describe("backwards compatibility: v2 backend reading v1 data", () => {
    it("should read pre-existing v1 data from store", async () => {
      const { store, stateAndStore } = makeConfig();

      // Simulate legacy v1 data already in store
      await store.put(["filesystem"], "/legacy.txt", {
        content: ["line1", "line2", "line3"],
        created_at: "2024-01-01T00:00:00.000Z",
        modified_at: "2024-01-01T00:00:00.000Z",
      });

      const backend = new StoreBackend(stateAndStore); // default v2

      const readRes = await backend.read("/legacy.txt");
      expect(readRes.error).toBeUndefined();
      expect(readRes.content).toBe("line1\nline2\nline3");
    });

    it("should read v1 data with offset/limit", async () => {
      const { store, stateAndStore } = makeConfig();

      await store.put(["filesystem"], "/legacy.txt", {
        content: ["a", "b", "c", "d", "e"],
        created_at: "2024-01-01T00:00:00.000Z",
        modified_at: "2024-01-01T00:00:00.000Z",
      });

      const backend = new StoreBackend(stateAndStore);

      const readRes = await backend.read("/legacy.txt", 1, 2);
      expect(readRes.content).toBe("b\nc");
    });

    it("should grep across mixed v1 and v2 data in store", async () => {
      const { store, stateAndStore } = makeConfig();

      // Legacy v1 data
      await store.put(["filesystem"], "/legacy.py", {
        content: ["import os", "print('v1')"],
        created_at: "2024-01-01T00:00:00.000Z",
        modified_at: "2024-01-01T00:00:00.000Z",
      });

      const backend = new StoreBackend(stateAndStore); // default v2

      // Write a v2 file
      await backend.write("/modern.py", "import sys\nprint('v2')");

      const grepRes = await backend.grep("import", "/");
      expect(grepRes.matches).toHaveLength(2);
      const paths = grepRes.matches!.map((m) => m.path).sort();
      expect(paths).toEqual(["/legacy.py", "/modern.py"]);
    });

    it("should list mixed v1 and v2 files with correct sizes", async () => {
      const { store, stateAndStore } = makeConfig();

      await store.put(["filesystem"], "/legacy.txt", {
        content: ["hello"],
        created_at: "2024-01-01T00:00:00.000Z",
        modified_at: "2024-01-01T00:00:00.000Z",
      });

      const backend = new StoreBackend(stateAndStore);
      await backend.write("/modern.txt", "world");

      const listing = await backend.ls("/");
      expect(listing.error).toBeUndefined();
      expect(listing.files).toHaveLength(2);
      for (const info of listing.files!) {
        expect(info.size).toBe(5);
      }
    });
  });
});
