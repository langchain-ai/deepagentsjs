import { describe, it, expect } from "vitest";
import { validatePath, globMatch, decidePathAccess } from "./enforce.js";

describe("validatePath", () => {
  it("returns canonicalized path for valid input", () => {
    expect(validatePath("/foo/bar")).toBe("/foo/bar");
  });

  it("strips trailing slash", () => {
    expect(validatePath("/foo/bar/")).toBe("/foo/bar");
  });

  it("collapses multiple slashes", () => {
    expect(validatePath("/foo//bar")).toBe("/foo/bar");
  });

  it("normalizes root path", () => {
    expect(validatePath("/")).toBe("/");
  });

  it("throws on empty string", () => {
    expect(() => validatePath("")).toThrow(/non-empty/);
  });

  it("throws on relative path", () => {
    expect(() => validatePath("foo/bar")).toThrow(/absolute/);
  });

  it("throws on path containing ..", () => {
    expect(() => validatePath("/foo/../bar")).toThrow(/\.\./);
  });

  it("throws on path containing ~", () => {
    expect(() => validatePath("/~/secrets")).toThrow(/~/);
  });
});

describe("globMatch", () => {
  it("matches exact path", () => {
    expect(globMatch("/foo/bar.ts", "/foo/bar.ts")).toBe(true);
  });

  it("matches with ** wildcard", () => {
    expect(globMatch("/foo/bar/baz.ts", "/foo/**")).toBe(true);
  });

  it("matches with * wildcard within segment", () => {
    expect(globMatch("/foo/bar.ts", "/foo/*.ts")).toBe(true);
  });

  it("matches brace expansion", () => {
    expect(globMatch("/foo/a.ts", "/foo/{a,b}.ts")).toBe(true);
    expect(globMatch("/foo/b.ts", "/foo/{a,b}.ts")).toBe(true);
    expect(globMatch("/foo/c.ts", "/foo/{a,b}.ts")).toBe(false);
  });

  it("matches dotfiles with dot: true", () => {
    expect(globMatch("/foo/.env", "/foo/**")).toBe(true);
    expect(globMatch("/foo/.hidden/bar", "/foo/**")).toBe(true);
  });

  it("returns false for non-matching path", () => {
    expect(globMatch("/other/bar.ts", "/foo/**")).toBe(false);
  });
});

describe("decidePathAccess", () => {
  it("returns allow when rules array is empty", () => {
    expect(decidePathAccess([], "read", "/foo/bar")).toBe("allow");
  });

  it("returns allow when no rule matches", () => {
    const rules = [
      {
        operations: ["read"] as const,
        paths: ["/other/**"],
        mode: "deny" as const,
      },
    ];
    expect(decidePathAccess(rules, "read", "/foo/bar")).toBe("allow");
  });

  it("returns allow for a matching allow rule", () => {
    const rules = [{ operations: ["read"] as const, paths: ["/workspace/**"] }];
    expect(decidePathAccess(rules, "read", "/workspace/file.ts")).toBe("allow");
  });

  it("defaults mode to allow when omitted", () => {
    const rules = [{ operations: ["read"] as const, paths: ["/workspace/**"] }];
    expect(decidePathAccess(rules, "read", "/workspace/file.ts")).toBe("allow");
  });

  it("returns deny for a matching deny rule", () => {
    const rules = [
      {
        operations: ["read"] as const,
        paths: ["/secrets/**"],
        mode: "deny" as const,
      },
    ];
    expect(decidePathAccess(rules, "read", "/secrets/key.txt")).toBe("deny");
  });

  it("first-match-wins: allow before deny", () => {
    const rules = [
      { operations: ["read"] as const, paths: ["/workspace/**"] },
      { operations: ["read"] as const, paths: ["/**"], mode: "deny" as const },
    ];
    expect(decidePathAccess(rules, "read", "/workspace/file.ts")).toBe("allow");
  });

  it("first-match-wins: deny before allow", () => {
    const rules = [
      {
        operations: ["read"] as const,
        paths: ["/workspace/**"],
        mode: "deny" as const,
      },
      { operations: ["read"] as const, paths: ["/workspace/**"] },
    ];
    expect(decidePathAccess(rules, "read", "/workspace/file.ts")).toBe("deny");
  });

  it("skips rules for a different operation", () => {
    const rules = [
      {
        operations: ["write"] as const,
        paths: ["/secrets/**"],
        mode: "deny" as const,
      },
    ];
    expect(decidePathAccess(rules, "read", "/secrets/key.txt")).toBe("allow");
  });

  it("matches when rule covers multiple operations", () => {
    const rules = [
      {
        operations: ["read", "write"] as const,
        paths: ["/secrets/**"],
        mode: "deny" as const,
      },
    ];
    expect(decidePathAccess(rules, "read", "/secrets/key.txt")).toBe("deny");
    expect(decidePathAccess(rules, "write", "/secrets/key.txt")).toBe("deny");
  });

  it("matches when rule covers multiple paths", () => {
    const rules = [
      {
        operations: ["read"] as const,
        paths: ["/a/**", "/b/**"],
        mode: "deny" as const,
      },
    ];
    expect(decidePathAccess(rules, "read", "/a/file.txt")).toBe("deny");
    expect(decidePathAccess(rules, "read", "/b/file.txt")).toBe("deny");
    expect(decidePathAccess(rules, "read", "/c/file.txt")).toBe("allow");
  });
});
