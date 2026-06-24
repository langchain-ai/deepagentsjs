import { describe, it, expect } from "vitest";
import { validatePkgName } from "./validate.js";

describe("validatePkgName", () => {
  it("returns null for a valid lowercase name", () => {
    expect(validatePkgName("my-app")).toBeNull();
  });

  it("returns null for a name with dots, dashes, and underscores", () => {
    expect(validatePkgName("my.app_v1-rc")).toBeNull();
  });

  it("returns an error for an empty string", () => {
    expect(validatePkgName("")).toBe("Project name is required");
  });

  it("returns an error for a name exceeding 214 characters", () => {
    expect(validatePkgName("a".repeat(215))).toBe(
      "Project name must be 214 characters or less",
    );
  });

  it("returns null for a name exactly 214 characters", () => {
    expect(validatePkgName("a".repeat(214))).toBeNull();
  });

  it("returns an error for a name starting with a dot", () => {
    expect(validatePkgName(".hidden")).toBe(
      "Project name must not start with . or _",
    );
  });

  it("returns an error for a name starting with an underscore", () => {
    expect(validatePkgName("_internal")).toBe(
      "Project name must not start with . or _",
    );
  });

  it("returns an error for an uppercase name", () => {
    expect(validatePkgName("MyApp")).toBe("Project name must be lowercase");
  });

  it("returns an error for a name with spaces", () => {
    expect(validatePkgName("my app")).toBe(
      "Project name must not contain spaces",
    );
  });

  it("returns an error for a name with invalid characters", () => {
    expect(validatePkgName("@langchain/test")).toBe(
      "Project name may only contain lowercase letters, numbers, ., _, and -",
    );
  });
});
