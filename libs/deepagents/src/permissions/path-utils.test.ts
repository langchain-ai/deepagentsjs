import { describe, it, expect } from "vitest";
import { globAnchor, pathsOverlap, toPosixPath } from "./path-utils.js";

describe("toPosixPath", () => {
  it("normalizes backslashes", () => {
    expect(toPosixPath("C:\\workspace\\file")).toBe("C:/workspace/file");
  });
});

describe("globAnchor", () => {
  it("returns longest wildcard-free prefix", () => {
    expect(globAnchor("/foo/bar/**")).toBe("/foo/bar");
  });
});

describe("pathsOverlap", () => {
  it("treats root as overlapping everything", () => {
    expect(pathsOverlap("/", "/secrets")).toBe(true);
  });
});
