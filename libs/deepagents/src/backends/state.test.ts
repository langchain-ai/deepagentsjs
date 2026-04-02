import { describe, it, expect, vi, beforeEach } from "vitest";
import { StateBackend } from "./state.js";
import type { FileData, FileDataV1 } from "./protocol.js";
import { getCurrentTaskInput, getConfig, Command } from "@langchain/langgraph";
import { ToolMessage } from "@langchain/core/messages";

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getCurrentTaskInput: vi.fn(),
    getConfig: vi.fn(),
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
  const sendSpy = vi.fn();
  vi.mocked(getCurrentTaskInput).mockReturnValue(state);
  vi.mocked(getConfig).mockReturnValue({
    configurable: {
      __pregel_send: sendSpy,
    },
  } as any);
  return {
    state,
    runtime: { state, store: undefined },
    config: {},
    sendSpy,
  };
}

describe("StateBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should write, read, edit, ls, grep, and glob", () => {
    const { state, runtime } = makeConfig();
    const backend = new StateBackend(runtime);

    const writeRes = backend.write("/notes.txt", "hello world");
    expect(writeRes).toBeDefined();
    expect(writeRes.error).toBeUndefined();
    expect(writeRes.filesUpdate).toBeDefined();

    Object.assign(state.files, writeRes.filesUpdate);

    const readRes = backend.read("/notes.txt");
    expect(readRes.error).toBeUndefined();
    expect(readRes.content).toContain("hello world");

    const editRes = backend.edit("/notes.txt", "hello", "hi", false);
    expect(editRes).toBeDefined();
    expect(editRes.error).toBeUndefined();
    expect(editRes.filesUpdate).toBeDefined();
    Object.assign(state.files, editRes.filesUpdate);

    const readRes2 = backend.read("/notes.txt");
    expect(readRes2.error).toBeUndefined();
    expect(readRes2.content).toContain("hi world");

    const listing = backend.ls("/");
    expect(listing.error).toBeUndefined();
    expect(listing.files!.some((fi) => fi.path === "/notes.txt")).toBe(true);

    const grepRes = backend.grep("hi", "/");
    expect(grepRes.error).toBeUndefined();
    expect(grepRes.matches).toBeDefined();
    expect(grepRes.matches!.some((m) => m.path === "/notes.txt")).toBe(true);

    // Special characters like "[" are treated literally (not regex)
    const literalResult = backend.grep("[", "/");
    expect(literalResult.error).toBeUndefined();
    expect(literalResult.matches).toBeDefined();

    const infos = backend.glob("*.txt", "/");
    expect(infos.error).toBeUndefined();
    expect(infos.files!.some((i) => i.path === "/notes.txt")).toBe(true);
  });

  it("should handle errors correctly", () => {
    const { state, runtime } = makeConfig();
    const backend = new StateBackend(runtime);

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
    const { state, runtime } = makeConfig();
    const backend = new StateBackend(runtime);

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

    const rootListing = backend.ls("/");
    expect(rootListing.error).toBeUndefined();
    const rootPaths = rootListing.files!.map((fi) => fi.path);
    expect(rootPaths).toContain("/config.json");
    expect(rootPaths).toContain("/src/");
    expect(rootPaths).toContain("/docs/");
    expect(rootPaths).not.toContain("/src/main.py");
    expect(rootPaths).not.toContain("/src/utils/helper.py");

    const srcListing = backend.ls("/src/");
    expect(srcListing.error).toBeUndefined();
    const srcPaths = srcListing.files!.map((fi) => fi.path);
    expect(srcPaths).toContain("/src/main.py");
    expect(srcPaths).toContain("/src/utils/");
    expect(srcPaths).not.toContain("/src/utils/helper.py");

    const utilsListing = backend.ls("/src/utils/");
    expect(utilsListing.error).toBeUndefined();
    const utilsPaths = utilsListing.files!.map((fi) => fi.path);
    expect(utilsPaths).toContain("/src/utils/helper.py");
    expect(utilsPaths).toContain("/src/utils/common.py");
    expect(utilsPaths).toHaveLength(2);

    const emptyListing = backend.ls("/nonexistent/");
    expect(emptyListing.error).toBeUndefined();
    expect(emptyListing.files).toEqual([]);
  });

  it("should handle trailing slashes in ls", () => {
    const { state, runtime } = makeConfig();
    const backend = new StateBackend(runtime);

    const files: Record<string, string> = {
      "/file.txt": "content",
      "/dir/nested.txt": "nested",
    };

    for (const [path, content] of Object.entries(files)) {
      const res = backend.write(path, content);
      expect(res.error).toBeUndefined();
      Object.assign(state.files, res.filesUpdate!);
    }

    const listingWithSlash = backend.ls("/");
    expect(listingWithSlash.error).toBeUndefined();
    expect(listingWithSlash.files).toHaveLength(2);
    const rootPaths = listingWithSlash.files!.map((fi) => fi.path);
    expect(rootPaths).toContain("/file.txt");
    expect(rootPaths).toContain("/dir/");

    const listingFromDir = backend.ls("/dir/");
    expect(listingFromDir.error).toBeUndefined();
    expect(listingFromDir.files).toHaveLength(1);
    expect(listingFromDir.files![0].path).toBe("/dir/nested.txt");
  });

  it("should handle read with offset and limit", () => {
    const { state, runtime } = makeConfig();
    const backend = new StateBackend(runtime);

    const content = "line1\nline2\nline3\nline4\nline5";
    const writeRes = backend.write("/multiline.txt", content);
    Object.assign(state.files, writeRes.filesUpdate!);

    const readWithOffset = backend.read("/multiline.txt", 2, 2);
    expect(readWithOffset.error).toBeUndefined();
    expect(readWithOffset.content).toContain("line3");
    expect(readWithOffset.content).toContain("line4");
    expect(readWithOffset.content).not.toContain("line1");
    expect(readWithOffset.content).not.toContain("line5");
  });

  it("should handle edit with replace_all", () => {
    const { state, runtime } = makeConfig();
    const backend = new StateBackend(runtime);

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
    expect(readAfter.content).toContain("qux bar qux baz qux");
    expect(readAfter.content).not.toContain("foo");
  });

  it("should handle grep with glob filter", () => {
    const { state, runtime } = makeConfig();
    const backend = new StateBackend(runtime);

    const files: Record<string, string> = {
      "/test.py": "import os",
      "/test.js": "import fs",
      "/readme.md": "import guide",
    };

    for (const [path, content] of Object.entries(files)) {
      const res = backend.write(path, content);
      Object.assign(state.files, res.filesUpdate!);
    }

    const grepRes = backend.grep("import", "/", "*.py");
    expect(grepRes.error).toBeUndefined();
    expect(grepRes.matches).toHaveLength(1);
    expect(grepRes.matches![0].path).toBe("/test.py");
  });

  it("should return ReadRawResult with v2 shape from readRaw", () => {
    const { state, runtime } = makeConfig();
    const backend = new StateBackend(runtime);

    const writeRes = backend.write("/data.txt", "hello world");
    Object.assign(state.files, writeRes.filesUpdate!);

    const raw = backend.readRaw("/data.txt");
    expect(raw.error).toBeUndefined();
    expect(raw.data).toBeDefined();
    expect(typeof raw.data!.content).toBe("string");
    expect(raw.data!.content).toBe("hello world");
    expect((raw.data as any).mimeType).toBe("text/plain");
    expect(raw.data!.created_at).toBeDefined();
    expect(raw.data!.modified_at).toBeDefined();
  });

  it("should return ReadRawResult with error for missing file", () => {
    const { runtime } = makeConfig();
    const backend = new StateBackend(runtime);

    const raw = backend.readRaw("/nonexistent.txt");
    expect(raw.error).toBeDefined();
    expect(raw.data).toBeUndefined();
  });

  it("should return ReadRawResult for binary files with Uint8Array content", () => {
    const { state, runtime } = makeConfig();
    const backend = new StateBackend(runtime);

    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const uploadResult = backend.uploadFiles([["/image.png", pngBytes]]);
    Object.assign(state.files, (uploadResult as any).filesUpdate);

    const raw = backend.readRaw("/image.png");
    expect(raw.error).toBeUndefined();
    expect(raw.data).toBeDefined();
    expect(raw.data!.content).toBeInstanceOf(Uint8Array);
    expect(raw.data!.content).toEqual(pngBytes);
    expect((raw.data as any).mimeType).toBe("image/png");
  });

  it("should return ReadRawResult for v1 data with joined content", () => {
    const v1FileData: FileDataV1 = {
      content: ["line1", "line2", "line3"],
      created_at: "2024-01-01T00:00:00.000Z",
      modified_at: "2024-01-01T00:00:00.000Z",
    };
    const { runtime } = makeConfig({ "/legacy.txt": v1FileData });
    const backend = new StateBackend(runtime);

    const raw = backend.readRaw("/legacy.txt");
    expect(raw.error).toBeUndefined();
    expect(raw.data).toBeDefined();
    // v1 data should still be returned as-is (content as string[])
    expect(Array.isArray(raw.data!.content)).toBe(true);
  });

  it("should return empty content warning for empty files", () => {
    const { state, runtime } = makeConfig();
    const backend = new StateBackend(runtime);

    const writeRes = backend.write("/empty.txt", "");
    Object.assign(state.files, writeRes.filesUpdate!);

    const readRes = backend.read("/empty.txt");
    expect(readRes.content).toBe("");
  });

  describe("uploadFiles", () => {
    it("should upload files and return filesUpdate", () => {
      const { runtime } = makeConfig();
      const backend = new StateBackend(runtime);

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
      const { runtime } = makeConfig();
      const backend = new StateBackend(runtime);

      const binaryContent = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
      const files: Array<[string, Uint8Array]> = [
        ["/hello.txt", binaryContent],
      ];

      const result = backend.uploadFiles(files);
      expect(result[0].error).toBeNull();
      expect((result as any).filesUpdate["/hello.txt"].content).toBe("Hello");
    });

    it("should upload binary (image) files as Uint8Array", () => {
      const { state, runtime } = makeConfig();
      const backend = new StateBackend(runtime);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const result = backend.uploadFiles([["/image.png", pngBytes]]);
      expect(result[0].error).toBeNull();

      Object.assign(state.files, (result as any).filesUpdate);
      const stored = state.files["/image.png"];
      expect(stored.content).toBeInstanceOf(Uint8Array);
      expect(stored.content).toEqual(pngBytes);
    });
  });

  describe("downloadFiles", () => {
    it("should download existing files as Uint8Array", () => {
      const { state, runtime } = makeConfig();
      const backend = new StateBackend(runtime);

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
      const { runtime } = makeConfig();
      const backend = new StateBackend(runtime);

      const result = backend.downloadFiles(["/nonexistent.txt"]);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("/nonexistent.txt");
      expect(result[0].content).toBeNull();
      expect(result[0].error).toBe("file_not_found");
    });

    it("should handle multiple files with mixed results", () => {
      const { state, runtime } = makeConfig();
      const backend = new StateBackend(runtime);

      const writeRes = backend.write("/exists.txt", "I exist");
      Object.assign(state.files, writeRes.filesUpdate);

      const result = backend.downloadFiles(["/exists.txt", "/missing.txt"]);
      expect(result).toHaveLength(2);

      expect(result[0].error).toBeNull();
      expect(result[0].content).not.toBeNull();

      expect(result[1].error).toBe("file_not_found");
      expect(result[1].content).toBeNull();
    });

    it("should download binary files as raw bytes", () => {
      const { state, runtime } = makeConfig();
      const backend = new StateBackend(runtime);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);

      const uploadResult = backend.uploadFiles([["/image.png", pngBytes]]);
      Object.assign(state.files, (uploadResult as any).filesUpdate);

      const result = backend.downloadFiles(["/image.png"]);
      expect(result).toHaveLength(1);
      expect(result[0].error).toBeNull();
      expect(result[0].content).not.toBeNull();
      expect(new Uint8Array(result[0].content!)).toEqual(pngBytes);
    });
  });

  describe("binary file round-trip", () => {
    it("should upload and download binary files with identical bytes", () => {
      const { state, runtime } = makeConfig();
      const backend = new StateBackend(runtime);

      const originalBytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) originalBytes[i] = i;

      const uploadResult = backend.uploadFiles([["/data.png", originalBytes]]);
      expect(uploadResult[0].error).toBeNull();
      Object.assign(state.files, (uploadResult as any).filesUpdate);

      const downloadResult = backend.downloadFiles(["/data.png"]);
      expect(downloadResult[0].error).toBeNull();
      expect(new Uint8Array(downloadResult[0].content!)).toEqual(originalBytes);
    });

    it("should read binary files as Uint8Array content", () => {
      const { state, runtime } = makeConfig();
      const backend = new StateBackend(runtime);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);

      const uploadResult = backend.uploadFiles([["/photo.png", pngBytes]]);
      Object.assign(state.files, (uploadResult as any).filesUpdate);

      const readResult = backend.read("/photo.png");
      expect(readResult.error).toBeUndefined();
      expect(readResult.content).toBeInstanceOf(Uint8Array);
      expect(readResult.content).toEqual(pngBytes);
    });

    it("should skip binary files in grep", () => {
      const { state, runtime } = makeConfig();
      const backend = new StateBackend(runtime);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const uploadResult = backend.uploadFiles([["/image.png", pngBytes]]);
      Object.assign(state.files, (uploadResult as any).filesUpdate);

      const writeRes = backend.write("/notes.txt", "hello PNG");
      Object.assign(state.files, writeRes.filesUpdate);

      const grepRes = backend.grep("PNG", "/");
      expect(grepRes.matches).toHaveLength(1);
      expect(grepRes.matches![0].path).toBe("/notes.txt");
    });

    it("should ignore offset/limit for binary reads", () => {
      const { state, runtime } = makeConfig();
      const backend = new StateBackend(runtime);

      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const uploadResult = backend.uploadFiles([["/img.png", pngBytes]]);
      Object.assign(state.files, (uploadResult as any).filesUpdate);

      const full = backend.read("/img.png");
      const withOffsetLimit = backend.read("/img.png", 5, 2);
      expect(withOffsetLimit.content).toBe(full.content);
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
        config,
        state: { files: {}, messages: [] },
        runtime: {},
      },
      mockToolFn,
    );

    expect(result).toBeInstanceOf(Command);
    expect(result.update.files).toBeDefined();
    expect(result.update.files["/large_tool_results/test_123"]).toBeDefined();
    expect(result.update.files["/large_tool_results/test_123"].content).toBe(
      largeContent,
    );

    expect(result.update.messages).toHaveLength(1);
    expect(result.update.messages[0].content).toContain(
      "Tool result too large",
    );
    expect(result.update.messages[0].content).toContain(
      "/large_tool_results/test_123",
    );
  });

  describe("fileFormat: v1", () => {
    it("should write v1 format (content as line array)", () => {
      const { state, runtime } = makeConfig();
      const backend = new StateBackend(runtime, { fileFormat: "v1" });

      const writeRes = backend.write("/notes.txt", "line1\nline2");
      expect(writeRes.error).toBeUndefined();
      Object.assign(state.files, writeRes.filesUpdate!);

      const fileData = state.files["/notes.txt"];
      expect(Array.isArray(fileData.content)).toBe(true);
      expect(fileData.content).toEqual(["line1", "line2"]);
    });

    it("should read v1 data correctly", () => {
      const { state, runtime } = makeConfig();
      const backend = new StateBackend(runtime, { fileFormat: "v1" });

      const writeRes = backend.write("/notes.txt", "hello world");
      Object.assign(state.files, writeRes.filesUpdate!);

      const readRes = backend.read("/notes.txt");
      expect(readRes.error).toBeUndefined();
      expect(readRes.content).toContain("hello world");
    });

    it("should edit v1 data and produce v1 output", () => {
      const { state, runtime } = makeConfig();
      const backend = new StateBackend(runtime, { fileFormat: "v1" });

      const writeRes = backend.write("/notes.txt", "hello world");
      Object.assign(state.files, writeRes.filesUpdate!);

      const editRes = backend.edit("/notes.txt", "hello", "hi");
      expect(editRes.error).toBeUndefined();
      Object.assign(state.files, editRes.filesUpdate!);

      const fileData = state.files["/notes.txt"];
      expect(Array.isArray(fileData.content)).toBe(true);
      expect(fileData.content).toEqual(["hi world"]);
    });

    it("should upload files as v1 format", () => {
      const { runtime } = makeConfig();
      const backend = new StateBackend(runtime, { fileFormat: "v1" });

      const files: Array<[string, Uint8Array]> = [
        ["/hello.txt", new TextEncoder().encode("Hello")],
      ];

      const result = backend.uploadFiles(files);
      expect(result[0].error).toBeNull();
      expect((result as any).filesUpdate["/hello.txt"].content).toEqual([
        "Hello",
      ]);
    });
  });

  describe("backwards compatibility: v2 backend reading v1 data", () => {
    it("should read pre-existing v1 data from state", () => {
      const v1FileData: FileDataV1 = {
        content: ["line1", "line2", "line3"],
        created_at: "2024-01-01T00:00:00.000Z",
        modified_at: "2024-01-01T00:00:00.000Z",
      };
      const { runtime } = makeConfig({ "/legacy.txt": v1FileData });
      const backend = new StateBackend(runtime); // default v2

      const readRes = backend.read("/legacy.txt");
      expect(readRes.error).toBeUndefined();
      expect(readRes.content).toBe("line1\nline2\nline3");
    });

    it("should read v1 data with offset/limit", () => {
      const v1FileData: FileDataV1 = {
        content: ["a", "b", "c", "d", "e"],
        created_at: "2024-01-01T00:00:00.000Z",
        modified_at: "2024-01-01T00:00:00.000Z",
      };
      const { runtime } = makeConfig({ "/legacy.txt": v1FileData });
      const backend = new StateBackend(runtime);

      const readRes = backend.read("/legacy.txt", 1, 2);
      expect(readRes.content).toBe("b\nc");
    });

    it("should edit v1 data and produce v2 output", () => {
      const v1FileData: FileDataV1 = {
        content: ["hello world"],
        created_at: "2024-01-01T00:00:00.000Z",
        modified_at: "2024-01-01T00:00:00.000Z",
      };
      const { state, runtime } = makeConfig({
        "/legacy.txt": v1FileData,
      });
      const backend = new StateBackend(runtime); // default v2

      const editRes = backend.edit("/legacy.txt", "hello", "hi");
      expect(editRes.error).toBeUndefined();
      Object.assign(state.files, editRes.filesUpdate!);

      // Edit of v1 data preserves v1 format (updateFileData detects format)
      const fileData = state.files["/legacy.txt"];
      expect(Array.isArray(fileData.content)).toBe(true);
    });

    it("should grep across mixed v1 and v2 files", () => {
      const v1FileData: FileDataV1 = {
        content: ["import os", "print('v1')"],
        created_at: "2024-01-01T00:00:00.000Z",
        modified_at: "2024-01-01T00:00:00.000Z",
      };
      const { state, runtime } = makeConfig({
        "/legacy.py": v1FileData,
      });
      const backend = new StateBackend(runtime); // default v2

      // Write a v2 file
      const writeRes = backend.write("/modern.py", "import sys\nprint('v2')");
      Object.assign(state.files, writeRes.filesUpdate!);

      const grepRes = backend.grep("import", "/");
      expect(grepRes.matches).toHaveLength(2);
      const paths = grepRes.matches!.map((m) => m.path).sort();
      expect(paths).toEqual(["/legacy.py", "/modern.py"]);
    });

    it("should list mixed v1 and v2 files with correct sizes", () => {
      const v1FileData: FileDataV1 = {
        content: ["hello"],
        created_at: "2024-01-01T00:00:00.000Z",
        modified_at: "2024-01-01T00:00:00.000Z",
      };
      const { state, runtime } = makeConfig({
        "/legacy.txt": v1FileData,
      });
      const backend = new StateBackend(runtime);

      const writeRes = backend.write("/modern.txt", "world");
      Object.assign(state.files, writeRes.filesUpdate!);

      const listing = backend.ls("/");
      expect(listing.error).toBeUndefined();
      expect(listing.files).toHaveLength(2);
      for (const info of listing.files!) {
        expect(info.size).toBe(5);
      }
    });
  });

  describe("zero-arg constructor", () => {
    /**
     * Helper to apply a __pregel_send update to the mocked state.
     * Extracts the files update from the sendSpy call and merges it.
     */
    function applySendUpdate(
      state: { files: Record<string, FileData> },
      sendSpy: ReturnType<typeof vi.fn>,
      callIndex = 0,
    ) {
      const sent = sendSpy.mock.calls[callIndex][0];
      Object.assign(state.files, sent[0][1]);
    }

    it("write sends update via __pregel_send and returns no filesUpdate", () => {
      const { sendSpy } = makeConfig();
      const backend = new StateBackend();

      const result = backend.write("/notes.txt", "hello world");
      expect(result.error).toBeUndefined();
      expect(result.path).toBe("/notes.txt");
      expect(result.filesUpdate).toBeUndefined();

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const sent = sendSpy.mock.calls[0][0];
      expect(sent).toHaveLength(1);
      expect(sent[0][0]).toBe("files");
      expect(sent[0][1]["/notes.txt"]).toBeDefined();
    });

    it("edit sends update via __pregel_send and returns no filesUpdate", () => {
      const { state, sendSpy } = makeConfig();
      const backend = new StateBackend();

      backend.write("/notes.txt", "hello world");
      applySendUpdate(state, sendSpy);
      sendSpy.mockClear();

      const result = backend.edit("/notes.txt", "hello", "hi");
      expect(result.error).toBeUndefined();
      expect(result.path).toBe("/notes.txt");
      expect(result.filesUpdate).toBeUndefined();
      expect(result.occurrences).toBe(1);

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it("uploadFiles sends updates via __pregel_send and returns no filesUpdate", () => {
      const { sendSpy } = makeConfig();
      const backend = new StateBackend();

      const files: Array<[string, Uint8Array]> = [
        ["/file1.txt", new TextEncoder().encode("content1")],
        ["/file2.txt", new TextEncoder().encode("content2")],
      ];

      const result = backend.uploadFiles(files);
      expect(result).toHaveLength(2);
      expect(result[0].error).toBeNull();
      expect(result[1].error).toBeNull();
      expect((result as any).filesUpdate).toBeUndefined();

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it("full CRUD cycle: write, read, edit, read, ls, grep, glob", () => {
      const { state, sendSpy } = makeConfig();
      const backend = new StateBackend();

      // Write
      backend.write("/notes.txt", "hello world");
      applySendUpdate(state, sendSpy);
      sendSpy.mockClear();

      // Read
      const readRes = backend.read("/notes.txt");
      expect(readRes.content).toContain("hello world");

      // Edit
      backend.edit("/notes.txt", "hello", "hi");
      applySendUpdate(state, sendSpy);
      sendSpy.mockClear();

      // Read after edit
      const readRes2 = backend.read("/notes.txt");
      expect(readRes2.content).toContain("hi world");

      // Ls
      const listing = backend.ls("/");
      expect(listing.files!.some((fi) => fi.path === "/notes.txt")).toBe(true);

      // Grep
      const grepRes = backend.grep("hi", "/");
      expect(grepRes.matches!.some((m) => m.path === "/notes.txt")).toBe(true);

      // Glob
      const globRes = backend.glob("*.txt", "/");
      expect(globRes.files!.some((i) => i.path === "/notes.txt")).toBe(true);
    });

    it("accepts options without runtime", () => {
      makeConfig();
      const backend = new StateBackend({ fileFormat: "v1" });

      const result = backend.write("/test.txt", "line1\nline2");
      expect(result.error).toBeUndefined();
      expect(result.filesUpdate).toBeUndefined();
    });
  });
});
