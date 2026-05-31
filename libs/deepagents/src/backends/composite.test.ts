import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import { getCurrentTaskInput } from "@langchain/langgraph";

import { CompositeBackend } from "./composite.js";
import { StateBackend } from "./state.js";
import { StoreBackend } from "./store.js";
import { FilesystemBackend } from "./filesystem.js";
import type {
  BackendRuntime,
  ExecuteResponse,
  FileDownloadResponse,
  FileUploadResponse,
  GlobResult,
  LsResult,
  ReadRawResult,
  SandboxBackendProtocolV2,
  GrepResult,
  ReadResult,
  WriteResult,
  EditResult,
} from "./protocol.js";
import { isSandboxBackend } from "./protocol.js";

/**
 * Mock sandbox backend for testing execute delegation
 */
class MockSandboxBackend implements SandboxBackendProtocolV2 {
  readonly id = "mock-sandbox";
  public lastCommand: string | null = null;

  async execute(command: string): Promise<ExecuteResponse> {
    this.lastCommand = command;
    return { output: `Executed: ${command}`, exitCode: 0, truncated: false };
  }

  ls(): LsResult {
    return { files: [] };
  }
  read(): ReadResult {
    return { content: "" };
  }
  readRaw(): ReadRawResult {
    return {
      data: {
        content: "",
        mimeType: "text/plain",
        created_at: "",
        modified_at: "",
      },
    };
  }
  grep(): GrepResult {
    return { matches: [] };
  }
  glob(): GlobResult {
    return { files: [] };
  }
  write(): WriteResult {
    return { path: "" };
  }
  edit(): EditResult {
    return { path: "" };
  }
  uploadFiles(files: Array<[string, Uint8Array]>): FileUploadResponse[] {
    return files.map(([path]) => ({ path, error: null }));
  }
  downloadFiles(paths: string[]): FileDownloadResponse[] {
    return paths.map((path) => ({
      path,
      content: new Uint8Array(),
      error: null,
    }));
  }
}

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getCurrentTaskInput: vi.fn(),
  };
});

/**
 * Helper to create a unique temporary directory for each test
 */
function createTempDir(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "deepagents-composite-"));
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

/**
 * Helper to write a file with automatic parent directory creation
 */
async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Helper to create a mock config with state and store
 */
function makeConfig() {
  const state = {
    messages: [],
    files: {},
  };
  const store = new InMemoryStore();

  vi.mocked(getCurrentTaskInput).mockReturnValue(state);

  const runtime = {
    state,
    store,
  };

  const config = {
    store,
    configurable: {},
  };

  return { state, store, runtime, config };
}

