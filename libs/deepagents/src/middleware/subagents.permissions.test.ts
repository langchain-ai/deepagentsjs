/**
 * Unit tests for subagent permission overrides (Phase 4).
 *
 * The core logic under test is the `input.permissions ?? parentPermissions`
 * expression inside `normalizeSubagentSpec` in agent.ts.  Rather than
 * exercising the full agent invocation stack, these tests verify:
 *
 * 1. The SubAgent interface accepts `permissions` as an optional field.
 * 2. The `??` nullish-coalescing semantics work correctly:
 *    - undefined → inherits parent permissions
 *    - [] (empty array) → overrides, allows everything
 *    - [deny rule] → overrides, applies subagent-specific rules
 * 3. createFilesystemMiddleware enforces whichever permissions array
 *    is passed, confirming the wiring is correct.
 */

import { describe, it, expect, vi } from "vitest";
import { createFilesystemMiddleware } from "./fs.js";
import type { FilesystemPermission } from "../permissions/types.js";
import type { SubAgent } from "./subagents.js";
import type { BackendProtocolV2 } from "../backends/protocol.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

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
  const t = middleware.tools!.find((t: any) => t.name === name) as any;
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

/** Mirrors the expression in normalizeSubagentSpec. */
function resolvePermissions(
  subagentPermissions: FilesystemPermission[] | undefined,
  parentPermissions: FilesystemPermission[],
): FilesystemPermission[] {
  return subagentPermissions ?? parentPermissions;
}

// ─── SubAgent type accepts permissions field ──────────────────────────────────

describe("SubAgent interface", () => {
  it("accepts a permissions field", () => {
    const perm: FilesystemPermission = {
      operations: ["read"],
      paths: ["/secrets/**"],
      mode: "deny",
    };
    const subagent: SubAgent = {
      name: "reader",
      description: "reads things",
      systemPrompt: "You are a reader.",
      permissions: [perm],
    };
    expect(subagent.permissions).toHaveLength(1);
    expect(subagent.permissions![0]).toBe(perm);
  });

  it("omitting permissions is valid (field is optional)", () => {
    const subagent: SubAgent = {
      name: "worker",
      description: "does work",
      systemPrompt: "You are a worker.",
    };
    expect(subagent.permissions).toBeUndefined();
  });
});

// ─── resolvePermissions (mirrors normalizeSubagentSpec logic) ─────────────────

describe("effective permissions resolution", () => {
  const parentDeny: FilesystemPermission[] = [
    { operations: ["read"], paths: ["/secrets/**"], mode: "deny" },
  ];

  it("inherits parent permissions when subagent.permissions is undefined", () => {
    const effective = resolvePermissions(undefined, parentDeny);
    expect(effective).toBe(parentDeny);
  });

  it("overrides with empty array when subagent.permissions is []", () => {
    const effective = resolvePermissions([], parentDeny);
    expect(effective).toEqual([]);
    expect(effective).not.toBe(parentDeny);
  });

  it("overrides with subagent's own rules when subagent.permissions is non-empty", () => {
    const subagentDeny: FilesystemPermission[] = [
      { operations: ["write"], paths: ["/readonly/**"], mode: "deny" },
    ];
    const effective = resolvePermissions(subagentDeny, parentDeny);
    expect(effective).toBe(subagentDeny);
  });

  it("uses parent permissions even when parent is empty and subagent has no override", () => {
    const effective = resolvePermissions(undefined, []);
    expect(effective).toEqual([]);
  });
});

// ─── createFilesystemMiddleware enforces effective permissions ────────────────

describe("createFilesystemMiddleware with effective permissions", () => {
  const parentDeny: FilesystemPermission[] = [
    { operations: ["read"], paths: ["/secrets/**"], mode: "deny" },
  ];

  it("inherited deny rule blocks read on subagent fs tools", async () => {
    // Subagent has no permissions override → inherits parent deny
    const effective = resolvePermissions(undefined, parentDeny);
    const middleware = createFilesystemMiddleware({
      backend: createMockBackend(),
      permissions: effective,
    });

    await expect(
      getTool(middleware, "read_file").invoke({
        file_path: "/secrets/key.txt",
      }),
    ).rejects.toThrow(/permission denied for read on \/secrets\/key\.txt/);
  });

  it("empty override allows reads that parent would have denied", async () => {
    const backend = createMockBackend();
    backend.read = vi
      .fn()
      .mockResolvedValue({ content: "secret", mimeType: "text/plain" });

    // Subagent has permissions: [] → no restrictions
    const effective = resolvePermissions([], parentDeny);
    const middleware = createFilesystemMiddleware({
      backend,
      permissions: effective,
    });

    await expect(
      getTool(middleware, "read_file").invoke({
        file_path: "/secrets/key.txt",
      }),
    ).resolves.toBeDefined();
    expect(backend.read).toHaveBeenCalledWith("/secrets/key.txt", 0, 100);
  });

  it("subagent-specific deny rule blocks paths the parent allows", async () => {
    // Parent allows everything; subagent restricts /restricted/**
    const subagentDeny: FilesystemPermission[] = [
      { operations: ["read"], paths: ["/restricted/**"], mode: "deny" },
    ];
    const effective = resolvePermissions(subagentDeny, []); // parent: no rules
    const middleware = createFilesystemMiddleware({
      backend: createMockBackend(),
      permissions: effective,
    });

    await expect(
      getTool(middleware, "read_file").invoke({
        file_path: "/restricted/data.txt",
      }),
    ).rejects.toThrow(/permission denied for read on \/restricted\/data\.txt/);
  });

  it("subagent-specific deny rule does not affect parent-allowed paths", async () => {
    const backend = createMockBackend();
    backend.read = vi
      .fn()
      .mockResolvedValue({ content: "public", mimeType: "text/plain" });

    const subagentDeny: FilesystemPermission[] = [
      { operations: ["read"], paths: ["/restricted/**"], mode: "deny" },
    ];
    const effective = resolvePermissions(subagentDeny, []);
    const middleware = createFilesystemMiddleware({
      backend,
      permissions: effective,
    });

    await expect(
      getTool(middleware, "read_file").invoke({
        file_path: "/workspace/ok.txt",
      }),
    ).resolves.toBeDefined();
    expect(backend.read).toHaveBeenCalled();
  });

  it("inherited deny rule does not block fs tools after permissions: [] override", async () => {
    // Another variant confirming the override is a full replacement
    const backend = createMockBackend();
    backend.write = vi.fn().mockResolvedValue({ error: null });

    const effective = resolvePermissions([], parentDeny);
    const middleware = createFilesystemMiddleware({
      backend,
      permissions: effective,
    });

    await expect(
      getTool(middleware, "write_file").invoke({
        file_path: "/secrets/new.txt",
        content: "data",
      }),
    ).resolves.toBeDefined();
    expect(backend.write).toHaveBeenCalled();
  });
});
