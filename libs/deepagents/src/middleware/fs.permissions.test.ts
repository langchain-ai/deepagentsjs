import { describe, it, expect, vi } from "vitest";
import { createFilesystemMiddleware } from "./fs.js";
import { FilesystemPermission } from "../permissions/types.js";
import type { BackendProtocolV2 } from "../backends/protocol.js";

function createMockBackend(): BackendProtocolV2 {
  return {
    ls: vi.fn().mockResolvedValue({ files: [] }),
    read: vi
      .fn()
      .mockResolvedValue({ content: "file content", mimeType: "text/plain" }),
    write: vi.fn().mockResolvedValue({ error: null, filesUpdate: null }),
    edit: vi
      .fn()
      .mockResolvedValue({ error: null, occurrences: 1, filesUpdate: null }),
    glob: vi.fn().mockResolvedValue({ files: [] }),
    grep: vi.fn().mockResolvedValue({ matches: [] }),
  } as unknown as BackendProtocolV2;
}

function getTool(
  middleware: ReturnType<typeof createFilesystemMiddleware>,
  name: string,
) {
  const tool = middleware.tools!.find((t: any) => t.name === name) as any;
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

const deny = (paths: string[]) =>
  new FilesystemPermission({
    operations: ["read", "write"],
    paths,
    mode: "deny",
  });

const denyRead = (paths: string[]) =>
  new FilesystemPermission({ operations: ["read"], paths, mode: "deny" });

const denyWrite = (paths: string[]) =>
  new FilesystemPermission({ operations: ["write"], paths, mode: "deny" });

describe("fs tool permissions", () => {
  describe("no permissions configured", () => {
    it("all tools operate normally when permissions is empty", async () => {
      const backend = createMockBackend();
      backend.read = vi
        .fn()
        .mockResolvedValue({ content: "hello", mimeType: "text/plain" });
      const middleware = createFilesystemMiddleware({ backend });

      // read_file returns an array of content blocks — just confirm it resolves without throwing
      await expect(
        getTool(middleware, "read_file").invoke({ file_path: "/any/path.txt" }),
      ).resolves.toBeDefined();
    });
  });

  describe("read_file", () => {
    it("throws on a denied path", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyRead(["/secrets/**"])],
      });

      await expect(
        getTool(middleware, "read_file").invoke({
          file_path: "/secrets/key.txt",
        }),
      ).rejects.toThrow(/permission denied for read on \/secrets\/key\.txt/);
    });

    it("does not call backend when path is denied", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyRead(["/secrets/**"])],
      });

      await expect(
        getTool(middleware, "read_file").invoke({
          file_path: "/secrets/key.txt",
        }),
      ).rejects.toThrow();
      expect(backend.read).not.toHaveBeenCalled();
    });

    it("succeeds on an allowed path", async () => {
      const backend = createMockBackend();
      backend.read = vi
        .fn()
        .mockResolvedValue({ content: "hello world", mimeType: "text/plain" });
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyRead(["/secrets/**"])],
      });

      const result = await getTool(middleware, "read_file").invoke({
        file_path: "/workspace/file.txt",
      });
      expect(result).toBeDefined();
      expect(backend.read).toHaveBeenCalledWith("/workspace/file.txt", 0, 100);
    });
  });

  describe("write_file", () => {
    it("throws on a denied path", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyWrite(["/readonly/**"])],
      });

      await expect(
        getTool(middleware, "write_file").invoke({
          file_path: "/readonly/config.json",
          content: "data",
        }),
      ).rejects.toThrow(
        /permission denied for write on \/readonly\/config\.json/,
      );
    });

    it("does not call backend when path is denied", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/readonly/**"])],
      });

      await expect(
        getTool(middleware, "write_file").invoke({
          file_path: "/readonly/config.json",
          content: "data",
        }),
      ).rejects.toThrow();
      expect(backend.write).not.toHaveBeenCalled();
    });

    it("succeeds on an allowed path", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/readonly/**"])],
      });

      await getTool(middleware, "write_file").invoke({
        file_path: "/workspace/out.txt",
        content: "data",
      });
      expect(backend.write).toHaveBeenCalledWith("/workspace/out.txt", "data");
    });
  });

  describe("edit_file", () => {
    it("throws on a denied path", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyWrite(["/readonly/**"])],
      });

      await expect(
        getTool(middleware, "edit_file").invoke({
          file_path: "/readonly/config.json",
          old_string: "a",
          new_string: "b",
        }),
      ).rejects.toThrow(
        /permission denied for write on \/readonly\/config\.json/,
      );
    });

    it("does not call backend when path is denied", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/readonly/**"])],
      });

      await expect(
        getTool(middleware, "edit_file").invoke({
          file_path: "/readonly/config.json",
          old_string: "a",
          new_string: "b",
        }),
      ).rejects.toThrow();
      expect(backend.edit).not.toHaveBeenCalled();
    });
  });

  describe("ls", () => {
    it("throws when base path is denied", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyRead(["/secrets/**", "/secrets"])],
      });

      await expect(
        getTool(middleware, "ls").invoke({ path: "/secrets" }),
      ).rejects.toThrow(/permission denied for read on \/secrets/);
    });

    it("post-filters denied entries from results", async () => {
      const backend = createMockBackend();
      backend.ls = vi.fn().mockResolvedValue({
        files: [
          { path: "/workspace/ok.txt", is_dir: false },
          { path: "/secrets/key.txt", is_dir: false },
          { path: "/workspace/also-ok.txt", is_dir: false },
        ],
      });
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyRead(["/secrets/**"])],
      });

      const result = await getTool(middleware, "ls").invoke({ path: "/" });
      expect(result).toContain("/workspace/ok.txt");
      expect(result).toContain("/workspace/also-ok.txt");
      expect(result).not.toContain("/secrets/key.txt");
    });

    it("returns empty message when all entries are filtered out", async () => {
      const backend = createMockBackend();
      backend.ls = vi.fn().mockResolvedValue({
        files: [{ path: "/secrets/key.txt", is_dir: false }],
      });
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyRead(["/secrets/**"])],
      });

      const result = await getTool(middleware, "ls").invoke({ path: "/" });
      expect(result).toMatch(/no files found/i);
    });
  });

  describe("glob", () => {
    it("throws when base path is denied", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyRead(["/secrets/**", "/secrets"])],
      });

      await expect(
        getTool(middleware, "glob").invoke({
          pattern: "**/*.txt",
          path: "/secrets",
        }),
      ).rejects.toThrow(/permission denied for read on \/secrets/);
    });

    it("post-filters denied paths from results", async () => {
      const backend = createMockBackend();
      backend.glob = vi.fn().mockResolvedValue({
        files: [
          { path: "/workspace/a.txt", is_dir: false },
          { path: "/secrets/key.txt", is_dir: false },
          { path: "/workspace/b.txt", is_dir: false },
        ],
      });
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyRead(["/secrets/**"])],
      });

      const result = await getTool(middleware, "glob").invoke({
        pattern: "**/*.txt",
      });
      expect(result).toContain("/workspace/a.txt");
      expect(result).toContain("/workspace/b.txt");
      expect(result).not.toContain("/secrets/key.txt");
    });
  });

  describe("grep", () => {
    it("throws when base path is denied", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyRead(["/secrets/**", "/secrets"])],
      });

      await expect(
        getTool(middleware, "grep").invoke({
          pattern: "password",
          path: "/secrets",
        }),
      ).rejects.toThrow(/permission denied for read on \/secrets/);
    });

    it("post-filters denied matches from results", async () => {
      const backend = createMockBackend();
      backend.grep = vi.fn().mockResolvedValue({
        matches: [
          { path: "/workspace/app.ts", line: 1, text: "password = foo" },
          { path: "/secrets/env", line: 3, text: "password = bar" },
          { path: "/workspace/config.ts", line: 5, text: "password = baz" },
        ],
      });
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyRead(["/secrets/**"])],
      });

      const result = await getTool(middleware, "grep").invoke({
        pattern: "password",
      });
      expect(result).toContain("/workspace/app.ts");
      expect(result).toContain("/workspace/config.ts");
      expect(result).not.toContain("/secrets/env");
    });
  });

  describe("execute", () => {
    it("is not affected by permissions", async () => {
      const backend = {
        ...createMockBackend(),
        id: "sandbox",
        execute: vi
          .fn()
          .mockResolvedValue({ output: "ok", exitCode: 0, truncated: false }),
      } as unknown as BackendProtocolV2;
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [deny(["/**"])],
      });

      const result = await getTool(middleware, "execute").invoke({
        command: "echo hi",
      });
      expect(result).toContain("ok");
    });
  });
});
