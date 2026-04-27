import { describe, it, expect } from "vitest";
import { validatePath, globMatch, decidePathAccess } from "./enforce.js";
import { FilesystemPermission } from "./types.js";

describe("validatePath", () => {
  it("returns a canonicalized absolute path", () => {
    expect(validatePath("/workspace/foo")).toBe("/workspace/foo");
  });

  it("strips trailing slashes and redundant separators", () => {
    expect(validatePath("/workspace//foo/")).toBe("/workspace/foo");
  });

  it("throws on empty string", () => {
    expect(() => validatePath("")).toThrow("non-empty string");
  });

  it("throws on relative path", () => {
    expect(() => validatePath("relative")).toThrow("must be absolute");
  });

  it("throws on ..", () => {
    expect(() => validatePath("/foo/../bar")).toThrow("must not contain '..'");
  });

  it("throws on ~", () => {
    expect(() => validatePath("/~/foo")).toThrow("must not contain '~'");
  });
});

describe("globMatch", () => {
  it("matches ** across directory levels", () => {
    expect(globMatch("/workspace/a/b/c.ts", "/workspace/**")).toBe(true);
  });

  it("matches * within a single segment", () => {
    expect(globMatch("/workspace/foo.ts", "/workspace/*.ts")).toBe(true);
    expect(globMatch("/workspace/sub/foo.ts", "/workspace/*.ts")).toBe(false);
  });

  it("supports brace expansion", () => {
    expect(globMatch("/workspace/foo.ts", "/workspace/*.{ts,js}")).toBe(true);
    expect(globMatch("/workspace/foo.py", "/workspace/*.{ts,js}")).toBe(false);
  });

  it("matches dotfiles", () => {
    expect(globMatch("/workspace/.env", "/workspace/**")).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(globMatch("/other/file.ts", "/workspace/**")).toBe(false);
  });
});

describe("decidePathAccess", () => {
  const denySecrets = new FilesystemPermission({
    operations: ["write"],
    paths: ["/secrets/**"],
    mode: "deny",
  });

  const allowWorkspace = new FilesystemPermission({
    operations: ["read", "write"],
    paths: ["/workspace/**"],
    mode: "allow",
  });

  it("returns 'allow' when no rules match (permissive default)", () => {
    expect(decidePathAccess([denySecrets], "read", "/anywhere")).toBe("allow");
  });

  it("denies when a deny rule matches", () => {
    expect(decidePathAccess([denySecrets], "write", "/secrets/key.txt")).toBe(
      "deny",
    );
  });

  it("skips rules whose operations do not match", () => {
    expect(decidePathAccess([denySecrets], "read", "/secrets/key.txt")).toBe(
      "allow",
    );
  });

  it("first-match-wins: earlier rule takes precedence", () => {
    const denyAll = new FilesystemPermission({
      operations: ["write"],
      paths: ["/**"],
      mode: "deny",
    });

    expect(
      decidePathAccess(
        [allowWorkspace, denyAll],
        "write",
        "/workspace/file.ts",
      ),
    ).toBe("allow");

    expect(
      decidePathAccess(
        [denyAll, allowWorkspace],
        "write",
        "/workspace/file.ts",
      ),
    ).toBe("deny");
  });

  it("returns 'allow' when rules list is empty", () => {
    expect(decidePathAccess([], "write", "/anything")).toBe("allow");
  });
});
