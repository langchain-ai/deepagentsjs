/**
 * Integration tests for VfsSandbox.
 *
 * These tests verify end-to-end VFS file behavior without shell execution.
 */

import { describe, it, expect, afterEach } from "vitest";
import { VfsSandbox, createVfsSandboxFactory } from "./sandbox.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("VfsSandbox Integration", () => {
  let sandbox: VfsSandbox;

  afterEach(async () => {
    if (sandbox?.isRunning) {
      await sandbox.stop();
    }
  });

  describe("read/ls/grep/glob", () => {
    it("reads initial files with or without leading slash", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/src/index.js": "console.log('Hello from VFS!')",
        },
      });

      const absolute = await sandbox.read("/src/index.js");
      const relative = await sandbox.read("src/index.js");

      expect(absolute.error).toBeUndefined();
      expect(relative.error).toBeUndefined();
      expect(absolute.content).toContain("Hello from VFS!");
      expect(relative.content).toContain("Hello from VFS!");
    });

    it("supports ls for absolute and relative directory paths", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/src/index.js": "console.log('Hello')",
          "/src/utils.js": "module.exports = {}",
          "/README.md": "# readme",
        },
      });

      const abs = await sandbox.ls("/src");
      const rel = await sandbox.ls("src");

      expect(abs.error).toBeUndefined();
      expect(rel.error).toBeUndefined();

      const absPaths = (abs.files || []).map((f) => f.path.replace(/\/$/, ""));
      const relPaths = (rel.files || []).map((f) => f.path.replace(/\/$/, ""));

      expect(absPaths).toContain("src/index.js");
      expect(absPaths).toContain("src/utils.js");
      expect(relPaths).toContain("src/index.js");
      expect(relPaths).toContain("src/utils.js");
    });

    it("supports literal grep recursively", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/a.txt": "alpha\nbeta\nalpha",
          "/nested/b.txt": "gamma\nalpha",
          "/nested/c.md": "nope",
        },
      });

      const result = await sandbox.grep("alpha", "/");

      expect(result.error).toBeUndefined();
      expect(result.matches).toHaveLength(3);
      expect(result.matches?.some((m) => m.path.endsWith("a.txt"))).toBe(true);
      expect(result.matches?.some((m) => m.path.endsWith("b.txt"))).toBe(true);
    });

    it("supports grep glob filters", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/dir/a.txt": "target",
          "/dir/b.py": "target",
          "/dir/c.md": "target",
        },
      });

      const result = await sandbox.grep("target", "/dir", "*.py");

      expect(result.error).toBeUndefined();
      expect(result.matches).toHaveLength(1);
      expect(result.matches?.[0].path).toBe("dir/b.py");
    });

    it("supports glob with recursive patterns and directories", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/project/src/index.ts": "export {}",
          "/project/src/lib/math.ts": "export const n = 1",
          "/project/README.md": "# Project",
        },
      });

      const recursive = await sandbox.glob("**/*.ts", "/project");
      const topLevel = await sandbox.glob("*", "/project");

      expect(recursive.error).toBeUndefined();
      expect((recursive.files || []).map((f) => f.path)).toEqual(
        expect.arrayContaining(["src/index.ts", "src/lib/math.ts"]),
      );

      expect(topLevel.error).toBeUndefined();
      expect(
        (topLevel.files || []).some((f) => f.is_dir && f.path === "src"),
      ).toBe(true);
      expect(
        (topLevel.files || []).some((f) => !f.is_dir && f.path === "README.md"),
      ).toBe(true);
    });

    it("returns binary content as Uint8Array from read", async () => {
      sandbox = await VfsSandbox.create();
      const pngHeader = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);

      await sandbox.uploadFiles([["image.png", pngHeader]]);
      const result = await sandbox.read("image.png");

      expect(result.error).toBeUndefined();
      expect(result.content).toBeInstanceOf(Uint8Array);
      expect(result.content).toEqual(pngHeader);
    });
  });

  describe("path confinement", () => {
    it("rejects uploads outside the virtual workspace", async () => {
      sandbox = await VfsSandbox.create();

      const result = await sandbox.uploadFiles([
        ["../../outside.txt", new TextEncoder().encode("no")],
      ]);

      expect(result[0].error).toBe("invalid_path");
    });

    it("rejects downloads outside the virtual workspace", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: { "/safe.txt": "ok" },
      });

      const result = await sandbox.downloadFiles(["../../outside.txt"]);

      expect(result[0].error).toBe("invalid_path");
      expect(result[0].content).toBeNull();
    });
  });

  describe("Factory functions", () => {
    it("creates sandbox via factory", async () => {
      const factory = createVfsSandboxFactory({
        initialFiles: {
          "/factory.txt": "Created by factory",
        },
      });

      sandbox = await factory();
      expect(sandbox.isRunning).toBe(true);

      const downloaded = await sandbox.downloadFiles(["/factory.txt"]);
      expect(new TextDecoder().decode(downloaded[0].content!)).toBe(
        "Created by factory",
      );
    });

    it("creates independent sandboxes", async () => {
      const factory = createVfsSandboxFactory();

      const sandbox1 = await factory();
      const sandbox2 = await factory();

      try {
        expect(sandbox1).not.toBe(sandbox2);

        await sandbox1.uploadFiles([
          ["test.txt", new TextEncoder().encode("sandbox1")],
        ]);

        const downloaded = await sandbox2.downloadFiles(["test.txt"]);
        expect(downloaded[0].error).toBe("file_not_found");
      } finally {
        await sandbox1.stop();
        await sandbox2.stop();
      }
    });
  });
});
