/**
 * Unit tests for the ACP Filesystem Backend
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ACPFilesystemBackend } from "./acp-filesystem-backend.js";

vi.mock("deepagents", () => {
  class MockFilesystemBackend {
    cwd: string;
    lsInfo = vi.fn().mockResolvedValue([]);
    read = vi.fn().mockResolvedValue("local file content");
    readRaw = vi.fn().mockResolvedValue({ content: "" });
    write = vi.fn().mockResolvedValue({ path: "/test.txt", filesUpdate: null });
    edit = vi.fn().mockResolvedValue({ path: "/test.txt", filesUpdate: null });
    grepRaw = vi.fn().mockResolvedValue([]);
    globInfo = vi.fn().mockResolvedValue([]);
    downloadFiles = vi.fn().mockResolvedValue([]);
    uploadFiles = vi.fn().mockResolvedValue([]);
    constructor(options?: { rootDir?: string }) {
      this.cwd = options?.rootDir ?? process.cwd();
    }
  }

  return {
    FilesystemBackend: MockFilesystemBackend,
    WriteResult: {},
  };
});

describe("ACPFilesystemBackend", () => {
  let mockConn: any;

  beforeEach(() => {
    mockConn = {
      readTextFile: vi.fn().mockResolvedValue({ text: "acp file content" }),
      writeTextFile: vi.fn().mockResolvedValue({}),
    };
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create backend with connection and root dir", () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });
      expect(backend).toBeInstanceOf(ACPFilesystemBackend);
    });
  });

  describe("read", () => {
    it("should proxy reads through ACP when session is set", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });
      backend.setSessionId("sess_123");

      const result = await backend.read("/workspace/src/index.ts");

      expect(mockConn.readTextFile).toHaveBeenCalledTimes(1);
      expect(result).toBe("acp file content");
    });

    it("should resolve relative paths using cwd", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });
      backend.setSessionId("sess_123");

      await backend.read("src/index.ts");

      const callArgs = mockConn.readTextFile.mock.calls[0][0];
      expect(callArgs.path).toContain("/workspace");
      expect(callArgs.path).toContain("src/index.ts");
    });

    it("should fall back to local FS when no session is set", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });

      const result = await backend.read("/workspace/test.txt");

      expect(mockConn.readTextFile).not.toHaveBeenCalled();
      expect(result).toBe("local file content");
    });

    it("should fall back to local FS when ACP read fails", async () => {
      mockConn.readTextFile.mockRejectedValue(new Error("File not found"));
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });
      backend.setSessionId("sess_123");

      const result = await backend.read("/workspace/test.txt");

      expect(mockConn.readTextFile).toHaveBeenCalledTimes(1);
      expect(result).toBe("local file content");
    });

    it("should handle offset and limit when reading via ACP", async () => {
      mockConn.readTextFile.mockResolvedValue({
        text: "line0\nline1\nline2\nline3\nline4",
      });
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });
      backend.setSessionId("sess_123");

      const result = await backend.read("/workspace/test.txt", 1, 2);

      expect(result).toBe("line1\nline2");
    });
  });

  describe("write", () => {
    it("should proxy writes through ACP when session is set", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });
      backend.setSessionId("sess_123");

      const result = await backend.write(
        "/workspace/output.txt",
        "new content",
      );

      expect(mockConn.writeTextFile).toHaveBeenCalledTimes(1);
      expect(result.filesUpdate).toBeNull();
    });

    it("should pass correct params to writeTextFile", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });
      backend.setSessionId("sess_123");

      await backend.write("/workspace/output.txt", "data");

      const callArgs = mockConn.writeTextFile.mock.calls[0][0];
      expect(callArgs.path).toBe("/workspace/output.txt");
      expect(callArgs.content).toBe("data");
    });

    it("should fall back to local FS when no session is set", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });

      await backend.write("/workspace/test.txt", "content");

      expect(mockConn.writeTextFile).not.toHaveBeenCalled();
    });

    it("should fall back to local FS when ACP write fails", async () => {
      mockConn.writeTextFile.mockRejectedValue(new Error("Permission denied"));
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });
      backend.setSessionId("sess_123");

      const result = await backend.write("/workspace/test.txt", "content");

      expect(mockConn.writeTextFile).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
    });
  });

  describe("session management", () => {
    it("should switch session IDs", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });

      backend.setSessionId("sess_1");
      await backend.read("/workspace/test.txt");
      expect(mockConn.readTextFile.mock.calls[0][0].sessionId).toBe("sess_1");

      backend.setSessionId("sess_2");
      await backend.read("/workspace/test.txt");
      expect(mockConn.readTextFile.mock.calls[1][0].sessionId).toBe("sess_2");
    });
  });

  describe("inherited operations", () => {
    it("should use local FS for lsInfo (no ACP equivalent)", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });
      backend.setSessionId("sess_123");

      await backend.lsInfo("/workspace/src");

      expect(mockConn.readTextFile).not.toHaveBeenCalled();
      expect(mockConn.writeTextFile).not.toHaveBeenCalled();
    });

    it("should use local FS for grepRaw (no ACP equivalent)", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });
      backend.setSessionId("sess_123");

      await backend.grepRaw("TODO", "/workspace/src");

      expect(mockConn.readTextFile).not.toHaveBeenCalled();
    });

    it("should use local FS for globInfo (no ACP equivalent)", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: "/workspace",
      });
      backend.setSessionId("sess_123");

      await backend.globInfo("*.ts", "/workspace");

      expect(mockConn.readTextFile).not.toHaveBeenCalled();
    });
  });
});
