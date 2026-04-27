import { describe, it, expect } from "vitest";
import { FilesystemPermission } from "./types.js";

describe("FilesystemPermission", () => {
  it("stores operations, paths, and mode", () => {
    const perm = new FilesystemPermission({
      operations: ["read"],
      paths: ["/workspace/**"],
      mode: "allow",
    });

    expect(perm.operations).toEqual(["read"]);
    expect(perm.paths).toEqual(["/workspace/**"]);
    expect(perm.mode).toBe("allow");
  });

  it("defaults mode to 'allow'", () => {
    const perm = new FilesystemPermission({
      operations: ["write"],
      paths: ["/tmp/**"],
    });

    expect(perm.mode).toBe("allow");
  });

  it("rejects paths that do not start with /", () => {
    expect(
      () =>
        new FilesystemPermission({
          operations: ["read"],
          paths: ["relative/path"],
        }),
    ).toThrow("Permission path must start with '/'");
  });

  it("rejects paths containing ..", () => {
    expect(
      () =>
        new FilesystemPermission({
          operations: ["read"],
          paths: ["/workspace/../secrets"],
        }),
    ).toThrow("Permission path must not contain '..'");
  });

  it("rejects paths containing ~", () => {
    expect(
      () =>
        new FilesystemPermission({
          operations: ["read"],
          paths: ["/~/secrets"],
        }),
    ).toThrow("Permission path must not contain '~'");
  });
});
