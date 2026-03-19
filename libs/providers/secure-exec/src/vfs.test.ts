import { describe, it, expect, vi, beforeEach } from "vitest";
import { BackendVirtualFileSystem } from "./vfs.js";
import type { BackendProtocolV2 } from "deepagents";

function makeBackend(
  overrides: Partial<BackendProtocolV2> = {},
): BackendProtocolV2 {
  return {
    readRaw: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    ls: vi.fn(),
    glob: vi.fn(),
    grep: vi.fn(),
    edit: vi.fn(),
    ...overrides,
  } as unknown as BackendProtocolV2;
}

describe("BackendVirtualFileSystem", () => {
  let vfs: BackendVirtualFileSystem;

  beforeEach(() => {
    vfs = new BackendVirtualFileSystem();
  });

  describe("readTextFile", () => {
    it("delegates to backend.readRaw and returns string content", async () => {
      const backend = makeBackend({
        readRaw: vi.fn().mockResolvedValue({
          data: {
            content: "hello world",
            mimeType: "text/plain",
            created_at: "",
            modified_at: "",
          },
        }),
      });
      vfs.setBackend(backend);

      const result = await vfs.readTextFile("/foo.txt");
      expect(result).toBe("hello world");
      expect(backend.readRaw).toHaveBeenCalledWith("/foo.txt");
    });

    it("joins array content with newline (v1 backend format)", async () => {
      const backend = makeBackend({
        readRaw: vi.fn().mockResolvedValue({
          data: {
            content: ["line1", "line2", "line3"],
            created_at: "",
            modified_at: "",
          },
        }),
      });
      vfs.setBackend(backend);

      const result = await vfs.readTextFile("/file.txt");
      expect(result).toBe("line1\nline2\nline3");
    });

    it("throws ENOENT when backend returns an error", async () => {
      const backend = makeBackend({
        readRaw: vi.fn().mockResolvedValue({ error: "not found" }),
      });
      vfs.setBackend(backend);

      await expect(vfs.readTextFile("/missing.txt")).rejects.toThrow(
        "ENOENT: no such file or directory '/missing.txt'",
      );
    });

    it("throws ENOENT when backend is not set", async () => {
      await expect(vfs.readTextFile("/foo.txt")).rejects.toThrow(
        "ENOENT: no such file or directory '/foo.txt'",
      );
    });

    it("throws ENOENT when backend.readRaw throws", async () => {
      const backend = makeBackend({
        readRaw: vi.fn().mockRejectedValue(new Error("connection failed")),
      });
      vfs.setBackend(backend);

      await expect(vfs.readTextFile("/foo.txt")).rejects.toThrow(
        "ENOENT: no such file or directory '/foo.txt'",
      );
    });

    it("throws ENOENT when content is not string or array", async () => {
      const backend = makeBackend({
        readRaw: vi.fn().mockResolvedValue({
          data: {
            content: new Uint8Array([1, 2, 3]),
            mimeType: "application/octet-stream",
            created_at: "",
            modified_at: "",
          },
        }),
      });
      vfs.setBackend(backend);

      await expect(vfs.readTextFile("/bin.dat")).rejects.toThrow(
        "ENOENT: no such file or directory '/bin.dat'",
      );
    });
  });

  describe("readFile", () => {
    it("returns Uint8Array encoded text", async () => {
      const backend = makeBackend({
        readRaw: vi.fn().mockResolvedValue({
          data: {
            content: "hello",
            mimeType: "text/plain",
            created_at: "",
            modified_at: "",
          },
        }),
      });
      vfs.setBackend(backend);

      const result = await vfs.readFile("/foo.txt");
      expect(result).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(result)).toBe("hello");
    });
  });

  describe("writeFile", () => {
    it("buffers string writes to pendingWrites", async () => {
      await vfs.writeFile("/out.txt", "content here");
      expect(vfs.pendingWrites).toHaveLength(1);
      expect(vfs.pendingWrites[0]).toEqual({
        path: "/out.txt",
        content: "content here",
      });
    });

    it("decodes Uint8Array content before buffering", async () => {
      const bytes = new TextEncoder().encode("binary content");
      await vfs.writeFile("/bin.txt", bytes);
      expect(vfs.pendingWrites[0]).toEqual({
        path: "/bin.txt",
        content: "binary content",
      });
    });

    it("accumulates multiple writes in order", async () => {
      await vfs.writeFile("/a.txt", "first");
      await vfs.writeFile("/b.txt", "second");
      await vfs.writeFile("/c.txt", "third");

      expect(vfs.pendingWrites).toHaveLength(3);
      expect(vfs.pendingWrites[0].path).toBe("/a.txt");
      expect(vfs.pendingWrites[1].path).toBe("/b.txt");
      expect(vfs.pendingWrites[2].path).toBe("/c.txt");
    });
  });

  describe("exists", () => {
    it("returns true when readTextFile succeeds", async () => {
      const backend = makeBackend({
        readRaw: vi.fn().mockResolvedValue({
          data: {
            content: "data",
            mimeType: "text/plain",
            created_at: "",
            modified_at: "",
          },
        }),
      });
      vfs.setBackend(backend);

      expect(await vfs.exists("/foo.txt")).toBe(true);
    });

    it("returns false when readTextFile throws", async () => {
      const backend = makeBackend({
        readRaw: vi.fn().mockResolvedValue({ error: "not found" }),
      });
      vfs.setBackend(backend);

      expect(await vfs.exists("/missing.txt")).toBe(false);
    });

    it("returns false when backend is not set", async () => {
      expect(await vfs.exists("/foo.txt")).toBe(false);
    });
  });

  describe("ENOSYS operations", () => {
    it("readDir throws ENOSYS", async () => {
      await expect(vfs.readDir("/")).rejects.toThrow("ENOSYS");
    });

    it("stat throws ENOSYS", async () => {
      await expect(vfs.stat("/")).rejects.toThrow("ENOSYS");
    });

    it("rename throws ENOSYS", async () => {
      await expect(vfs.rename("/a", "/b")).rejects.toThrow("ENOSYS");
    });

    it("removeFile throws ENOSYS", async () => {
      await expect(vfs.removeFile("/a")).rejects.toThrow("ENOSYS");
    });
  });

  describe("no-op operations", () => {
    it("mkdir resolves without error", async () => {
      await expect(vfs.mkdir("/some/dir")).resolves.toBeUndefined();
    });

    it("createDir resolves without error", async () => {
      await expect(vfs.createDir("/some/dir")).resolves.toBeUndefined();
    });
  });
});
