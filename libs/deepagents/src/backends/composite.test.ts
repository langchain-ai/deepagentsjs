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
  ExecuteResponse,
  FileDownloadResponse,
  FileUploadResponse,
  SandboxBackendProtocol,
  GrepMatch,
} from "./protocol.js";

/**
 * Mock sandbox backend for testing execute delegation
 */
class MockSandboxBackend implements SandboxBackendProtocol {
  readonly id = "mock-sandbox";
  public lastCommand: string | null = null;

  async execute(command: string): Promise<ExecuteResponse> {
    this.lastCommand = command;
    return { output: `Executed: ${command}`, exitCode: 0, truncated: false };
  }

  lsInfo() {
    return [];
  }
  read() {
    return "";
  }
  readRaw() {
    return { content: [], created_at: "", modified_at: "" };
  }
  grepRaw() {
    return [];
  }
  globInfo() {
    return [];
  }
  write() {
    return { path: "" };
  }
  edit() {
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

  const stateAndStore = {
    state,
    store,
  };

  const config = {
    store,
    configurable: {},
  };

  return { state, store, stateAndStore, config };
}

describe("CompositeBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should route operations between StateBackend and StoreBackend", async () => {
    const { state, stateAndStore } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(stateAndStore), {
      "/memories/": new StoreBackend(stateAndStore),
    });

    const stateRes = await composite.write("/file.txt", "alpha");
    expect(stateRes.filesUpdate).toBeDefined();
    expect(stateRes.path).toBe("/file.txt");
    Object.assign(state.files, stateRes.filesUpdate!);

    const storeRes = await composite.write("/memories/readme.md", "beta");
    expect(storeRes.error).toBeUndefined();
    expect(storeRes.filesUpdate).toBeNull();

    const infos = await composite.lsInfo("/");
    const paths = infos.map((i) => i.path);
    expect(paths).toContain("/file.txt");
    expect(paths).toContain("/memories/");

    const matches1 = await composite.grepRaw("alpha", "/");
    expect(Array.isArray(matches1)).toBe(true);
    if (Array.isArray(matches1)) {
      expect(matches1.some((m) => m.path === "/file.txt")).toBe(true);
    }

    const matches2 = await composite.grepRaw("beta", "/");
    expect(Array.isArray(matches2)).toBe(true);
    if (Array.isArray(matches2)) {
      expect(matches2.some((m) => m.path === "/memories/readme.md")).toBe(true);
    }

    const glob = await composite.globInfo("**/*.md", "/");
    expect(glob.some((i) => i.path === "/memories/readme.md")).toBe(true);
  });

  it("should handle multiple routes", async () => {
    const { state, stateAndStore } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(stateAndStore), {
      "/memories/": new StoreBackend(stateAndStore),
      "/archive/": new StoreBackend(stateAndStore),
      "/cache/": new StoreBackend(stateAndStore),
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

    const infos = await composite.lsInfo("/");
    const paths = infos.map((i) => i.path);
    expect(paths).toContain("/temp.txt");
    expect(paths).toContain("/memories/");
    expect(paths).toContain("/archive/");
    expect(paths).toContain("/cache/");

    const memInfos = await composite.lsInfo("/memories/");
    const memPaths = memInfos.map((i) => i.path);
    expect(memPaths).toContain("/memories/important.md");
    expect(memPaths).not.toContain("/temp.txt");
    expect(memPaths).not.toContain("/archive/old.log");

    // grep across all backends with literal text search
    // Note: All written content contains 'e' character
    const allMatches = (await composite.grepRaw("e", "/")) as GrepMatch[];
    expect(Array.isArray(allMatches)).toBe(true);
    const pathsWithContent = allMatches.map((m) => m.path);
    expect(pathsWithContent).toContain("/temp.txt");
    expect(pathsWithContent).toContain("/memories/important.md");
    expect(pathsWithContent).toContain("/archive/old.log");
    expect(pathsWithContent).toContain("/cache/session.json");

    const globResults = await composite.globInfo("**/*.md", "/");
    expect(globResults.some((i) => i.path === "/memories/important.md")).toBe(
      true,
    );

    const editRes = await composite.edit(
      "/memories/important.md",
      "long-term",
      "persistent",
      false,
    );
    expect(editRes.error).toBeUndefined();
    expect(editRes.occurrences).toBe(1);

    const updatedContent = await composite.read("/memories/important.md");
    expect(updatedContent).toContain("persistent memory");
  });

  it("should handle nested directories correctly", async () => {
    const { state, stateAndStore } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(stateAndStore), {
      "/memories/": new StoreBackend(stateAndStore),
      "/archive/": new StoreBackend(stateAndStore),
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

    const rootListing = await composite.lsInfo("/");
    const rootPaths = rootListing.map((fi) => fi.path);
    expect(rootPaths).toContain("/temp.txt");
    expect(rootPaths).toContain("/work/");
    expect(rootPaths).toContain("/memories/");
    expect(rootPaths).toContain("/archive/");
    expect(rootPaths).not.toContain("/work/file1.txt");
    expect(rootPaths).not.toContain("/memories/important.txt");

    const workListing = await composite.lsInfo("/work/");
    const workPaths = workListing.map((fi) => fi.path);
    expect(workPaths).toContain("/work/file1.txt");
    expect(workPaths).toContain("/work/projects/");
    expect(workPaths).not.toContain("/work/projects/proj1.txt");

    const memListing = await composite.lsInfo("/memories/");
    const memPaths = memListing.map((fi) => fi.path);
    expect(memPaths).toContain("/memories/important.txt");
    expect(memPaths).toContain("/memories/diary/");
    expect(memPaths).not.toContain("/memories/diary/entry1.txt");

    const archListing = await composite.lsInfo("/archive/");
    const archPaths = archListing.map((fi) => fi.path);
    expect(archPaths).toContain("/archive/old.txt");
    expect(archPaths).toContain("/archive/2023/");
    expect(archPaths).not.toContain("/archive/2023/log.txt");
  });

  it("should handle trailing slashes in ls", async () => {
    const { state, stateAndStore } = makeConfig();

    const composite = new CompositeBackend(new StateBackend(stateAndStore), {
      "/store/": new StoreBackend(stateAndStore),
    });

    const res = await composite.write("/file.txt", "content");
    Object.assign(state.files, res.filesUpdate!);

    await composite.write("/store/item.txt", "store content");

    const listing = await composite.lsInfo("/");
    const paths = listing.map((fi) => fi.path);
    expect(paths).toEqual(paths.slice().sort());

    const emptyListing1 = await composite.lsInfo("/store/nonexistent/");
    expect(emptyListing1).toEqual([]);

    const emptyListing2 = await composite.lsInfo("/nonexistent/");
    expect(emptyListing2).toEqual([]);

    const listing1 = await composite.lsInfo("/store/");
    const listing2 = await composite.lsInfo("/store");
    expect(listing1.map((fi) => fi.path)).toEqual(
      listing2.map((fi) => fi.path),
    );
  });

  it("should handle large tool result interception with default route", async () => {
    const { config } = makeConfig();
    const { createFilesystemMiddleware } = await import("../middleware/fs.js");
    const { ToolMessage } = await import("@langchain/core/messages");
    const { Command } = await import("@langchain/langgraph");

    const middleware = createFilesystemMiddleware({
      backend: (stateAndStore) =>
        new CompositeBackend(new StateBackend(stateAndStore), {
          "/memories/": new StoreBackend(stateAndStore),
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
        config: config,
        state: { files: {}, messages: [] },
        runtime: {},
      },
      mockToolFn,
    );

    expect(result).toBeInstanceOf(Command);
    expect(result.update.files).toBeDefined();
    expect(result.update.files["/large_tool_results/test_789"]).toBeDefined();
    expect(result.update.files["/large_tool_results/test_789"].content).toEqual(
      [largeContent],
    );

    expect(result.update.messages).toHaveLength(1);
    expect(result.update.messages[0].content).toContain(
      "Tool result too large",
    );
  });

  it("should handle large tool result interception routed to store", async () => {
    const { config } = makeConfig();
    const { createFilesystemMiddleware } = await import("../middleware/fs.js");
    const { ToolMessage } = await import("@langchain/core/messages");

    const middleware = createFilesystemMiddleware({
      backend: (stateAndStore) =>
        new CompositeBackend(new StateBackend(stateAndStore), {
          "/large_tool_results/": new StoreBackend(stateAndStore),
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
        config: config,
        state: { files: {}, messages: [] },
        runtime: {},
      },
      mockToolFn,
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect(result.content).toContain("Tool result too large");
    expect(result.content).toContain("/large_tool_results/test_routed_123");

    const storedContent = await config.store.get(
      ["filesystem"],
      "/test_routed_123",
    );
    expect(storedContent).toBeDefined();
    expect((storedContent!.value as any).content).toEqual([largeContent]);
  });

  it("should work with FilesystemBackend as default and StoreBackend route", async () => {
    const tmpDir = createTempDir();
    try {
      const { stateAndStore } = makeConfig();

      const fsBackend = new FilesystemBackend({
        rootDir: tmpDir,
        virtualMode: true,
      });
      const storeBackend = new StoreBackend(stateAndStore);
      const composite = new CompositeBackend(fsBackend, {
        "/memories/": storeBackend,
      });

      const r1 = await composite.write("/hello.txt", "hello");
      expect(r1.error).toBeUndefined();
      expect(r1.filesUpdate).toBeNull();

      const r2 = await composite.write("/memories/notes.md", "note");
      expect(r2.error).toBeUndefined();
      expect(r2.filesUpdate).toBeNull(); // Store also returns null

      const infosRoot = await composite.lsInfo("/");
      expect(infosRoot.some((i) => i.path === "/hello.txt")).toBe(true);
      expect(infosRoot.some((i) => i.path === "/memories/")).toBe(true);

      const infosMem = await composite.lsInfo("/memories/");
      expect(infosMem.some((i) => i.path === "/memories/notes.md")).toBe(true);

      const gm1 = await composite.grepRaw("hello", "/");
      expect(Array.isArray(gm1)).toBe(true);
      if (Array.isArray(gm1)) {
        expect(gm1.some((m) => m.path === "/hello.txt")).toBe(true);
      }

      const gm2 = await composite.grepRaw("note", "/");
      expect(Array.isArray(gm2)).toBe(true);
      if (Array.isArray(gm2)) {
        expect(gm2.some((m) => m.path === "/memories/notes.md")).toBe(true);
      }

      const gl = await composite.globInfo("*.md", "/");
      expect(gl.some((i) => i.path === "/memories/notes.md")).toBe(true);
    } finally {
      await removeDir(tmpDir);
    }
  });

  it("should work with StoreBackend as default and another StoreBackend route", async () => {
    const { stateAndStore } = makeConfig();

    const defaultStore = new StoreBackend(stateAndStore);
    const memoriesStore = new StoreBackend(stateAndStore);

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
    expect(content1).toContain("default store content");

    const content2 = await composite.read("/memories/important.txt");
    expect(content2).toContain("routed store content");

    const infos = await composite.lsInfo("/");
    const paths = infos.map((i) => i.path);
    expect(paths).toContain("/notes.txt");
    expect(paths).toContain("/memories/");

    const matches1 = await composite.grepRaw("default", "/");
    expect(Array.isArray(matches1)).toBe(true);
    if (Array.isArray(matches1)) {
      expect(matches1.some((m) => m.path === "/notes.txt")).toBe(true);
    }

    const matches2 = await composite.grepRaw("routed", "/");
    expect(Array.isArray(matches2)).toBe(true);
    if (Array.isArray(matches2)) {
      expect(matches2.some((m) => m.path === "/memories/important.txt")).toBe(
        true,
      );
    }
  });

  it("should handle nested directories with FilesystemBackend and StoreBackend", async () => {
    const tmpDir = createTempDir();
    try {
      const { stateAndStore } = makeConfig();

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
      const storeBackend = new StoreBackend(stateAndStore);
      const composite = new CompositeBackend(fsBackend, {
        "/memories/": storeBackend,
      });

      await composite.write("/memories/note1.txt", "note 1");
      await composite.write("/memories/deep/note2.txt", "note 2");
      await composite.write("/memories/deep/nested/note3.txt", "note 3");

      const rootListing = await composite.lsInfo("/");
      const rootPaths = rootListing.map((fi) => fi.path);
      expect(rootPaths).toContain("/local.txt");
      expect(rootPaths).toContain("/src/");
      expect(rootPaths).toContain("/memories/");
      expect(rootPaths).not.toContain("/src/main.py");
      expect(rootPaths).not.toContain("/memories/note1.txt");

      const srcListing = await composite.lsInfo("/src/");
      const srcPaths = srcListing.map((fi) => fi.path);
      expect(srcPaths).toContain("/src/main.py");
      expect(srcPaths).toContain("/src/utils/");
      expect(srcPaths).not.toContain("/src/utils/helper.py");

      const memListing = await composite.lsInfo("/memories/");
      const memPaths = memListing.map((fi) => fi.path);
      expect(memPaths).toContain("/memories/note1.txt");
      expect(memPaths).toContain("/memories/deep/");
      expect(memPaths).not.toContain("/memories/deep/note2.txt");

      const deepListing = await composite.lsInfo("/memories/deep/");
      const deepPaths = deepListing.map((fi) => fi.path);
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
      const { stateAndStore } = makeConfig();

      const composite = new CompositeBackend(mockSandbox, {
        "/store/": new StoreBackend(stateAndStore),
      });

      const result = await composite.execute("echo hello");
      expect(result.output).toBe("Executed: echo hello");
      expect(result.exitCode).toBe(0);
      expect(mockSandbox.lastCommand).toBe("echo hello");
    });

    it("should throw error when default backend is not sandbox", () => {
      const { stateAndStore } = makeConfig();

      const composite = new CompositeBackend(new StateBackend(stateAndStore), {
        "/store/": new StoreBackend(stateAndStore),
      });

      expect(() => composite.execute("echo hello")).toThrow(
        "doesn't support command execution",
      );
    });
  });

  describe("uploadFiles", () => {
    it("should route uploads to correct backend based on path", async () => {
      const { stateAndStore } = makeConfig();

      const composite = new CompositeBackend(new StateBackend(stateAndStore), {
        "/store/": new StoreBackend(stateAndStore),
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
      const { stateAndStore } = makeConfig();

      const composite = new CompositeBackend(new StateBackend(stateAndStore), {
        "/store/": new StoreBackend(stateAndStore),
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
      const { state, stateAndStore } = makeConfig();

      const composite = new CompositeBackend(new StateBackend(stateAndStore), {
        "/store/": new StoreBackend(stateAndStore),
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
      const { state, stateAndStore } = makeConfig();

      const composite = new CompositeBackend(new StateBackend(stateAndStore), {
        "/store/": new StoreBackend(stateAndStore),
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
