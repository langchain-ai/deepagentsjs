/**
 * Tests that permissions passed to createDeepAgent flow correctly to the
 * filesystem middleware tools. Enforcement details are covered by
 * fs.permissions.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { createFilesystemMiddleware } from "../middleware/fs.js";
import type { BackendProtocolV2 } from "../backends/protocol.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function createMockBackend(): BackendProtocolV2 {
  return {
    ls: vi.fn().mockResolvedValue({ files: [] }),
    read: vi
      .fn()
      .mockResolvedValue({ content: "content", mimeType: "text/plain" }),
    write: vi.fn().mockResolvedValue({ error: null }),
    edit: vi.fn().mockResolvedValue({ error: null, occurrences: 1 }),
    glob: vi.fn().mockResolvedValue({ files: [] }),
    grep: vi.fn().mockResolvedValue({ matches: [] }),
  } as unknown as BackendProtocolV2;
}

function getTool(
  middleware: ReturnType<typeof createFilesystemMiddleware>,
  name: string,
) {
  const t = middleware.tools!.find((t: any) => t.name === name) as any;
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

/** Normalize a tool result (string, or a ToolMessage's content) to text. */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    const { content } = result as { content: unknown };
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  return JSON.stringify(result);
}

// ─── permissions flow to createFilesystemMiddleware ───────────────────────────

describe("permissions wired to filesystem middleware", () => {
  it("deny rule blocks the relevant fs tool", async () => {
    // Mirrors: createFilesystemMiddleware({ backend, permissions })
    const middleware = createFilesystemMiddleware({
      backend: createMockBackend(),
      permissions: [
        {
          operations: ["read"] as const,
          paths: ["/secrets/**"],
          mode: "deny" as const,
        },
      ],
    });

    const result = await getTool(middleware, "read_file").invoke({
      file_path: "/secrets/key.txt",
    });
    expect(resultText(result)).toMatch(
      /permission denied for read on \/secrets\/key\.txt/,
    );
  });

  it("empty permissions array allows all operations", async () => {
    const backend = createMockBackend();
    backend.read = vi
      .fn()
      .mockResolvedValue({ content: "data", mimeType: "text/plain" });

    const middleware = createFilesystemMiddleware({
      backend,
      permissions: [], // default from createDeepAgent when none specified
    });

    await expect(
      getTool(middleware, "read_file").invoke({
        file_path: "/any/path.txt",
      }),
    ).resolves.toBeDefined();
    expect(backend.read).toHaveBeenCalled();
  });

  it("write deny rule blocks write_file without affecting read_file", async () => {
    const backend = createMockBackend();
    backend.read = vi
      .fn()
      .mockResolvedValue({ content: "ok", mimeType: "text/plain" });

    const middleware = createFilesystemMiddleware({
      backend,
      permissions: [
        {
          operations: ["write"] as const,
          paths: ["/readonly/**"],
          mode: "deny" as const,
        },
      ],
    });

    const writeResult = await getTool(middleware, "write_file").invoke({
      file_path: "/readonly/config.json",
      content: "data",
    });
    expect(resultText(writeResult)).toMatch(
      /permission denied for write on \/readonly\/config\.json/,
    );

    await expect(
      getTool(middleware, "read_file").invoke({
        file_path: "/readonly/config.json",
      }),
    ).resolves.toBeDefined();
  });
});
