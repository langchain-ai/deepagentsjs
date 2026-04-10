import { describe, it, expect, vi } from "vitest";
import { ToolMessage } from "langchain";
import {
  createFilesystemPermission,
  createPermissionMiddleware,
  checkFsPermission,
  filterPathsByPermission,
  validatePath,
  allPathsScopedToRoutes,
  supportsExecution,
  type FilesystemPermission,
} from "./permissions.js";
import { CompositeBackend } from "../backends/composite.js";
import type { BackendProtocolV2 } from "../backends/protocol.js";

function createMockBackend(): BackendProtocolV2 {
  return {
    ls: vi.fn(),
    read: vi.fn(),
    readRaw: vi.fn(),
    write: vi.fn(),
    edit: vi.fn(),
    grep: vi.fn(),
    glob: vi.fn(),
  } as unknown as BackendProtocolV2;
}

function createMockSandboxBackend(): BackendProtocolV2 & {
  execute: (...args: unknown[]) => unknown;
  id: string;
} {
  return {
    ls: vi.fn(),
    read: vi.fn(),
    readRaw: vi.fn(),
    write: vi.fn(),
    edit: vi.fn(),
    grep: vi.fn(),
    glob: vi.fn(),
    execute: vi.fn(),
    id: "mock-sandbox",
  } as unknown as BackendProtocolV2 & {
    execute: (...args: unknown[]) => unknown;
    id: string;
  };
}

function normalizeRule(
  rule: FilesystemPermission,
): Required<FilesystemPermission> {
  return createFilesystemPermission(rule);
}

describe("FilesystemPermission", () => {
  describe("createFilesystemPermission", () => {
    it("should default mode to allow", () => {
      const rule = createFilesystemPermission({
        operations: ["read"],
        paths: ["/workspace/**"],
      });
      expect(rule.mode).toBe("allow");
    });

    it("should accept deny mode", () => {
      const rule = createFilesystemPermission({
        operations: ["write"],
        paths: ["/**"],
        mode: "deny",
      });
      expect(rule.mode).toBe("deny");
    });

    it("should accept multiple operations", () => {
      const rule = createFilesystemPermission({
        operations: ["read", "write"],
        paths: ["/secrets/**"],
        mode: "deny",
      });
      expect(rule.operations).toContain("read");
      expect(rule.operations).toContain("write");
    });
  });

  describe("path validation", () => {
    it("should reject paths without leading slash", () => {
      expect(() =>
        createFilesystemPermission({
          operations: ["read"],
          paths: ["workspace/**"],
        }),
      ).toThrow("Permission path must start with '/'");
    });

    it("should reject mixed paths with missing slash", () => {
      expect(() =>
        createFilesystemPermission({
          operations: ["read"],
          paths: ["/valid/**", "invalid/**"],
        }),
      ).toThrow("Permission path must start with '/'");
    });

    it("should reject paths with dotdot traversal", () => {
      expect(() =>
        createFilesystemPermission({
          operations: ["read"],
          paths: ["/workspace/../secrets/**"],
        }),
      ).toThrow("must not contain '..'");
    });

    it("should reject paths with tilde", () => {
      expect(() =>
        createFilesystemPermission({
          operations: ["read"],
          paths: ["/~/data/**"],
        }),
      ).toThrow("must not contain '~'");
    });
  });
});

