import { describe, it, expect } from "vitest";
import { FilesystemPermission } from "./types.js";

describe("FilesystemPermission", () => {
  describe("construction", () => {
    it("stores operations, paths, and mode", () => {
      const p = new FilesystemPermission({
        operations: ["read"],
        paths: ["/workspace/**"],
        mode: "deny",
      });
      expect(p.operations).toEqual(["read"]);
      expect(p.paths).toEqual(["/workspace/**"]);
      expect(p.mode).toBe("deny");
    });

    it("defaults mode to allow", () => {
      const p = new FilesystemPermission({
        operations: ["write"],
        paths: ["/tmp/**"],
      });
      expect(p.mode).toBe("allow");
    });

    it("accepts multiple operations", () => {
      const p = new FilesystemPermission({
        operations: ["read", "write"],
        paths: ["/workspace/**"],
      });
      expect(p.operations).toEqual(["read", "write"]);
    });

    it("accepts multiple paths", () => {
      const p = new FilesystemPermission({
        operations: ["read"],
        paths: ["/workspace/**", "/tmp/**"],
      });
      expect(p.paths).toEqual(["/workspace/**", "/tmp/**"]);
    });

    it("accepts glob patterns", () => {
      expect(
        () =>
          new FilesystemPermission({
            operations: ["read"],
            paths: ["/foo/**", "/foo/*.ts", "/foo/{a,b}"],
          }),
      ).not.toThrow();
    });
  });

  describe("path validation", () => {
    it("throws when a path is not absolute", () => {
      expect(
        () =>
          new FilesystemPermission({
            operations: ["read"],
            paths: ["workspace/foo"],
          }),
      ).toThrow(/absolute/i);
    });

    it("throws when a path contains ..", () => {
      expect(
        () =>
          new FilesystemPermission({
            operations: ["read"],
            paths: ["/workspace/../secrets"],
          }),
      ).toThrow(/\.\./);
    });

    it("throws when a path contains ~", () => {
      expect(
        () =>
          new FilesystemPermission({
            operations: ["read"],
            paths: ["/~/secrets"],
          }),
      ).toThrow(/~/);
    });

    it("throws on the first invalid path and stops", () => {
      expect(
        () =>
          new FilesystemPermission({
            operations: ["read"],
            paths: ["relative/path", "/valid/**"],
          }),
      ).toThrow(/absolute/i);
    });

    it("accepts root path", () => {
      expect(
        () =>
          new FilesystemPermission({
            operations: ["read"],
            paths: ["/"],
          }),
      ).not.toThrow();
    });
  });
});
