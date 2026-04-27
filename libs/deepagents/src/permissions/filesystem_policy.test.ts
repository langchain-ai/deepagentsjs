import { describe, it, expect } from "vitest";
import { FilesystemPolicy } from "./filesystem_policy.js";
import { FilesystemPermission } from "./types.js";
import { FS_PERMISSIONS_RUNTIME_KEY } from "./runtime.js";
import type { ToolPolicyContext } from "@langchain/core/tools";

function makeCtx<T = unknown>(
  args: T,
  rules: FilesystemPermission[],
): ToolPolicyContext<T> {
  return {
    toolName: "test_tool",
    args,
    config: {
      configurable: {
        [FS_PERMISSIONS_RUNTIME_KEY]: rules,
      },
    },
  };
}

describe("FilesystemPolicy", () => {
  describe("beforeInvoke", () => {
    const writePolicy = new FilesystemPolicy<{ file_path: string }, unknown>({
      operation: "write",
      paths: (a) => [a.file_path],
    });

    it("allows when no rules are configured", async () => {
      const ctx = makeCtx({ file_path: "/secrets/key.txt" }, []);
      await expect(writePolicy.beforeInvoke!(ctx)).resolves.toBeUndefined();
    });

    it("allows when rules permit the path", async () => {
      const rule = new FilesystemPermission({
        operations: ["write"],
        paths: ["/workspace/**"],
        mode: "allow",
      });
      const ctx = makeCtx({ file_path: "/workspace/foo.ts" }, [rule]);
      await expect(writePolicy.beforeInvoke!(ctx)).resolves.toBeUndefined();
    });

    it("throws when rules deny the path", async () => {
      const rule = new FilesystemPermission({
        operations: ["write"],
        paths: ["/secrets/**"],
        mode: "deny",
      });
      const ctx = makeCtx({ file_path: "/secrets/key.txt" }, [rule]);
      await expect(writePolicy.beforeInvoke!(ctx)).rejects.toThrow(
        "permission denied for write on /secrets/key.txt",
      );
    });

    it("is a no-op when config has no configurable", async () => {
      const ctx: ToolPolicyContext<{ file_path: string }> = {
        toolName: "test_tool",
        args: { file_path: "/secrets/key.txt" },
        config: {},
      };
      await expect(writePolicy.beforeInvoke!(ctx)).resolves.toBeUndefined();
    });

    it("skips invalid paths and defers to tool validation", async () => {
      const rule = new FilesystemPermission({
        operations: ["write"],
        paths: ["/**"],
        mode: "deny",
      });
      const policy = new FilesystemPolicy<{ file_path: string }, unknown>({
        operation: "write",
        paths: (a) => [a.file_path],
      });
      const ctx = makeCtx({ file_path: "relative-path" }, [rule]);
      await expect(policy.beforeInvoke!(ctx)).resolves.toBeUndefined();
    });

    it("checks all paths from the extractor", async () => {
      const rule = new FilesystemPermission({
        operations: ["write"],
        paths: ["/secrets/**"],
        mode: "deny",
      });
      const multiPathPolicy = new FilesystemPolicy<
        { paths: string[] },
        unknown
      >({
        operation: "write",
        paths: (a) => a.paths,
      });
      const ctx = makeCtx({ paths: ["/workspace/ok.ts", "/secrets/bad.txt"] }, [
        rule,
      ]);
      await expect(multiPathPolicy.beforeInvoke!(ctx)).rejects.toThrow(
        "permission denied",
      );
    });

    it("returns empty array from paths extractor is a no-op", async () => {
      const rule = new FilesystemPermission({
        operations: ["read"],
        paths: ["/**"],
        mode: "deny",
      });
      const policy = new FilesystemPolicy<{ path?: string }, unknown>({
        operation: "read",
        paths: (a) => (a.path === undefined ? [] : [a.path]),
      });
      const ctx = makeCtx({ path: undefined }, [rule]);
      await expect(policy.beforeInvoke!(ctx)).resolves.toBeUndefined();
    });
  });

  describe("afterInvoke", () => {
    it("passes output through when no filter is defined", async () => {
      const policy = new FilesystemPolicy<unknown, string>({
        operation: "read",
        paths: () => [],
      });
      const rule = new FilesystemPermission({
        operations: ["read"],
        paths: ["/secrets/**"],
        mode: "deny",
      });
      const ctx = makeCtx({}, [rule]);
      const result = await policy.afterInvoke!("output", ctx);
      expect(result).toBe("output");
    });

    it("passes output through when no rules are configured", async () => {
      const policy = new FilesystemPolicy<unknown, { entries: string[] }>({
        operation: "read",
        paths: () => [],
        filter: (out, decide) => ({
          entries: out.entries.filter((e) => decide("read", e) === "allow"),
        }),
      });
      const ctx = makeCtx({}, []);
      const result = await policy.afterInvoke!(
        { entries: ["/secrets/a", "/workspace/b"] },
        ctx,
      );
      expect(result.entries).toEqual(["/secrets/a", "/workspace/b"]);
    });

    it("filters output using the provided filter", async () => {
      const policy = new FilesystemPolicy<unknown, { entries: string[] }>({
        operation: "read",
        paths: () => [],
        filter: (out, decide) => ({
          entries: out.entries.filter((e) => decide("read", e) === "allow"),
        }),
      });
      const rule = new FilesystemPermission({
        operations: ["read"],
        paths: ["/secrets/**"],
        mode: "deny",
      });
      const ctx = makeCtx({}, [rule]);
      const result = await policy.afterInvoke!(
        { entries: ["/secrets/a", "/workspace/b"] },
        ctx,
      );
      expect(result.entries).toEqual(["/workspace/b"]);
    });
  });
});