describe("checkFsPermission", () => {
  it("should return allow when no rules match", () => {
    expect(checkFsPermission([], "read", "/anything/goes.txt")).toBe("allow");
    expect(checkFsPermission([], "write", "/anything/goes.txt")).toBe("allow");
  });

  it("should deny matching paths", () => {
    const rules = [
      normalizeRule({
        operations: ["read"],
        paths: ["/secrets/**"],
        mode: "deny",
      }),
    ];
    expect(checkFsPermission(rules, "read", "/secrets/key.txt")).toBe("deny");
  });

  it("should allow non-matching paths", () => {
    const rules = [
      normalizeRule({
        operations: ["read"],
        paths: ["/secrets/**"],
        mode: "deny",
      }),
    ];
    expect(checkFsPermission(rules, "read", "/public/readme.txt")).toBe(
      "allow",
    );
  });

  it("should skip rules with non-matching operations", () => {
    const rules = [
      normalizeRule({
        operations: ["write"],
        paths: ["/**"],
        mode: "deny",
      }),
    ];
    expect(checkFsPermission(rules, "read", "/secrets/key.txt")).toBe("allow");
  });

  it("should use first-match-wins", () => {
    const rules = [
      normalizeRule({
        operations: ["read"],
        paths: ["/secrets/**"],
        mode: "deny",
      }),
      normalizeRule({
        operations: ["read"],
        paths: ["/secrets/**"],
        mode: "allow",
      }),
    ];
    expect(checkFsPermission(rules, "read", "/secrets/key.txt")).toBe("deny");
  });

  it("should match deeply nested paths with globstar", () => {
    const rules = [
      normalizeRule({
        operations: ["read"],
        paths: ["/vault/**"],
        mode: "deny",
      }),
    ];
    expect(checkFsPermission(rules, "read", "/vault/a/b/c/deep.txt")).toBe(
      "deny",
    );
    expect(checkFsPermission(rules, "read", "/other/file.txt")).toBe("allow");
  });

  it("should support multiple paths in one rule", () => {
    const rules = [
      normalizeRule({
        operations: ["read"],
        paths: ["/secrets/**", "/private/**"],
        mode: "deny",
      }),
    ];
    expect(checkFsPermission(rules, "read", "/secrets/key.txt")).toBe("deny");
    expect(checkFsPermission(rules, "read", "/private/data.bin")).toBe("deny");
    expect(checkFsPermission(rules, "read", "/public/readme.txt")).toBe(
      "allow",
    );
  });

  it("should support brace expansion", () => {
    const rules = [
      normalizeRule({
        operations: ["read"],
        paths: ["/data/{a,b}.txt"],
        mode: "deny",
      }),
    ];
    expect(checkFsPermission(rules, "read", "/data/a.txt")).toBe("deny");
    expect(checkFsPermission(rules, "read", "/data/b.txt")).toBe("deny");
    expect(checkFsPermission(rules, "read", "/data/c.txt")).toBe("allow");
  });
});

describe("filterPathsByPermission", () => {
  it("should return all paths when no rules", () => {
    const paths = ["/a/file.txt", "/b/file.txt"];
    expect(filterPathsByPermission([], "read", paths)).toEqual(paths);
  });

  it("should filter denied paths", () => {
    const rules = [
      normalizeRule({
        operations: ["read"],
        paths: ["/secrets/**"],
        mode: "deny",
      }),
    ];
    const paths = ["/workspace/a.txt", "/secrets/key.txt", "/workspace/b.txt"];
    const result = filterPathsByPermission(rules, "read", paths);
    expect(result).not.toContain("/secrets/key.txt");
    expect(result).toContain("/workspace/a.txt");
    expect(result).toContain("/workspace/b.txt");
  });

  it("should return empty when all denied", () => {
    const rules = [
      normalizeRule({
        operations: ["read"],
        paths: ["/**"],
        mode: "deny",
      }),
    ];
    expect(
      filterPathsByPermission(rules, "read", ["/a.txt", "/b.txt"]),
    ).toEqual([]);
  });

  it("should not filter when operation doesn't match", () => {
    const rules = [
      normalizeRule({
        operations: ["write"],
        paths: ["/**"],
        mode: "deny",
      }),
    ];
    const paths = ["/a.txt", "/b.txt"];
    expect(filterPathsByPermission(rules, "read", paths)).toEqual(paths);
  });
});

describe("validatePath", () => {
  it("should normalize redundant separators", () => {
    expect(validatePath("/secrets//key.txt")).toBe("/secrets/key.txt");
  });

  it("should reject dotdot traversal", () => {
    expect(() => validatePath("/workspace/../secrets/key.txt")).toThrow(
      "Path traversal not allowed",
    );
  });

  it("should pass normal paths through", () => {
    expect(validatePath("/workspace/file.txt")).toBe("/workspace/file.txt");
  });
});

