import { describe, it, expect } from "vitest";
import type { ToolCallRequest } from "langchain";
import {
  buildInterruptOnFromPermissions,
  mergeFsInterruptOn,
  _testExports,
} from "./fs-interrupt.js";
import { decidePathAccess } from "../permissions/enforce.js";
import { globAnchor, pathsOverlap } from "../permissions/path-utils.js";
import type { FilesystemPermission } from "../permissions/types.js";

const { makeFsWhenPredicate } = _testExports;

function fakeReq(args: Record<string, unknown>): ToolCallRequest {
  return {
    toolCall: { id: "1", name: "test", args },
  } as ToolCallRequest;
}

describe("buildInterruptOnFromPermissions", () => {
  it("returns empty when no rules", () => {
    expect(buildInterruptOnFromPermissions([])).toEqual({});
  });

  it("returns empty when no interrupt rules", () => {
    const rules: FilesystemPermission[] = [
      { operations: ["write"], paths: ["/secrets/**"], mode: "deny" },
    ];
    expect(buildInterruptOnFromPermissions(rules)).toEqual({});
  });

  it("registers only tools whose op could interrupt", () => {
    const rules: FilesystemPermission[] = [
      { operations: ["write"], paths: ["/secrets/**"], mode: "interrupt" },
    ];
    expect(Object.keys(buildInterruptOnFromPermissions(rules)).sort()).toEqual([
      "edit_file",
      "write_file",
    ]);
  });

  it("registers read tools for read interrupt", () => {
    const rules: FilesystemPermission[] = [
      { operations: ["read"], paths: ["/secrets/**"], mode: "interrupt" },
    ];
    expect(Object.keys(buildInterruptOnFromPermissions(rules)).sort()).toEqual([
      "glob",
      "grep",
      "ls",
      "read_file",
    ]);
  });
});

describe("mergeFsInterruptOn", () => {
  it("returns undefined when both inputs are empty", () => {
    expect(mergeFsInterruptOn({}, undefined)).toBeUndefined();
    expect(mergeFsInterruptOn({}, {})).toBeUndefined();
  });

  it("user interruptOn overrides fs-generated config per tool name", () => {
    const fsConfig = buildInterruptOnFromPermissions([
      { operations: ["write"], paths: ["/secrets/**"], mode: "interrupt" },
    ]);
    const merged = mergeFsInterruptOn(fsConfig, {
      write_file: { allowedDecisions: ["approve", "reject"] },
    });
    expect(merged?.write_file).toEqual({
      allowedDecisions: ["approve", "reject"],
    });
    expect(merged?.edit_file).toBeDefined();
  });
});

describe("decidePathAccess interrupt mode", () => {
  it("returns interrupt for a matching interrupt rule", () => {
    const rules: FilesystemPermission[] = [
      { operations: ["write"], paths: ["/secrets/**"], mode: "interrupt" },
    ];
    expect(decidePathAccess(rules, "write", "/secrets/x.txt")).toBe("interrupt");
    expect(decidePathAccess(rules, "write", "/workspace/x.txt")).toBe("allow");
  });

  it("first-match-wins: deny before interrupt", () => {
    const rules: FilesystemPermission[] = [
      { operations: ["write"], paths: ["/secrets/**"], mode: "deny" },
      { operations: ["write"], paths: ["/secrets/**"], mode: "interrupt" },
    ];
    expect(decidePathAccess(rules, "write", "/secrets/x.txt")).toBe("deny");
  });
});

describe("exact when predicate", () => {
  const rules: FilesystemPermission[] = [
    { operations: ["write"], paths: ["/secrets/**"], mode: "interrupt" },
  ];
  const when = makeFsWhenPredicate(rules, "write", "file_path", "exact");

  it.each([
    ["/secrets/key.pem", true],
    ["/workspace/x.txt", false],
  ])("file_path=%s -> %s", (filePath, expected) => {
    expect(when(fakeReq({ file_path: filePath }))).toBe(expected);
  });
});

describe("bulk when predicate", () => {
  const rules: FilesystemPermission[] = [
    { operations: ["read"], paths: ["/secrets/**"], mode: "interrupt" },
  ];
  const when = makeFsWhenPredicate(rules, "read", "path", "bulk");

  it.each([
    [{ path: undefined }, true],
    [{}, true],
    [{ path: "." }, true],
    [{ path: "" }, true],
    [{ path: "./" }, true],
    [{ path: "/." }, true],
    [{ path: "/" }, true],
    [{ path: "/secrets" }, true],
    [{ path: "/secrets/sub" }, true],
    [{ path: "/workspace" }, false],
    [{ path: "/secret" }, false],
    [{ path: "/secrets/../etc/passwd" }, false],
  ])("%j -> %s", (args, expected) => {
    expect(when(fakeReq(args))).toBe(expected);
  });
});

describe("glob bulk pattern predicate", () => {
  const rules: FilesystemPermission[] = [
    { operations: ["read"], paths: ["/secrets/**"], mode: "interrupt" },
  ];
  const when = buildInterruptOnFromPermissions(rules).glob.when!;

  it.each([
    [{ pattern: "/secrets/**", path: "/workspace" }, true],
    [{ pattern: "/secrets/sub/*.txt", path: "/workspace" }, true],
    [{ pattern: "/**/key.pem", path: "/workspace" }, true],
    [{ pattern: "/workspace/**", path: "/workspace" }, false],
    [{ pattern: "../secrets/*", path: "/workspace" }, true],
    [{ pattern: "../../etc/*", path: "/workspace/sub" }, true],
    [{ pattern: "*.txt", path: "/workspace" }, false],
    [{ pattern: "*.txt", path: "/secrets" }, true],
  ])("%j -> %s", (args, expected) => {
    expect(when(fakeReq(args))).toBe(expected);
  });
});

describe("globAnchor", () => {
  it.each([
    ["/secrets/**", "/secrets"],
    ["/a/*/b", "/a"],
    ["/secrets/key.pem", "/secrets/key.pem"],
    ["/*/foo", "/"],
    ["/**/secrets", "/"],
  ])("globAnchor(%s) -> %s", (pattern, expected) => {
    expect(globAnchor(pattern)).toBe(expected);
  });
});

describe("pathsOverlap", () => {
  it.each([
    ["/a/b", "/a/b", true],
    ["/a/b/c", "/a/b", true],
    ["/a", "/a/b", true],
    ["/", "/anywhere", true],
    ["/anywhere", "/", true],
    ["/secret", "/secrets", false],
    ["/secrets", "/secret", false],
    ["/workspace", "/secrets", false],
  ])("pathsOverlap(%s, %s) -> %s", (a, b, expected) => {
    expect(pathsOverlap(a, b)).toBe(expected);
  });
});
