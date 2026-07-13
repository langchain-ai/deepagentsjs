import { describe, it, expect, vi } from "vitest";
import { createFilesystemMiddleware } from "./fs.js";
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
    delete: vi.fn().mockResolvedValue({ path: "/deleted.txt", filesUpdate: null }),
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

/**
 * Normalize a tool result to searchable text. Errors come back as a ToolMessage
 * (content string); successful reads may be a plain string or content-block
 * array, so assertions can match against any shape.
 */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    const { content } = result as { content: unknown };
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  return JSON.stringify(result);
}

/** Read the ToolMessage status of a tool result, if present. */
function resultStatus(result: unknown): string | undefined {
  return result && typeof result === "object" && "status" in result
    ? (result as { status?: string }).status
    : undefined;
}

const deny = (paths: string[]) => ({
  operations: ["read", "write"] as const,
  paths,
  mode: "deny" as const,
});

const denyRead = (paths: string[]) => ({
  operations: ["read"] as const,
  paths,
  mode: "deny" as const,
});

const denyWrite = (paths: string[]) => ({
  operations: ["write"] as const,
  paths,
  mode: "deny" as const,
});

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

  describe("invalid permission paths", () => {
    it("throws at construction when a permission path is not absolute", () => {
      expect(() =>
        createFilesystemMiddleware({
          backend: createMockBackend(),
          permissions: [
            { operations: ["read"] as const, paths: ["relative/path"] },
          ],
        }),
      ).toThrow(/absolute/i);
    });

    it("throws at construction when a permission path contains ..", () => {
      expect(() =>
        createFilesystemMiddleware({
          backend: createMockBackend(),
          permissions: [
            { operations: ["read"] as const, paths: ["/workspace/../secrets"] },
          ],
        }),
      ).toThrow(/\.\./);
    });

    it("throws at construction when a permission path contains ~", () => {
      expect(() =>
        createFilesystemMiddleware({
          backend: createMockBackend(),
          permissions: [
            { operations: ["read"] as const, paths: ["/~/secrets"] },
          ],
        }),
      ).toThrow(/~/);
    });

    it("accepts valid glob patterns", () => {
      expect(() =>
        createFilesystemMiddleware({
          backend: createMockBackend(),
          permissions: [
            {
              operations: ["read"] as const,
              paths: ["/foo/**", "/foo/*.ts", "/foo/{a,b}"],
            },
          ],
        }),
      ).not.toThrow();
    });
  });

  describe("relative path bypass prevention", () => {
    it("rejects a relative path instead of bypassing permissions", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyRead(["/secrets/**"])],
      });

      // A malformed path must not reach the backend, but it is a recoverable
      // tool error the model can correct — never a run-ending throw.
      const result = await getTool(middleware, "read_file").invoke({
        file_path: "secrets/key.txt",
      });
      expect(resultText(result)).toMatch(/path must be absolute/i);
      expect(backend.read).not.toHaveBeenCalled();
    });
  });

  describe("malformed model paths do not crash the run", () => {
    const badPaths = [
      { label: "tilde home path", path: "~/.openwiki/wiki/quickstart.md" },
      { label: "relative path", path: "quickstart.md" },
      { label: "parent traversal", path: "/workspace/../etc/passwd" },
    ];

    for (const { label, path } of badPaths) {
      it(`read_file returns an error (not a throw) for a ${label}`, async () => {
        const backend = createMockBackend();
        const middleware = createFilesystemMiddleware({
          backend,
          permissions: [denyRead(["/secrets/**"])],
        });

        const result = await getTool(middleware, "read_file").invoke({
          file_path: path,
        });
        expect(resultText(result)).toMatch(/error/i);
        expect(resultStatus(result)).toBe("error");
        expect(backend.read).not.toHaveBeenCalled();
      });

      it(`write_file returns an error (not a throw) for a ${label}`, async () => {
        const backend = createMockBackend();
        const middleware = createFilesystemMiddleware({
          backend,
          permissions: [denyWrite(["/readonly/**"])],
        });

        const result = await getTool(middleware, "write_file").invoke({
          file_path: path,
          content: "data",
        });
        expect(resultText(result)).toMatch(/error/i);
        expect(backend.write).not.toHaveBeenCalled();
      });
    }

    it("does not crash when no permissions are configured either", async () => {
      // With empty rules the permission check is skipped entirely, so the
      // backend receives the raw path and reports its own (recoverable) error.
      const backend = createMockBackend();
      backend.read = vi
        .fn()
        .mockResolvedValue({ error: "invalid path", content: null });
      const middleware = createFilesystemMiddleware({ backend });

      await expect(
        getTool(middleware, "read_file").invoke({
          file_path: "~/.openwiki/wiki/quickstart.md",
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("read_file", () => {
    it("returns an error on a denied path", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyRead(["/secrets/**"])],
      });

      const result = await getTool(middleware, "read_file").invoke({
        file_path: "/secrets/key.txt",
      });
      expect(resultText(result)).toMatch(
        /permission denied for read on \/secrets\/key\.txt/,
      );
      expect(resultStatus(result)).toBe("error");
    });

    it("does not call backend when path is denied", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyRead(["/secrets/**"])],
      });

      const result = await getTool(middleware, "read_file").invoke({
        file_path: "/secrets/key.txt",
      });
      expect(resultText(result)).toMatch(/permission denied/);
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
    it("returns an error on a denied path", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyWrite(["/readonly/**"])],
      });

      const result = await getTool(middleware, "write_file").invoke({
        file_path: "/readonly/config.json",
        content: "data",
      });
      expect(resultText(result)).toMatch(
        /permission denied for write on \/readonly\/config\.json/,
      );
      expect(resultStatus(result)).toBe("error");
    });

    it("does not call backend when path is denied", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/readonly/**"])],
      });

      const result = await getTool(middleware, "write_file").invoke({
        file_path: "/readonly/config.json",
        content: "data",
      });
      expect(resultText(result)).toMatch(/permission denied/);
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
    it("returns an error on a denied path", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyWrite(["/readonly/**"])],
      });

      const result = await getTool(middleware, "edit_file").invoke({
        file_path: "/readonly/config.json",
        old_string: "a",
        new_string: "b",
      });
      expect(resultText(result)).toMatch(
        /permission denied for write on \/readonly\/config\.json/,
      );
    });

    it("does not call backend when path is denied", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/readonly/**"])],
      });

      const result = await getTool(middleware, "edit_file").invoke({
        file_path: "/readonly/config.json",
        old_string: "a",
        new_string: "b",
      });
      expect(resultText(result)).toMatch(/permission denied/);
      expect(backend.edit).not.toHaveBeenCalled();
    });
  });

  describe("ls", () => {
    it("returns an error when base path is denied", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyRead(["/secrets/**", "/secrets"])],
      });

      const result = await getTool(middleware, "ls").invoke({
        path: "/secrets",
      });
      expect(resultText(result)).toMatch(
        /permission denied for read on \/secrets/,
      );
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

  describe("delete", () => {
    it("returns an error and does not call backend when recursive target overlaps denied path", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/work/secrets/**"])],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work",
      });

      expect(String(result)).toContain("permission denied for write");
      expect(String(result)).toContain("/work/secrets/**");
      expect(backend.delete).not.toHaveBeenCalled();
    });

    it("succeeds on an allowed path", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/readonly/**"])],
      });

      await getTool(middleware, "delete").invoke({ file_path: "/workspace/tmp" });
      expect(backend.delete).toHaveBeenCalledWith("/workspace/tmp");
    });
  });

  describe("glob", () => {
    it("returns an error when base path is denied", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyRead(["/secrets/**", "/secrets"])],
      });

      const result = await getTool(middleware, "glob").invoke({
        pattern: "**/*.txt",
        path: "/secrets",
      });
      expect(resultText(result)).toMatch(
        /permission denied for read on \/secrets/,
      );
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
    it("returns an error when base path is denied", async () => {
      const middleware = createFilesystemMiddleware({
        backend: createMockBackend(),
        permissions: [denyRead(["/secrets/**", "/secrets"])],
      });

      const result = await getTool(middleware, "grep").invoke({
        pattern: "password",
        path: "/secrets",
      });
      expect(resultText(result)).toMatch(
        /permission denied for read on \/secrets/,
      );
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

  describe("sandbox backend guard", () => {
    function createSandboxBackend(): BackendProtocolV2 {
      return {
        ...createMockBackend(),
        id: "sandbox-1",
        execute: vi
          .fn()
          .mockResolvedValue({ output: "ok", exitCode: 0, truncated: false }),
      } as unknown as BackendProtocolV2;
    }

    it("throws when permissions are used with a sandbox backend", () => {
      expect(() =>
        createFilesystemMiddleware({
          backend: createSandboxBackend(),
          permissions: [deny(["/secrets/**"])],
        }),
      ).toThrow(
        /permissions cannot be used with a backend that supports command execution/i,
      );
    });

    it("does not throw when permissions are used with a sandbox backend and execute is disabled", () => {
      expect(() =>
        createFilesystemMiddleware({
          backend: createSandboxBackend(),
          permissions: [deny(["/secrets/**"])],
          tools: ["read_file"],
        }),
      ).not.toThrow();
    });

    it("does not throw when permissions is empty with a sandbox backend", () => {
      expect(() =>
        createFilesystemMiddleware({ backend: createSandboxBackend() }),
      ).not.toThrow();
    });

    it("does not throw when permissions are used with a non-sandbox backend", () => {
      expect(() =>
        createFilesystemMiddleware({
          backend: createMockBackend(),
          permissions: [deny(["/secrets/**"])],
        }),
      ).not.toThrow();
    });

    it("does not throw when backend is a factory function", () => {
      expect(() =>
        createFilesystemMiddleware({
          backend: () => createSandboxBackend() as any,
          permissions: [deny(["/secrets/**"])],
        }),
      ).not.toThrow();
    });

    it("execute tool returns error at runtime when factory resolves to a sandbox backend with permissions", async () => {
      const middleware = createFilesystemMiddleware({
        backend: () => createSandboxBackend() as any,
        permissions: [deny(["/secrets/**"])],
      });

      const result = await getTool(middleware, "execute").invoke({
        command: "echo hello",
      });

      expect(result).toMatch(
        /permissions cannot be used with a backend that supports command execution/i,
      );
    });

    it("does not throw when all permission paths are scoped to CompositeBackend routes", () => {
      const compositeWithSandbox = {
        ...createSandboxBackend(),
        routePrefixes: ["/workspace/"],
      } as unknown as BackendProtocolV2;

      expect(() =>
        createFilesystemMiddleware({
          backend: compositeWithSandbox,
          permissions: [deny(["/workspace/**"])],
        }),
      ).not.toThrow();
    });

    it("throws when some permission paths are not scoped to CompositeBackend routes", () => {
      const compositeWithSandbox = {
        ...createSandboxBackend(),
        routePrefixes: ["/workspace/"],
      } as unknown as BackendProtocolV2;

      expect(() =>
        createFilesystemMiddleware({
          backend: compositeWithSandbox,
          permissions: [deny(["/**"])],
        }),
      ).toThrow(
        /permissions cannot be used with a backend that supports command execution/i,
      );
    });

    it("throws when a permission path shares a prefix with but is outside a route (no trailing slash confusion)", () => {
      const compositeWithSandbox = {
        ...createSandboxBackend(),
        routePrefixes: ["/workspace"],
      } as unknown as BackendProtocolV2;

      // "/workspace2/**" starts with "/workspace" but is not inside the route
      expect(() =>
        createFilesystemMiddleware({
          backend: compositeWithSandbox,
          permissions: [deny(["/workspace2/**"])],
        }),
      ).toThrow(
        /permissions cannot be used with a backend that supports command execution/i,
      );
    });
  });
});