describe("allPathsScopedToRoutes", () => {
  it("should return false for non-composite backends", () => {
    const rules = [
      normalizeRule({
        operations: ["read"],
        paths: ["/memories/**"],
        mode: "deny",
      }),
    ];
    expect(allPathsScopedToRoutes(rules, createMockBackend())).toBe(false);
  });

  it("should return true when all paths are under routes", () => {
    const sandbox = createMockSandboxBackend();
    const routeStore = createMockBackend();
    const composite = new CompositeBackend(sandbox, {
      "/memories/": routeStore,
    });
    const rules = [
      normalizeRule({
        operations: ["write"],
        paths: ["/memories/**"],
        mode: "deny",
      }),
    ];
    expect(allPathsScopedToRoutes(rules, composite)).toBe(true);
  });

  it("should return false when paths are outside routes", () => {
    const sandbox = createMockSandboxBackend();
    const routeStore = createMockBackend();
    const composite = new CompositeBackend(sandbox, {
      "/memories/": routeStore,
    });
    const rules = [
      normalizeRule({
        operations: ["write"],
        paths: ["/workspace/**"],
        mode: "deny",
      }),
    ];
    expect(allPathsScopedToRoutes(rules, composite)).toBe(false);
  });

  it("should return false for wildcard paths", () => {
    const sandbox = createMockSandboxBackend();
    const routeStore = createMockBackend();
    const composite = new CompositeBackend(sandbox, {
      "/memories/": routeStore,
    });
    const rules = [
      normalizeRule({
        operations: ["read"],
        paths: ["/**"],
        mode: "deny",
      }),
    ];
    expect(allPathsScopedToRoutes(rules, composite)).toBe(false);
  });

  it("should return false for factory backends", () => {
    const rules = [
      normalizeRule({
        operations: ["read"],
        paths: ["/memories/**"],
        mode: "deny",
      }),
    ];
    expect(
      allPathsScopedToRoutes(rules, () => createMockBackend() as any),
    ).toBe(false);
  });
});

describe("supportsExecution", () => {
  it("should return false for non-sandbox backends", () => {
    expect(supportsExecution(createMockBackend())).toBe(false);
  });

  it("should return true for sandbox backends", () => {
    expect(supportsExecution(createMockSandboxBackend())).toBe(true);
  });

  it("should return false for factory backends", () => {
    expect(supportsExecution(() => createMockBackend() as any)).toBe(false);
  });

  it("should return true for composite with sandbox default", () => {
    const sandbox = createMockSandboxBackend();
    const composite = new CompositeBackend(sandbox, {});
    expect(supportsExecution(composite)).toBe(true);
  });

  it("should return false for composite with non-sandbox default", () => {
    const composite = new CompositeBackend(createMockBackend(), {});
    expect(supportsExecution(composite)).toBe(false);
  });
});

