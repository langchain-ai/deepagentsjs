/**
 * Unit tests for the `permissions` field in CreateDeepAgentParams (Phase 3).
 *
 * The wiring under test is in agent.ts:
 *   createFilesystemMiddleware({ backend, permissions })
 *
 * Enforcement details are covered by fs.permissions.test.ts.
 * These tests verify: (1) the type accepts the field, (2) the default is
 * no-op (empty array), and (3) permissions passed to the agent flow correctly
 * to the filesystem middleware tools.
 */

import { describe, it, expect, vi } from "vitest";
import { createFilesystemMiddleware } from "../middleware/fs.js";
import type { CreateDeepAgentParams } from "../types.js";
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

// ─── CreateDeepAgentParams type ───────────────────────────────────────────────

describe("CreateDeepAgentParams permissions field", () => {
  it("accepts a permissions array", () => {
    const perm = {
      operations: ["read"] as const,
      paths: ["/secrets/**"],
      mode: "deny" as const,
    };
    const params: Partial<CreateDeepAgentParams> = {
      permissions: [perm],
    };
    expect(params.permissions).toHaveLength(1);
    expect(params.permissions![0]).toBe(perm);
  });

  it("permissions field is optional", () => {
    const params: Partial<CreateDeepAgentParams> = { name: "agent" };
    expect(params.permissions).toBeUndefined();
  });

  it("defaults to no restrictions when omitted (empty array = allow all)", () => {
    // Mirrors the default in createDeepAgent: permissions = []
    const params: Partial<CreateDeepAgentParams> = {};
    const effectivePermissions = params.permissions ?? [];
    expect(effectivePermissions).toEqual([]);
  });
});

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

    await expect(
      getTool(middleware, "read_file").invoke({
        file_path: "/secrets/key.txt",
      }),
    ).rejects.toThrow(/permission denied for read on \/secrets\/key\.txt/);
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

    await expect(
      getTool(middleware, "write_file").invoke({
        file_path: "/readonly/config.json",
        content: "data",
      }),
    ).rejects.toThrow(
      /permission denied for write on \/readonly\/config\.json/,
    );

    await expect(
      getTool(middleware, "read_file").invoke({
        file_path: "/readonly/config.json",
      }),
    ).resolves.toBeDefined();
  });
});