describe("CompositeBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should route operations between StateBackend and StoreBackend", async () => {
    const { state, runtime } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(runtime), {
      "/memories/": new StoreBackend(runtime),
    });

    const stateRes = await composite.write("/file.txt", "alpha");
    expect(stateRes.filesUpdate).toBeDefined();
    expect(stateRes.path).toBe("/file.txt");
    Object.assign(state.files, stateRes.filesUpdate!);

    const storeRes = await composite.write("/memories/readme.md", "beta");
    expect(storeRes.error).toBeUndefined();
    expect(storeRes.filesUpdate).toBeNull();

    const lsResult = await composite.ls("/");
    expect(lsResult.error).toBeUndefined();
    const paths = lsResult.files!.map((i) => i.path);
    expect(paths).toContain("/file.txt");
    expect(paths).toContain("/memories/");

    const result1 = await composite.grep("alpha", "/");
    expect(result1.error).toBeUndefined();
    expect(result1.matches!.some((m) => m.path === "/file.txt")).toBe(true);

    const result2 = await composite.grep("beta", "/");
    expect(result2.error).toBeUndefined();
    expect(result2.matches!.some((m) => m.path === "/memories/readme.md")).toBe(
      true,
    );

    const globResult = await composite.glob("**/*.md", "/");
    expect(globResult.error).toBeUndefined();
    expect(
      globResult.files!.some((i) => i.path === "/memories/readme.md"),
    ).toBe(true);
  });

  it("should handle multiple routes", async () => {
    const { state, runtime } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(runtime), {
      "/memories/": new StoreBackend(runtime),
      "/archive/": new StoreBackend(runtime),
      "/cache/": new StoreBackend(runtime),
    });

    const resState = await composite.write("/temp.txt", "ephemeral data");
    expect(resState.filesUpdate).toBeDefined();
    expect(resState.path).toBe("/temp.txt");
    Object.assign(state.files, resState.filesUpdate!);

    const resMem = await composite.write(
      "/memories/important.md",
      "long-term memory",
    );
    expect(resMem.filesUpdate).toBeNull();
    expect(resMem.path).toBe("/important.md");

    const resArchive = await composite.write(
      "/archive/old.log",
      "archived log",
    );
    expect(resArchive.filesUpdate).toBeNull();
    expect(resArchive.path).toBe("/old.log");

    const resCache = await composite.write(
      "/cache/session.json",
      "cached session",
    );
    expect(resCache.filesUpdate).toBeNull();
    expect(resCache.path).toBe("/session.json");

    const lsResult = await composite.ls("/");
    expect(lsResult.error).toBeUndefined();
    const paths = lsResult.files!.map((i) => i.path);
    expect(paths).toContain("/temp.txt");
    expect(paths).toContain("/memories/");
    expect(paths).toContain("/archive/");
    expect(paths).toContain("/cache/");

    const memLsResult = await composite.ls("/memories/");
    expect(memLsResult.error).toBeUndefined();
    const memPaths = memLsResult.files!.map((i) => i.path);
    expect(memPaths).toContain("/memories/important.md");
    expect(memPaths).not.toContain("/temp.txt");
    expect(memPaths).not.toContain("/archive/old.log");

    // grep across all backends with literal text search
    // Note: All written content contains 'e' character
    const grepResult = await composite.grep("e", "/");
    expect(grepResult.error).toBeUndefined();
    const pathsWithContent = grepResult.matches!.map((m) => m.path);
    expect(pathsWithContent).toContain("/temp.txt");
    expect(pathsWithContent).toContain("/memories/important.md");
    expect(pathsWithContent).toContain("/archive/old.log");
    expect(pathsWithContent).toContain("/cache/session.json");

    const globResult = await composite.glob("**/*.md", "/");
    expect(globResult.error).toBeUndefined();
    expect(
      globResult.files!.some((i) => i.path === "/memories/important.md"),
    ).toBe(true);

    const editRes = await composite.edit(
      "/memories/important.md",
      "long-term",
      "persistent",
      false,
    );
    expect(editRes.error).toBeUndefined();
    expect(editRes.occurrences).toBe(1);

    const updatedContent = await composite.read("/memories/important.md");
    expect(updatedContent.content).toContain("persistent memory");
  });

  it("should handle nested directories correctly", async () => {
    const { state, runtime } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(runtime), {
      "/memories/": new StoreBackend(runtime),
      "/archive/": new StoreBackend(runtime),
    });

    const stateFiles: Record<string, string> = {
      "/temp.txt": "temp",
      "/work/file1.txt": "work file 1",
      "/work/projects/proj1.txt": "project 1",
    };

    for (const [path, content] of Object.entries(stateFiles)) {
      const res = await composite.write(path, content);
      if (res.filesUpdate) {
        Object.assign(state.files, res.filesUpdate);
      }
    }

    const memoryFiles: Record<string, string> = {
      "/memories/important.txt": "important",
      "/memories/diary/entry1.txt": "diary entry",
    };

    for (const [path, content] of Object.entries(memoryFiles)) {
      await composite.write(path, content);
    }

    const archiveFiles: Record<string, string> = {
      "/archive/old.txt": "old",
      "/archive/2023/log.txt": "2023 log",
    };

    for (const [path, content] of Object.entries(archiveFiles)) {
      await composite.write(path, content);
    }

    const rootListing = await composite.ls("/");
    expect(rootListing.error).toBeUndefined();
    const rootPaths = rootListing.files!.map((fi) => fi.path);
    expect(rootPaths).toContain("/temp.txt");
    expect(rootPaths).toContain("/work/");
    expect(rootPaths).toContain("/memories/");
    expect(rootPaths).toContain("/archive/");
    expect(rootPaths).not.toContain("/work/file1.txt");
    expect(rootPaths).not.toContain("/memories/important.txt");

    const workListing = await composite.ls("/work/");
    expect(workListing.error).toBeUndefined();
    const workPaths = workListing.files!.map((fi) => fi.path);
    expect(workPaths).toContain("/work/file1.txt");
    expect(workPaths).toContain("/work/projects/");
    expect(workPaths).not.toContain("/work/projects/proj1.txt");

    const memListing = await composite.ls("/memories/");
    expect(memListing.error).toBeUndefined();
    const memPaths = memListing.files!.map((fi) => fi.path);
    expect(memPaths).toContain("/memories/important.txt");
    expect(memPaths).toContain("/memories/diary/");
    expect(memPaths).not.toContain("/memories/diary/entry1.txt");

    const archListing = await composite.ls("/archive/");
    expect(archListing.error).toBeUndefined();
    const archPaths = archListing.files!.map((fi) => fi.path);
    expect(archPaths).toContain("/archive/old.txt");
    expect(archPaths).toContain("/archive/2023/");
    expect(archPaths).not.toContain("/archive/2023/log.txt");
  });

  it("should return ReadRawResult from readRaw across backends", async () => {
    const { state, runtime } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(runtime), {
      "/store/": new StoreBackend(runtime),
    });

    // Write to both backends
    const stateRes = await composite.write("/file.txt", "state content");
    Object.assign(state.files, stateRes.filesUpdate!);

    await composite.write("/store/file.txt", "store content");

    // readRaw from state backend
    const raw1 = await composite.readRaw("/file.txt");
    expect(raw1.error).toBeUndefined();
    expect(raw1.data).toBeDefined();
    expect(typeof raw1.data!.content).toBe("string");
    expect(raw1.data!.content).toBe("state content");
    expect((raw1.data as any).mimeType).toBe("text/plain");

    // readRaw from store backend
    const raw2 = await composite.readRaw("/store/file.txt");
    expect(raw2.error).toBeUndefined();
    expect(raw2.data).toBeDefined();
    expect(typeof raw2.data!.content).toBe("string");
    expect(raw2.data!.content).toBe("store content");

    // readRaw error for missing file
    const raw3 = await composite.readRaw("/missing.txt");
    expect(raw3.error).toBeDefined();
    expect(raw3.data).toBeUndefined();
  });

  it("should handle trailing slashes in ls", async () => {
    const { state, runtime } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(runtime), {
      "/store/": new StoreBackend(runtime),
    });

    const res = await composite.write("/file.txt", "content");
    Object.assign(state.files, res.filesUpdate!);

    await composite.write("/store/item.txt", "store content");

    const listing = await composite.ls("/");
    expect(listing.error).toBeUndefined();
    const paths = listing.files!.map((fi) => fi.path);
    expect(paths).toEqual(paths.slice().sort());

    const emptyListing1 = await composite.ls("/store/nonexistent/");
    expect(emptyListing1.error).toBeUndefined();
    expect(emptyListing1.files).toEqual([]);

    const emptyListing2 = await composite.ls("/nonexistent/");
    expect(emptyListing2.error).toBeUndefined();
    expect(emptyListing2.files).toEqual([]);

    const listing1 = await composite.ls("/store/");
    expect(listing1.error).toBeUndefined();
    const listing2 = await composite.ls("/store");
    expect(listing2.error).toBeUndefined();
    expect(listing1.files!.map((fi) => fi.path)).toEqual(
      listing2.files!.map((fi) => fi.path),
    );
  });

  it("should handle large tool result interception with default route", async () => {
    const { config } = makeConfig();
    const { createFilesystemMiddleware } = await import("../middleware/fs.js");
    const { ToolMessage } = await import("@langchain/core/messages");
    const { Command } = await import("@langchain/langgraph");

    const middleware = createFilesystemMiddleware({
      backend: (runtime: BackendRuntime) =>
        new CompositeBackend(new StateBackend(runtime), {
          "/memories/": new StoreBackend(runtime),
        }),
      toolTokenLimitBeforeEvict: 1000,
    });

    const largeContent = "z".repeat(5000);
    const toolMessage = new ToolMessage({
      content: largeContent,
      tool_call_id: "test_789",
      name: "test_tool",
    });

    const mockToolFn = async () => toolMessage;
    const mockToolCall = { name: "test_tool", args: {}, id: "test_789" };

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
    expect(result.update.files["/large_tool_results/test_789"]).toBeDefined();
    // v2 format: content is a string, not an array
    expect(result.update.files["/large_tool_results/test_789"].content).toEqual(
      largeContent,
    );

    expect(result.update.messages).toHaveLength(1);
    expect(result.update.messages[0].content).toContain(
      "Tool result too large",
    );
  });

  it("should handle large tool result interception routed to store", async () => {
    const { store } = makeConfig();
    const { createFilesystemMiddleware } = await import("../middleware/fs.js");
    const { ToolMessage } = await import("@langchain/core/messages");

    const middleware = createFilesystemMiddleware({
      backend: (runtime: BackendRuntime) =>
        new CompositeBackend(new StateBackend(runtime), {
          "/large_tool_results/": new StoreBackend(runtime),
        }),
      toolTokenLimitBeforeEvict: 1000,
    });

    const largeContent = "w".repeat(5000);
    const toolMessage = new ToolMessage({
      content: largeContent,
      tool_call_id: "test_routed_123",
      name: "test_tool",
    });

    const mockToolFn = async () => toolMessage;
    const mockToolCall = { name: "test_tool", args: {}, id: "test_routed_123" };

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
    expect(result.content).toContain("/large_tool_results/test_routed_123");

    const storedContent = await store.get(["filesystem"], "/test_routed_123");
    expect(storedContent).toBeDefined();
    // v2 format: content is a string, not an array
    expect((storedContent!.value as any).content).toEqual(largeContent);
  });

  it("should work with FilesystemBackend as default and StoreBackend route", async () => {
    const tmpDir = createTempDir();
    try {
      const { runtime } = makeConfig();

      const fsBackend = new FilesystemBackend({
        rootDir: tmpDir,
        virtualMode: true,
      });
      const storeBackend = new StoreBackend(runtime);
      const composite = new CompositeBackend(fsBackend, {
        "/memories/": storeBackend,
      });

      const r1 = await composite.write("/hello.txt", "hello");
      expect(r1.error).toBeUndefined();
      expect(r1.filesUpdate).toBeNull();

      const r2 = await composite.write("/memories/notes.md", "note");
      expect(r2.error).toBeUndefined();
      expect(r2.filesUpdate).toBeNull(); // Store also returns null

      const infosRoot = await composite.ls("/");
      expect(infosRoot.error).toBeUndefined();
      expect(infosRoot.files!.some((i) => i.path === "/hello.txt")).toBe(true);
      expect(infosRoot.files!.some((i) => i.path === "/memories/")).toBe(true);

      const infosMem = await composite.ls("/memories/");
      expect(infosMem.error).toBeUndefined();
      expect(infosMem.files!.some((i) => i.path === "/memories/notes.md")).toBe(
        true,
      );

      const gm1 = await composite.grep("hello", "/");
      expect(gm1.error).toBeUndefined();
      expect(gm1.matches!.some((m) => m.path === "/hello.txt")).toBe(true);

      const gm2 = await composite.grep("note", "/");
      expect(gm2.error).toBeUndefined();
      expect(gm2.matches!.some((m) => m.path === "/memories/notes.md")).toBe(
        true,
      );

      const gl = await composite.glob("*.md", "/");
      expect(gl.error).toBeUndefined();
      expect(gl.files!.some((i) => i.path === "/memories/notes.md")).toBe(true);
    } finally {
      await removeDir(tmpDir);
    }
  });

  it("should work with StoreBackend as default and another StoreBackend route", async () => {
    const { runtime } = makeConfig();

    const defaultStore = new StoreBackend(runtime);
    const memoriesStore = new StoreBackend(runtime);

    const composite = new CompositeBackend(defaultStore, {
      "/memories/": memoriesStore,
    });

    const res1 = await composite.write("/notes.txt", "default store content");
    expect(res1.error).toBeUndefined();
    expect(res1.path).toBe("/notes.txt");

    const res2 = await composite.write(
      "/memories/important.txt",
      "routed store content",
    );
    expect(res2.error).toBeUndefined();
    expect(res2.path).toBe("/important.txt");

    const content1 = await composite.read("/notes.txt");
    expect(content1.content).toContain("default store content");

    const content2 = await composite.read("/memories/important.txt");
    expect(content2.content).toContain("routed store content");

    const infos = await composite.ls("/");
    expect(infos.error).toBeUndefined();
    const paths = infos.files!.map((i) => i.path);
    expect(paths).toContain("/notes.txt");
    expect(paths).toContain("/memories/");

    const grepResult1 = await composite.grep("default", "/");
    expect(grepResult1.error).toBeUndefined();
    expect(grepResult1.matches!.some((m) => m.path === "/notes.txt")).toBe(
      true,
    );

    const grepResult2 = await composite.grep("routed", "/");
    expect(grepResult2.error).toBeUndefined();
    expect(
      grepResult2.matches!.some((m) => m.path === "/memories/important.txt"),
    ).toBe(true);
  });

  it("should handle nested directories with FilesystemBackend and StoreBackend", async () => {
    const tmpDir = createTempDir();
    try {
      const { runtime } = makeConfig();

      const files: Record<string, string> = {
        [path.join(tmpDir, "local.txt")]: "local file",
        [path.join(tmpDir, "src", "main.py")]: "code",
        [path.join(tmpDir, "src", "utils", "helper.py")]: "utils",
      };

      for (const [filePath, content] of Object.entries(files)) {
        await writeFile(filePath, content);
      }

      const fsBackend = new FilesystemBackend({
        rootDir: tmpDir,
        virtualMode: true,
      });
      const storeBackend = new StoreBackend(runtime);
      const composite = new CompositeBackend(fsBackend, {
        "/memories/": storeBackend,
      });

      await composite.write("/memories/note1.txt", "note 1");
      await composite.write("/memories/deep/note2.txt", "note 2");
      await composite.write("/memories/deep/nested/note3.txt", "note 3");

      const rootListing = await composite.ls("/");
      expect(rootListing.error).toBeUndefined();
      const rootPaths = rootListing.files!.map((fi) => fi.path);
      expect(rootPaths).toContain("/local.txt");
      expect(rootPaths).toContain("/src/");
      expect(rootPaths).toContain("/memories/");
      expect(rootPaths).not.toContain("/src/main.py");
      expect(rootPaths).not.toContain("/memories/note1.txt");

      const srcListing = await composite.ls("/src/");
      expect(srcListing.error).toBeUndefined();
      const srcPaths = srcListing.files!.map((fi) => fi.path);
      expect(srcPaths).toContain("/src/main.py");
      expect(srcPaths).toContain("/src/utils/");
      expect(srcPaths).not.toContain("/src/utils/helper.py");

      const memListing = await composite.ls("/memories/");
      expect(memListing.error).toBeUndefined();
      const memPaths = memListing.files!.map((fi) => fi.path);
      expect(memPaths).toContain("/memories/note1.txt");
      expect(memPaths).toContain("/memories/deep/");
      expect(memPaths).not.toContain("/memories/deep/note2.txt");

      const deepListing = await composite.ls("/memories/deep/");
      expect(deepListing.error).toBeUndefined();
      const deepPaths = deepListing.files!.map((fi) => fi.path);
      expect(deepPaths).toContain("/memories/deep/note2.txt");
      expect(deepPaths).toContain("/memories/deep/nested/");
      expect(deepPaths).not.toContain("/memories/deep/nested/note3.txt");
    } finally {
      await removeDir(tmpDir);
    }
  });

  describe("execute", () => {
    it("should delegate execute to default sandbox backend", async () => {
      const mockSandbox = new MockSandboxBackend();
      const { runtime } = makeConfig();

      const composite = new CompositeBackend(mockSandbox, {
        "/store/": new StoreBackend(runtime),
      });

      const result = await composite.execute("echo hello");
      expect(result.output).toBe("Executed: echo hello");
      expect(result.exitCode).toBe(0);
      expect(mockSandbox.lastCommand).toBe("echo hello");
    });

    it("should throw error when default backend is not sandbox", () => {
      const { runtime } = makeConfig();

      const composite = new CompositeBackend(new StateBackend(runtime), {
        "/store/": new StoreBackend(runtime),
      });

      expect(() => composite.execute("echo hello")).toThrow(
        "doesn't support command execution",
      );
    });

    it("should pass isSandboxBackend check when default backend supports execution", () => {
      const mockSandbox = new MockSandboxBackend();
      const { runtime } = makeConfig();

      const composite = new CompositeBackend(mockSandbox, {
        "/store/": new StoreBackend(runtime),
      });

      expect(isSandboxBackend(composite)).toBe(true);
    });

    it("should delegate id to default sandbox backend", () => {
      const mockSandbox = new MockSandboxBackend();
      const { runtime } = makeConfig();

      const composite = new CompositeBackend(mockSandbox, {
        "/store/": new StoreBackend(runtime),
      });

      expect(composite.id).toBe("mock-sandbox");
    });

    it("should return empty string id when default backend is not sandbox", () => {
      const { runtime } = makeConfig();

      const composite = new CompositeBackend(new StateBackend(runtime), {
        "/store/": new StoreBackend(runtime),
      });

      expect(composite.id).toBe("");
    });
  });

  describe("uploadFiles", () => {
    it("should route uploads to correct backend based on path", async () => {
      const { runtime } = makeConfig();

      const composite = new CompositeBackend(new StateBackend(runtime), {
        "/store/": new StoreBackend(runtime),
      });

      const files: Array<[string, Uint8Array]> = [
        ["/local.txt", new TextEncoder().encode("local content")],
        ["/store/remote.txt", new TextEncoder().encode("remote content")],
      ];

      const result = await composite.uploadFiles(files);
      expect(result).toHaveLength(2);
      expect(result[0].path).toBe("/local.txt");
      expect(result[0].error).toBeNull();
      expect(result[1].path).toBe("/store/remote.txt");
      expect(result[1].error).toBeNull();
    });

    it("should batch uploads by backend", async () => {
      const { runtime } = makeConfig();

      const composite = new CompositeBackend(new StateBackend(runtime), {
        "/store/": new StoreBackend(runtime),
      });

      const files: Array<[string, Uint8Array]> = [
        ["/a.txt", new TextEncoder().encode("a")],
        ["/store/b.txt", new TextEncoder().encode("b")],
        ["/c.txt", new TextEncoder().encode("c")],
        ["/store/d.txt", new TextEncoder().encode("d")],
      ];

      const result = await composite.uploadFiles(files);
      expect(result).toHaveLength(4);

      // Check all succeeded
      for (const r of result) {
        expect(r.error).toBeNull();
      }

      // Check original paths preserved
      expect(result[0].path).toBe("/a.txt");
      expect(result[1].path).toBe("/store/b.txt");
      expect(result[2].path).toBe("/c.txt");
      expect(result[3].path).toBe("/store/d.txt");
    });
  });

  describe("downloadFiles", () => {
    it("should route downloads to correct backend based on path", async () => {
      const { state, runtime } = makeConfig();

      const composite = new CompositeBackend(new StateBackend(runtime), {
        "/store/": new StoreBackend(runtime),
      });

      // Write to both backends
      const writeRes = await composite.write("/local.txt", "local content");
      if (writeRes.filesUpdate) {
        Object.assign(state.files, writeRes.filesUpdate);
      }
      await composite.write("/store/remote.txt", "remote content");

      const result = await composite.downloadFiles([
        "/local.txt",
        "/store/remote.txt",
      ]);
      expect(result).toHaveLength(2);

      expect(result[0].path).toBe("/local.txt");
      expect(result[0].error).toBeNull();
      expect(new TextDecoder().decode(result[0].content!)).toBe(
        "local content",
      );

      expect(result[1].path).toBe("/store/remote.txt");
      expect(result[1].error).toBeNull();
      expect(new TextDecoder().decode(result[1].content!)).toBe(
        "remote content",
      );
    });

    it("should handle mixed results across backends", async () => {
      const { state, runtime } = makeConfig();

      const composite = new CompositeBackend(new StateBackend(runtime), {
        "/store/": new StoreBackend(runtime),
      });

      // Only write to state backend
      const writeRes = await composite.write("/exists.txt", "I exist");
      if (writeRes.filesUpdate) {
        Object.assign(state.files, writeRes.filesUpdate);
      }

      const result = await composite.downloadFiles([
        "/exists.txt",
        "/missing.txt",
        "/store/missing.txt",
      ]);
      expect(result).toHaveLength(3);

      expect(result[0].error).toBeNull();
      expect(result[1].error).toBe("file_not_found");
      expect(result[2].error).toBe("file_not_found");
    });
  });
});
