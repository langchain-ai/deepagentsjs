import { describe, it, expect } from "vitest";
import {
  globAnchor,
  pathsOverlap,
  stripTrailingSlashes,
  toPosixPath,
} from "./path-utils.js";

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

describe("stripTrailingSlashes", () => {
  it("removes trailing slashes", () => {
    expect(stripTrailingSlashes("/foo/bar/")).toBe("/foo/bar");
    expect(stripTrailingSlashes("/")).toBe("");
  });

  it("handles long runs of trailing slashes in linear time", () => {
    const path = `/foo${"/".repeat(10_000)}`;
    expect(stripTrailingSlashes(path)).toBe("/foo");
  });
});
