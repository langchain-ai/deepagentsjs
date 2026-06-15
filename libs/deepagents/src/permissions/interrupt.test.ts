import { describe, it, expect } from "vitest";
import {
  buildFsInterruptPredicates,
  globAnchor,
  pathsOverlap,
  hasInterruptPermission,
} from "./interrupt.js";
import type { FilesystemPermission } from "./types.js";

function predicate(
  rules: FilesystemPermission[],
  tool: string,
  excludeTools: string[] = [],
) {
  const predicates = buildFsInterruptPredicates(rules, new Set(excludeTools));
  return predicates[tool];
}

describe("globAnchor", () => {
  it("returns the literal leading directory", () => {
    expect(globAnchor("/secrets/**")).toBe("/secrets");
    expect(globAnchor("/a/*/b")).toBe("/a");
    expect(globAnchor("/secrets/sub/*.txt")).toBe("/secrets/sub");
  });

  it("falls back to root for wildcards at or near the root", () => {
    expect(globAnchor("/**/secrets")).toBe("/");
    expect(globAnchor("/*/foo")).toBe("/");
    expect(globAnchor("*.txt")).toBe("/");
  });
});

describe("pathsOverlap", () => {
  it("matches when one subtree contains the other", () => {
    expect(pathsOverlap("/secrets", "/secrets/sub")).toBe(true);
    expect(pathsOverlap("/secrets/sub", "/secrets")).toBe(true);
    expect(pathsOverlap("/secrets", "/secrets")).toBe(true);
  });

  it("root overlaps everything", () => {
    expect(pathsOverlap("/", "/anything/here")).toBe(true);
    expect(pathsOverlap("/anything/here", "/")).toBe(true);
  });

  it("uses component-aware matching, not string prefix", () => {
    expect(pathsOverlap("/secret", "/secrets")).toBe(false);
    expect(pathsOverlap("/workspace", "/secrets")).toBe(false);
  });
});

describe("hasInterruptPermission", () => {
  it("is true only when a rule uses interrupt mode", () => {
    expect(hasInterruptPermission([])).toBe(false);
    expect(
      hasInterruptPermission([
        { operations: ["read"], paths: ["/x/**"], mode: "deny" },
      ]),
    ).toBe(false);
    expect(
      hasInterruptPermission([
        { operations: ["read"], paths: ["/x/**"], mode: "interrupt" },
      ]),
    ).toBe(true);
  });
});

describe("buildFsInterruptPredicates", () => {
  it("returns empty when there are no interrupt rules", () => {
    expect(buildFsInterruptPredicates([])).toEqual({});
    expect(
      buildFsInterruptPredicates([
        { operations: ["write"], paths: ["/x/**"], mode: "deny" },
      ]),
    ).toEqual({});
  });

  it("registers only tools whose operation can interrupt", () => {
    const out = buildFsInterruptPredicates([
      { operations: ["write"], paths: ["/secrets/**"], mode: "interrupt" },
    ]);
    expect(Object.keys(out).sort()).toEqual(["edit_file", "write_file"]);
  });

  it("registers read tools for a read interrupt rule", () => {
    const out = buildFsInterruptPredicates([
      { operations: ["read"], paths: ["/secrets/**"], mode: "interrupt" },
    ]);
    expect(Object.keys(out).sort()).toEqual([
      "glob",
      "grep",
      "ls",
      "read_file",
    ]);
  });

  it("excludes tools listed in excludeTools", () => {
    const out = buildFsInterruptPredicates(
      [{ operations: ["write"], paths: ["/secrets/**"], mode: "interrupt" }],
      new Set(["write_file"]),
    );
    expect(Object.keys(out)).toEqual(["edit_file"]);
  });
});

describe("exact-scope predicate", () => {
  const rules: FilesystemPermission[] = [
    { operations: ["write"], paths: ["/secrets/**"], mode: "interrupt" },
  ];

  it.each([
    ["/secrets/key.pem", true],
    ["/workspace/x.txt", false],
    // `/secrets/**` matches `/secrets` under the repo's micromatch glob rules.
    ["/secrets", true],
  ])("path %s -> %s", (filePath, expected) => {
    const when = predicate(rules, "write_file");
    expect(when({ file_path: filePath })).toBe(expected);
  });

  it("does not fire when a deny rule wins first", () => {
    const denyFirst: FilesystemPermission[] = [
      { operations: ["write"], paths: ["/secrets/**"], mode: "deny" },
      { operations: ["write"], paths: ["/secrets/**"], mode: "interrupt" },
    ];
    const when = predicate(denyFirst, "write_file");
    expect(when({ file_path: "/secrets/key.pem" })).toBe(false);
  });

  it("ignores non-string and invalid paths", () => {
    const when = predicate(rules, "write_file");
    expect(when({ file_path: 123 })).toBe(false);
    expect(when({ file_path: "/secrets/../etc/passwd" })).toBe(false);
    expect(when({})).toBe(false);
  });
});

describe("bulk-scope predicate", () => {
  const rules: FilesystemPermission[] = [
    { operations: ["read"], paths: ["/secrets/**"], mode: "interrupt" },
  ];

  it.each([
    [{ path: undefined }, true],
    [{}, true],
    [{ path: "/" }, true],
    [{ path: "/secrets" }, true],
    [{ path: "/secrets/sub" }, true],
    [{ path: "/workspace" }, false],
    [{ path: "/secret" }, false],
    [{ path: "/secrets/../etc/passwd" }, false],
  ])("args %o -> %s", (args, expected) => {
    const when = predicate(rules, "ls");
    expect(when(args as Record<string, unknown>)).toBe(expected);
  });
});

describe("glob bulk predicate gates on pattern arg", () => {
  const rules: FilesystemPermission[] = [
    { operations: ["read"], paths: ["/secrets/**"], mode: "interrupt" },
  ];

  it.each([
    [{ pattern: "/secrets/**", path: "/workspace" }, true],
    [{ pattern: "/secrets/sub/*.txt", path: "/workspace" }, true],
    [{ pattern: "/**/key.pem", path: "/workspace" }, true],
    [{ pattern: "/workspace/**", path: "/workspace" }, false],
    [{ pattern: "../secrets/*", path: "/workspace" }, true],
    [{ pattern: "../../etc/*", path: "/workspace/sub" }, true],
    [{ pattern: "*.txt", path: "/workspace" }, false],
    [{ pattern: "*.txt", path: "/secrets" }, true],
  ])("args %o -> %s", (args, expected) => {
    const when = predicate(rules, "glob");
    expect(when(args as Record<string, unknown>)).toBe(expected);
  });
});
