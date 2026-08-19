import { describe, it, expect, vi } from "vitest";
import { createFilesystemMiddleware, findDeleteDenyPatterns } from "./fs.js";
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
    delete: vi
      .fn()
      .mockResolvedValue({ path: "/deleted.txt", filesUpdate: null }),
    glob: vi.fn().mockResolvedValue({ files: [] }),
    grep: vi.fn().mockResolvedValue({ matches: [] }),
  } as unknown as BackendProtocolV2;
}

/**
 * A minimal stateful backend for integration-style delete tests: it actually
 * stores paths and removes the target subtree, so tests can assert real file
 * removal (or preservation on denial) through the delete tool, exercising the
 * full probe -> permission -> backend.delete path rather than a call spy.
 */
function createInMemoryBackend(initialPaths: string[]): BackendProtocolV2 {
  const files = new Set(initialPaths);
  const trim = (p: string) =>
    p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  return {
    // Real backends (Store/State) list only immediate children: files as
    // is_dir:false and subdirectories as is_dir:true (with a trailing slash),
    // never the directory itself. Model that so the delete tool's leaf-vs-
    // subtree probe behaves the same as against a real backend.
    ls: vi.fn(async (dir = "/") => {
      const base = trim(dir);
      const prefix = base === "/" ? "/" : `${base}/`;
      const fileEntries: Array<{ path: string; is_dir: boolean }> = [];
      const subdirs = new Set<string>();
      for (const f of files) {
        if (!f.startsWith(prefix)) continue;
        const relative = f.slice(prefix.length);
        if (relative.length === 0) continue;
        if (relative.includes("/")) {
          subdirs.add(`${prefix}${relative.split("/")[0]}/`);
        } else {
          fileEntries.push({ path: f, is_dir: false });
        }
      }
      return {
        files: [
          ...fileEntries,
          ...[...subdirs].map((d) => ({ path: d, is_dir: true })),
        ],
      };
    }),
    read: vi.fn(async () => ({ content: "", mimeType: "text/plain" })),
    write: vi.fn(async () => ({ path: "/x", filesUpdate: null })),
    edit: vi.fn(async () => ({
      path: "/x",
      filesUpdate: null,
      occurrences: 0,
    })),
    delete: vi.fn(async (target: string) => {
      const base = trim(target);
      const prefix = base === "/" ? "/" : `${base}/`;
      const removed = [...files].filter(
        (f) => base === "/" || f === base || f.startsWith(prefix),
      );
      if (removed.length === 0) {
        return { error: `Error: File '${target}' not found` };
      }
      for (const f of removed) files.delete(f);
      return { path: target, filesUpdate: null };
    }),
    glob: vi.fn(async () => ({ files: [] })),
    grep: vi.fn(async () => ({ matches: [] })),
    // Expose the live set for assertions.
    __files: files,
  } as unknown as BackendProtocolV2 & { __files: Set<string> };
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

      expect(resultText(result)).toContain("permission denied for write");
      expect(resultText(result)).toContain("/work/secrets/**");
      expect(backend.delete).not.toHaveBeenCalled();
    });

    it("succeeds on an allowed path", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/readonly/**"])],
      });

      await getTool(middleware, "delete").invoke({
        file_path: "/workspace/tmp",
      });
      expect(backend.delete).toHaveBeenCalledWith("/workspace/tmp");
    });

    it("allows deleting a sibling that cannot match a wildcard deny rule", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/work/*.log"])],
      });

      await getTool(middleware, "delete").invoke({
        file_path: "/work/notes.txt",
      });

      expect(backend.delete).toHaveBeenCalledWith("/work/notes.txt");
    });

    it("denies deleting a path that matches a wildcard deny rule", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/work/*.log"])],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work/error.log",
      });

      expect(resultText(result)).toContain("permission denied for write");
      expect(backend.delete).not.toHaveBeenCalled();
    });

    it("denies deleting a parent that could recursively remove wildcard matches", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/work/*.log"])],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work",
      });

      expect(resultText(result)).toContain("permission denied for write");
      expect(backend.delete).not.toHaveBeenCalled();
    });

    it("denies deleting a nested subtree that could contain a glob match", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/work/**/secrets"])],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work/foo",
      });

      expect(resultText(result)).toContain("permission denied for write");
      expect(backend.delete).not.toHaveBeenCalled();
    });

    // Parity with Python `_find_delete_deny_patterns`: when the backend
    // confirms the target is a plain file (leaf), permission is resolved with
    // first-match-wins — an earlier allow rule beats a later deny.
    it("allows deleting a confirmed leaf when an earlier allow precedes a later deny", async () => {
      const backend = createMockBackend();
      // ls(target) reports "not a directory" -> confirmed leaf.
      backend.ls = vi.fn().mockResolvedValue({
        error: "Error: '/work/app.txt' is not a directory",
      });
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [
          {
            operations: ["write"] as const,
            paths: ["/work/**"],
            mode: "allow" as const,
          },
          denyWrite(["/work/app.txt"]),
        ],
      });

      await getTool(middleware, "delete").invoke({
        file_path: "/work/app.txt",
      });

      expect(backend.delete).toHaveBeenCalledWith("/work/app.txt");
    });

    // The same rules against a possible-subtree target must block regardless of
    // rule order, because a recursive delete could remove the denied path.
    it("denies deleting a directory whose subtree contains a later-denied path", async () => {
      const backend = createMockBackend();
      // ls(target) returns entries -> may have descendants (subtree).
      backend.ls = vi.fn().mockResolvedValue({
        files: [{ path: "/work/app.txt", is_dir: false }],
      });
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [
          {
            operations: ["write"] as const,
            paths: ["/work/**"],
            mode: "allow" as const,
          },
          denyWrite(["/work/app.txt"]),
        ],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work",
      });

      expect(resultText(result)).toContain("permission denied for write");
      expect(resultText(result)).toContain("/work/app.txt");
      expect(backend.delete).not.toHaveBeenCalled();
    });

    // Parity with Python `_wildcard_delete_overlap`'s ancestor analysis:
    // deleting `/work/app/child` under a deny on `/work/*` mutates the denied
    // `/work/app`, so it must be blocked even though the target itself does not
    // directly match the glob.
    it("denies deleting inside a directory whose ancestor matches a single-segment wildcard deny", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/work/*"])],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work/app/child",
      });

      expect(resultText(result)).toContain("permission denied for write");
      expect(resultText(result)).toContain("/work/*");
      expect(backend.delete).not.toHaveBeenCalled();
    });

    // A sibling-file glob still cannot match anything under an unrelated
    // sibling directory, so the delete proceeds.
    it("allows deleting inside a sibling directory a file glob cannot reach", async () => {
      const backend = createMockBackend();
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/work/*.log"])],
      });

      await getTool(middleware, "delete").invoke({
        file_path: "/work/notes/today.txt",
      });

      expect(backend.delete).toHaveBeenCalledWith("/work/notes/today.txt");
    });

    // Integration: exercise the whole probe -> permission -> backend.delete path
    // against a real stateful backend and assert files are actually removed or
    // preserved (mirrors Python's TestRecursiveDeletePermissions, which uses a
    // real FilesystemBackend).
    it("recursively deletes and removes all nested files when only an unrelated subtree is denied", async () => {
      const backend = createInMemoryBackend([
        "/work/a.txt",
        "/work/sub/b.txt",
      ]) as BackendProtocolV2 & { __files: Set<string> };
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/other/**"])],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work",
      });

      expect(resultText(result)).toContain("Deleted");
      expect(backend.__files.has("/work/a.txt")).toBe(false);
      expect(backend.__files.has("/work/sub/b.txt")).toBe(false);
    });

    it("blocks the delete and preserves files when a descendant is denied", async () => {
      const backend = createInMemoryBackend([
        "/work/a.txt",
        "/work/secrets/key.txt",
      ]) as BackendProtocolV2 & { __files: Set<string> };
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/work/secrets/**"])],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work",
      });

      expect(resultText(result)).toContain("permission denied for write");
      // Nothing was removed — both files survive the denied recursive delete.
      expect(backend.__files.has("/work/a.txt")).toBe(true);
      expect(backend.__files.has("/work/secrets/key.txt")).toBe(true);
    });

    it("reports every overlapping deny pattern in the error message", async () => {
      const backend = createInMemoryBackend([
        "/work/a.txt",
      ]) as BackendProtocolV2 & { __files: Set<string> };
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [denyWrite(["/work/secrets/**", "/work/logs/**"])],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work",
      });

      const text = resultText(result);
      expect(text).toContain("permission denied for write");
      expect(text).toContain("/work/secrets/**");
      expect(text).toContain("/work/logs/**");
      expect(backend.__files.has("/work/a.txt")).toBe(true);
    });

    // Flat backend: an exact key IS the delete target but a nested descendant
    // also exists, so the probe must classify it as a subtree and the denied
    // descendant blocks the delete (mirrors Python's
    // test_flat_backend_exact_key_with_nested_descendant_still_blocked).
    it("blocks an exact-key delete when a nested descendant is denied on a flat backend", async () => {
      const backend = createInMemoryBackend([
        "/work/item",
        "/work/item/secrets/key",
      ]) as BackendProtocolV2 & { __files: Set<string> };
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [
          {
            operations: ["read", "write"] as const,
            paths: ["/work/item"],
            mode: "allow" as const,
          },
          {
            operations: ["read", "write"] as const,
            paths: ["/work/item/secrets/**"],
            mode: "deny" as const,
          },
        ],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work/item",
      });

      expect(resultText(result)).toContain("permission denied for write");
      expect(backend.delete).not.toHaveBeenCalled();
    });

    // Flat backend leaf detection: a confirmed plain file (no children in the
    // listing) is resolved via first-match-wins, so allow-before-deny permits
    // it (mirrors Python's
    // test_exact_file_delete_allowed_under_workspace_isolation_on_flat_backend).
    it("allows an exact-file delete under workspace isolation on a flat backend", async () => {
      const backend = createInMemoryBackend([
        "/work/a.txt",
      ]) as BackendProtocolV2 & { __files: Set<string> };
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [
          {
            operations: ["write"] as const,
            paths: ["/work/**"],
            mode: "allow" as const,
          },
          {
            operations: ["write"] as const,
            paths: ["/**"],
            mode: "deny" as const,
          },
        ],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work/a.txt",
      });

      expect(resultText(result)).toContain("Deleted");
      expect(backend.__files.has("/work/a.txt")).toBe(false);
    });

    // An empty directory has no children to list, so the probe cannot confirm
    // it is a leaf and must fall back to the conservative subtree check — a
    // catch-all deny then blocks it (mirrors Python's
    // test_empty_directory_delete_still_uses_conservative_ancestor_check).
    it("uses the conservative subtree check for an empty directory", async () => {
      // The empty directory is represented by a marker key ending in "/"; ls of
      // the target yields no children, and the parent listing shows it as a
      // subdirectory (is_dir), so it is treated as a possible subtree.
      const backend = createInMemoryBackend([
        "/work/empty/",
      ]) as BackendProtocolV2 & { __files: Set<string> };
      const middleware = createFilesystemMiddleware({
        backend,
        permissions: [
          {
            operations: ["read", "write"] as const,
            paths: ["/work/**"],
            mode: "allow" as const,
          },
          {
            operations: ["read", "write"] as const,
            paths: ["/**"],
            mode: "deny" as const,
          },
        ],
      });

      const result = await getTool(middleware, "delete").invoke({
        file_path: "/work/empty",
      });

      expect(resultText(result)).toContain("permission denied for write");
      expect(backend.delete).not.toHaveBeenCalled();
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

// Direct unit coverage of the pure delete permission helper, mirroring
// Python's TestFindDeleteDenyPatterns / TestFindDeleteDenyPatternsExactFile.
// findDeleteDenyPatterns returns every deny-write pattern whose glob overlaps
// the delete subtree (target + descendants); an empty result means allowed.
describe("findDeleteDenyPatterns", () => {
  const deny = (...paths: string[]) => ({
    operations: ["write"] as const,
    paths,
    mode: "deny" as const,
  });

  describe("overlap geometry (single deny pattern vs target)", () => {
    const cases: Array<{
      name: string;
      pattern: string;
      target: string;
      expected: string[];
    }> = [
      // no overlap -> permitted (empty result)
      {
        name: "unrelated subtree",
        pattern: "/other/**",
        target: "/work",
        expected: [],
      },
      {
        name: "sibling prefix glob",
        pattern: "/workshop/**",
        target: "/work",
        expected: [],
      },
      {
        name: "sibling prefix literal",
        pattern: "/work2",
        target: "/work",
        expected: [],
      },
      {
        name: "sibling leaf",
        pattern: "/work/secrets",
        target: "/work/logs",
        expected: [],
      },
      {
        name: "file glob does not block non-matching sibling",
        pattern: "/work/*.log",
        target: "/work/notes.txt",
        expected: [],
      },
      // single-component wildcard: an ancestor that matches the glob blocks
      // deleting its descendants (wildcard-denied dirs get the same protection
      // as literal-denied dirs)
      {
        name: "wildcard ancestor blocks descendant delete",
        pattern: "/work/*",
        target: "/work/app/child",
        expected: ["/work/*"],
      },
      {
        name: "file glob ancestor blocks descendant delete",
        pattern: "/work/*.log",
        target: "/work/app.log/child",
        expected: ["/work/*.log"],
      },
      {
        name: "wildcard ancestor blocks deep descendant delete",
        pattern: "/work/*",
        target: "/work/app/deep/nested",
        expected: ["/work/*"],
      },
      // directory wildcard after anchor: target below anchor fails closed
      {
        name: "dir wildcard blocks ancestor target",
        pattern: "/work/*/secrets",
        target: "/work/app",
        expected: ["/work/*/secrets"],
      },
      {
        name: "globstar wildcard blocks ancestor target",
        pattern: "/work/**/secrets",
        target: "/work/app",
        expected: ["/work/**/secrets"],
      },
      {
        name: "recursive glob blocks descendant that contains match",
        pattern: "/work/**/*.log",
        target: "/work/sub",
        expected: ["/work/**/*.log"],
      },
      // glob that matches the target itself -> blocked (linchpin for the
      // "allow non-matching sibling" path)
      {
        name: "file glob blocks matching target",
        pattern: "/work/*.log",
        target: "/work/app.log",
        expected: ["/work/*.log"],
      },
      {
        name: "single wildcard blocks matching child",
        pattern: "/work/*",
        target: "/work/app",
        expected: ["/work/*"],
      },
      {
        name: "brace glob blocks matching",
        pattern: "/work/{secrets,keys}",
        target: "/work/secrets",
        expected: ["/work/{secrets,keys}"],
      },
      {
        name: "charclass glob blocks matching",
        pattern: "/work/[ab].txt",
        target: "/work/a.txt",
        expected: ["/work/[ab].txt"],
      },
      {
        name: "question glob non-matching sibling allowed",
        pattern: "/work/f?le.txt",
        target: "/work/other.txt",
        expected: [],
      },
      // overlap in either direction -> blocked
      {
        name: "exact file",
        pattern: "/work/a.txt",
        target: "/work/a.txt",
        expected: ["/work/a.txt"],
      },
      {
        name: "exact dir literal",
        pattern: "/work",
        target: "/work",
        expected: ["/work"],
      },
      {
        name: "descendant pattern blocks ancestor target",
        pattern: "/work/secrets/**",
        target: "/work",
        expected: ["/work/secrets/**"],
      },
      {
        name: "ancestor glob blocks descendant target",
        pattern: "/work/**",
        target: "/work/logs",
        expected: ["/work/**"],
      },
      {
        name: "ancestor literal blocks descendant target",
        pattern: "/work",
        target: "/work/sub/deep",
        expected: ["/work"],
      },
      {
        name: "bare directory pattern",
        pattern: "/work/secrets",
        target: "/work",
        expected: ["/work/secrets"],
      },
      // wildcard / root anchors
      {
        name: "root target blocked by any rule",
        pattern: "/anything/**",
        target: "/",
        expected: ["/anything/**"],
      },
      {
        name: "leading wildcard anchor is root",
        pattern: "/**/secrets",
        target: "/work",
        expected: ["/**/secrets"],
      },
      // trailing-slash normalization (both sides)
      {
        name: "target trailing slash",
        pattern: "/work/**",
        target: "/work/",
        expected: ["/work/**"],
      },
      {
        name: "pattern trailing slash",
        pattern: "/work/",
        target: "/work/sub",
        expected: ["/work/"],
      },
      {
        name: "both trailing slash",
        pattern: "/work/",
        target: "/work/",
        expected: ["/work/"],
      },
    ];

    it.each(cases)("$name", ({ pattern, target, expected }) => {
      expect(findDeleteDenyPatterns([deny(pattern)], target)).toEqual(expected);
    });
  });

  describe("mode and operation filtering (only deny+write count)", () => {
    // The target always overlaps the pattern; only the rule's mode/operations
    // decide the outcome. JS permissions have no "interrupt" mode (unlike
    // Python), so that case is intentionally omitted.
    const cases: Array<{
      name: string;
      operations: readonly ("read" | "write")[];
      mode: "allow" | "deny";
      expected: string[];
    }> = [
      {
        name: "write deny blocks",
        operations: ["write"],
        mode: "deny",
        expected: ["/work/**"],
      },
      {
        name: "read+write deny blocks",
        operations: ["read", "write"],
        mode: "deny",
        expected: ["/work/**"],
      },
      {
        name: "allow ignored",
        operations: ["write"],
        mode: "allow",
        expected: [],
      },
      {
        name: "read-only deny ignored",
        operations: ["read"],
        mode: "deny",
        expected: [],
      },
    ];

    it.each(cases)("$name", ({ operations, mode, expected }) => {
      expect(
        findDeleteDenyPatterns(
          [{ operations, paths: ["/work/**"], mode }],
          "/work",
        ),
      ).toEqual(expected);
    });
  });

  describe("multiple rule aggregation", () => {
    it("returns [] with no permissions", () => {
      expect(findDeleteDenyPatterns([], "/work")).toEqual([]);
    });

    it("collects overlapping patterns across multiple rules in order", () => {
      expect(
        findDeleteDenyPatterns(
          [deny("/work/a/**"), deny("/work/b/**")],
          "/work",
        ),
      ).toEqual(["/work/a/**", "/work/b/**"]);
    });

    it("filters non-overlapping paths within a single rule", () => {
      expect(
        findDeleteDenyPatterns(
          [deny("/work/a/**", "/work/b/**", "/other/**")],
          "/work",
        ),
      ).toEqual(["/work/a/**", "/work/b/**"]);
    });

    it("returns all overlapping patterns with no cap", () => {
      const paths = Array.from({ length: 8 }, (_, i) => `/work/d${i}/**`);
      expect(
        findDeleteDenyPatterns(
          paths.map((p) => deny(p)),
          "/work",
        ),
      ).toEqual(paths);
    });

    it("deduplicates patterns in first-seen order", () => {
      expect(
        findDeleteDenyPatterns(
          [deny("/work/x/**"), deny("/work/x/**", "/work/y/**")],
          "/work",
        ),
      ).toEqual(["/work/x/**", "/work/y/**"]);
    });

    it("returns only overlapping patterns", () => {
      expect(
        findDeleteDenyPatterns(
          [deny("/other/**"), deny("/work/x/**"), deny("/elsewhere/**")],
          "/work",
        ),
      ).toEqual(["/work/x/**"]);
    });
  });

  describe("confirmed leaf resolves via first-match-wins (hasDescendants=false)", () => {
    const allowThenDeny = [
      {
        operations: ["write"] as const,
        paths: ["/work/**"],
        mode: "allow" as const,
      },
      { operations: ["write"] as const, paths: ["/**"], mode: "deny" as const },
    ];
    const denyThenAllow = [
      { operations: ["write"] as const, paths: ["/**"], mode: "deny" as const },
      {
        operations: ["write"] as const,
        paths: ["/work/**"],
        mode: "allow" as const,
      },
    ];

    it("earlier allow wins over a later catch-all deny", () => {
      expect(
        findDeleteDenyPatterns(allowThenDeny, "/work/a.txt", false),
      ).toEqual([]);
    });

    it("deny still blocks when it matches first", () => {
      expect(
        findDeleteDenyPatterns(denyThenAllow, "/work/a.txt", false),
      ).toEqual(["/**"]);
    });

    it("defaults to the conservative subtree check without hasDescendants", () => {
      expect(findDeleteDenyPatterns(allowThenDeny, "/work/a.txt")).toEqual([
        "/**",
      ]);
    });

    it("allows a non-matching deny rule", () => {
      expect(
        findDeleteDenyPatterns([deny("/other/**")], "/work/a.txt", false),
      ).toEqual([]);
    });
  });
});