describe("createPermissionMiddleware", () => {
  it("should throw for sandbox backends with non-route-scoped permissions", () => {
    const sandbox = createMockSandboxBackend();
    expect(() =>
      createPermissionMiddleware({
        rules: [{ operations: ["write"], paths: ["/**"], mode: "deny" }],
        backend: sandbox,
      }),
    ).toThrow("does not yet support backends with command execution");
  });

  it("should throw for composite with sandbox default and non-route-scoped permissions", () => {
    const sandbox = createMockSandboxBackend();
    const composite = new CompositeBackend(sandbox, {});
    expect(() =>
      createPermissionMiddleware({
        rules: [{ operations: ["write"], paths: ["/**"], mode: "deny" }],
        backend: composite,
      }),
    ).toThrow("does not yet support backends with command execution");
  });

  it("should allow composite with sandbox default when permissions are route-scoped", () => {
    const sandbox = createMockSandboxBackend();
    const routeStore = createMockBackend();
    const composite = new CompositeBackend(sandbox, {
      "/memories/": routeStore,
    });
    expect(() =>
      createPermissionMiddleware({
        rules: [
          { operations: ["write"], paths: ["/memories/**"], mode: "deny" },
        ],
        backend: composite,
      }),
    ).not.toThrow();
  });

  it("should allow non-sandbox backends", () => {
    expect(() =>
      createPermissionMiddleware({
        rules: [{ operations: ["read"], paths: ["/secrets/**"], mode: "deny" }],
        backend: createMockBackend(),
      }),
    ).not.toThrow();
  });

  it("should allow composite without sandbox default", () => {
    const composite = new CompositeBackend(createMockBackend(), {});
    expect(() =>
      createPermissionMiddleware({
        rules: [{ operations: ["read"], paths: ["/secrets/**"], mode: "deny" }],
        backend: composite,
      }),
    ).not.toThrow();
  });

  describe("wrapToolCall pre-check", () => {
    it("should deny read on restricted path", async () => {
      const middleware = createPermissionMiddleware({
        rules: [{ operations: ["read"], paths: ["/secrets/**"], mode: "deny" }],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const request = {
        toolCall: {
          name: "read_file",
          id: "tc1",
          args: { file_path: "/secrets/key.txt" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => {
        return new ToolMessage({
          content: "should not reach",
          tool_call_id: "tc1",
        });
      });

      expect(ToolMessage.isInstance(result)).toBe(true);
      expect((result as ToolMessage).content).toContain("permission denied");
      expect((result as ToolMessage).content).toContain("read");
    });

    it("should allow read on non-restricted path", async () => {
      const middleware = createPermissionMiddleware({
        rules: [{ operations: ["read"], paths: ["/secrets/**"], mode: "deny" }],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const expected = new ToolMessage({
        content: "file content",
        tool_call_id: "tc1",
      });
      const request = {
        toolCall: {
          name: "read_file",
          id: "tc1",
          args: { file_path: "/workspace/file.txt" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => expected);
      expect(result).toBe(expected);
    });

    it("should deny write on restricted path", async () => {
      const middleware = createPermissionMiddleware({
        rules: [{ operations: ["write"], paths: ["/**"], mode: "deny" }],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const request = {
        toolCall: {
          name: "write_file",
          id: "tc1",
          args: { file_path: "/foo.txt", content: "data" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => {
        return new ToolMessage({
          content: "should not reach",
          tool_call_id: "tc1",
        });
      });

      expect(ToolMessage.isInstance(result)).toBe(true);
      expect((result as ToolMessage).content).toContain("permission denied");
      expect((result as ToolMessage).content).toContain("write");
    });

    it("should allow unrelated tools", async () => {
      const middleware = createPermissionMiddleware({
        rules: [{ operations: ["read"], paths: ["/secrets/**"], mode: "deny" }],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const expected = new ToolMessage({
        content: "content",
        tool_call_id: "tc1",
      });
      const request = {
        toolCall: {
          name: "some_other_tool",
          id: "tc1",
          args: { input: "hello" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => expected);
      expect(result).toBe(expected);
    });

    it("should deny edit on restricted path", async () => {
      const middleware = createPermissionMiddleware({
        rules: [
          { operations: ["write"], paths: ["/protected/**"], mode: "deny" },
        ],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const request = {
        toolCall: {
          name: "edit_file",
          id: "tc1",
          args: {
            file_path: "/protected/file.txt",
            old_string: "original",
            new_string: "changed",
          },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => {
        return new ToolMessage({
          content: "should not reach",
          tool_call_id: "tc1",
        });
      });

      expect(ToolMessage.isInstance(result)).toBe(true);
      expect((result as ToolMessage).content).toContain("permission denied");
    });

    it("should deny ls on restricted path", async () => {
      const middleware = createPermissionMiddleware({
        rules: [
          {
            operations: ["read"],
            paths: ["/secrets/**", "/secrets"],
            mode: "deny",
          },
        ],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const request = {
        toolCall: {
          name: "ls",
          id: "tc1",
          args: { path: "/secrets" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => {
        return new ToolMessage({
          content: "should not reach",
          tool_call_id: "tc1",
        });
      });

      expect(ToolMessage.isInstance(result)).toBe(true);
      expect((result as ToolMessage).content).toContain("permission denied");
    });

    it("should deny glob on restricted base path", async () => {
      const middleware = createPermissionMiddleware({
        rules: [
          {
            operations: ["read"],
            paths: ["/secrets/**", "/secrets"],
            mode: "deny",
          },
        ],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const request = {
        toolCall: {
          name: "glob",
          id: "tc1",
          args: { pattern: "*.txt", path: "/secrets" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => {
        return new ToolMessage({
          content: "should not reach",
          tool_call_id: "tc1",
        });
      });

      expect(ToolMessage.isInstance(result)).toBe(true);
      expect((result as ToolMessage).content).toContain("permission denied");
    });

    it("should deny grep on restricted path", async () => {
      const middleware = createPermissionMiddleware({
        rules: [
          {
            operations: ["read"],
            paths: ["/secrets/**", "/secrets"],
            mode: "deny",
          },
        ],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const request = {
        toolCall: {
          name: "grep",
          id: "tc1",
          args: { pattern: "secret", path: "/secrets" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => {
        return new ToolMessage({
          content: "should not reach",
          tool_call_id: "tc1",
        });
      });

      expect(ToolMessage.isInstance(result)).toBe(true);
      expect((result as ToolMessage).content).toContain("permission denied");
    });

    it("should deny read allows write", async () => {
      const middleware = createPermissionMiddleware({
        rules: [{ operations: ["read"], paths: ["/vault/**"], mode: "deny" }],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const expected = new ToolMessage({
        content: "written",
        tool_call_id: "tc1",
      });
      const request = {
        toolCall: {
          name: "write_file",
          id: "tc1",
          args: { file_path: "/vault/file.txt", content: "data" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => expected);
      expect(result).toBe(expected);
    });
  });

  describe("wrapToolCall post-filter", () => {
    it("should filter denied paths from ls results", async () => {
      const middleware = createPermissionMiddleware({
        rules: [{ operations: ["read"], paths: ["/secrets/**"], mode: "deny" }],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const request = {
        toolCall: {
          name: "ls",
          id: "tc1",
          args: { path: "/" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => {
        return new ToolMessage({
          content:
            "/public (directory)\n/secrets (directory)\n/workspace (directory)",
          tool_call_id: "tc1",
          name: "ls",
        });
      });

      expect(ToolMessage.isInstance(result)).toBe(true);
      const content = (result as ToolMessage).content as string;
      expect(content).toContain("/public");
      expect(content).toContain("/workspace");
      expect(content).not.toContain("/secrets");
    });

    it("should filter denied paths from glob results", async () => {
      const middleware = createPermissionMiddleware({
        rules: [{ operations: ["read"], paths: ["/secrets/**"], mode: "deny" }],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const request = {
        toolCall: {
          name: "glob",
          id: "tc1",
          args: { pattern: "**/*.txt", path: "/" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => {
        return new ToolMessage({
          content: "/public/a.txt\n/secrets/b.txt\n/workspace/c.txt",
          tool_call_id: "tc1",
          name: "glob",
        });
      });

      expect(ToolMessage.isInstance(result)).toBe(true);
      const content = (result as ToolMessage).content as string;
      expect(content).toContain("/public/a.txt");
      expect(content).toContain("/workspace/c.txt");
      expect(content).not.toContain("/secrets");
    });

    it("should filter denied paths from grep results", async () => {
      const middleware = createPermissionMiddleware({
        rules: [{ operations: ["read"], paths: ["/secrets/**"], mode: "deny" }],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const request = {
        toolCall: {
          name: "grep",
          id: "tc1",
          args: { pattern: "keyword" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => {
        return new ToolMessage({
          content:
            "\n/public/a.txt:\n  1: keyword here\n\n/secrets/b.txt:\n  1: keyword there",
          tool_call_id: "tc1",
          name: "grep",
        });
      });

      expect(ToolMessage.isInstance(result)).toBe(true);
      const content = (result as ToolMessage).content as string;
      expect(content).toContain("/public/a.txt");
      expect(content).not.toContain("/secrets");
    });

    it("should not filter when all paths are allowed", async () => {
      const middleware = createPermissionMiddleware({
        rules: [{ operations: ["write"], paths: ["/**"], mode: "deny" }],
        backend: createMockBackend(),
      });

      const wrapToolCall = (middleware as any).wrapToolCall;
      const expected = new ToolMessage({
        content: "/public/a.txt\n/public/b.txt",
        tool_call_id: "tc1",
        name: "glob",
      });
      const request = {
        toolCall: {
          name: "glob",
          id: "tc1",
          args: { pattern: "**/*.txt", path: "/" },
        },
        runtime: {},
        state: {},
      };

      const result = await wrapToolCall(request, async () => expected);
      expect(result).toBe(expected);
    });
  });
});
