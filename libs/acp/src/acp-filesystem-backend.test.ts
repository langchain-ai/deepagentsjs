/**
 * Unit tests for the ACP Filesystem Backend
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACPFilesystemBackend } from "./acp-filesystem-backend.js";

describe("ACPFilesystemBackend", () => {
  let mockConn: any;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-backend-test-"));
    fs.writeFileSync(path.join(tmpDir, "local.txt"), "local file content");

    mockConn = {
      readTextFile: vi.fn().mockResolvedValue({ text: "acp file content" }),
      writeTextFile: vi.fn().mockResolvedValue({}),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("should create backend with connection and root dir", () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      expect(backend).toBeInstanceOf(ACPFilesystemBackend);
    });
  });

  describe("read", () => {
    it("should proxy reads through ACP when session is set", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      backend.setSessionId("sess_123");

      const result = await backend.read(path.join(tmpDir, "local.txt"));

      expect(mockConn.readTextFile).toHaveBeenCalledTimes(1);
      expect(result).toBe("acp file content");
    });

    it("should resolve relative paths using cwd", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      backend.setSessionId("sess_123");

      await backend.read("local.txt");

      const callArgs = mockConn.readTextFile.mock.calls[0][0];
      expect(callArgs.path).toContain(tmpDir);
      expect(callArgs.path).toContain("local.txt");
    });

    it("should fall back to local FS when no session is set", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });

      const result = await backend.read(path.join(tmpDir, "local.txt"));

      expect(mockConn.readTextFile).not.toHaveBeenCalled();
      expect(result).toContain("local file content");
    });

    it("should fall back to local FS when ACP read fails", async () => {
      mockConn.readTextFile.mockRejectedValue(new Error("File not found"));
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      backend.setSessionId("sess_123");

      const result = await backend.read(path.join(tmpDir, "local.txt"));

      expect(mockConn.readTextFile).toHaveBeenCalledTimes(1);
      expect(result).toContain("local file content");
    });

    it("should handle offset and limit when reading via ACP", async () => {
      mockConn.readTextFile.mockResolvedValue({
        text: "line0\nline1\nline2\nline3\nline4",
      });
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      backend.setSessionId("sess_123");

      const result = await backend.read(path.join(tmpDir, "local.txt"), 1, 2);

      expect(result).toBe("line1\nline2");
    });

    it("should pass sessionId in readTextFile call", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      backend.setSessionId("sess_abc");

      await backend.read(path.join(tmpDir, "local.txt"));

      expect(mockConn.readTextFile.mock.calls[0][0].sessionId).toBe("sess_abc");
    });
  });

  describe("write", () => {
    it("should proxy writes through ACP when session is set", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      backend.setSessionId("sess_123");

      const result = await backend.write(
        path.join(tmpDir, "output.txt"),
        "new content",
      );

      expect(mockConn.writeTextFile).toHaveBeenCalledTimes(1);
      expect(result.filesUpdate).toBeNull();
    });

    it("should pass correct params to writeTextFile", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      backend.setSessionId("sess_123");

      const targetPath = path.join(tmpDir, "output.txt");
      await backend.write(targetPath, "data");

      const callArgs = mockConn.writeTextFile.mock.calls[0][0];
      expect(callArgs.path).toBe(targetPath);
      expect(callArgs.content).toBe("data");
    });

    it("should fall back to local FS when no session is set", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });

      const targetPath = path.join(tmpDir, "fallback-write.txt");
      await backend.write(targetPath, "written locally");

      expect(mockConn.writeTextFile).not.toHaveBeenCalled();
      expect(fs.readFileSync(targetPath, "utf-8")).toBe("written locally");
    });

    it("should fall back to local FS when ACP write fails", async () => {
      mockConn.writeTextFile.mockRejectedValue(new Error("Permission denied"));
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      backend.setSessionId("sess_123");

      const targetPath = path.join(tmpDir, "fallback-err.txt");
      const result = await backend.write(targetPath, "fallback content");

      expect(mockConn.writeTextFile).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
      expect(fs.readFileSync(targetPath, "utf-8")).toBe("fallback content");
    });
  });

  describe("session management", () => {
    it("should switch session IDs between calls", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      const filePath = path.join(tmpDir, "local.txt");

      backend.setSessionId("sess_1");
      await backend.read(filePath);
      expect(mockConn.readTextFile.mock.calls[0][0].sessionId).toBe("sess_1");

      backend.setSessionId("sess_2");
      await backend.read(filePath);
      expect(mockConn.readTextFile.mock.calls[1][0].sessionId).toBe("sess_2");
    });
  });

  describe("inherited operations", () => {
    it("should use local FS for lsInfo (no ACP equivalent)", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      backend.setSessionId("sess_123");

      const entries = await backend.lsInfo(tmpDir);

      expect(mockConn.readTextFile).not.toHaveBeenCalled();
      expect(mockConn.writeTextFile).not.toHaveBeenCalled();
      expect(entries.some((e: any) => e.path.includes("local.txt"))).toBe(true);
    });

    it("should use local FS for grepRaw (no ACP equivalent)", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      backend.setSessionId("sess_123");

      await backend.grepRaw("local", tmpDir);

      expect(mockConn.readTextFile).not.toHaveBeenCalled();
    });

    it("should use local FS for globInfo (no ACP equivalent)", async () => {
      const backend = new ACPFilesystemBackend({
        conn: mockConn,
        rootDir: tmpDir,
      });
      backend.setSessionId("sess_123");

      const matches = await backend.globInfo("*.txt", tmpDir);

      expect(mockConn.readTextFile).not.toHaveBeenCalled();
      expect(matches.length).toBeGreaterThan(0);
    });
  });
});
