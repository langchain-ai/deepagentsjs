import { describe, it, expect } from "vitest";
import { isHarnessProfile, resolveMiddleware } from "./types.js";
import { createHarnessProfile } from "./create.js";

describe("isHarnessProfile", () => {
  it("returns true for a constructed HarnessProfile", () => {
    const profile = createHarnessProfile({ excludedTools: ["shell"] });
    expect(isHarnessProfile(profile)).toBe(true);
  });

  it("returns false for raw HarnessProfileOptions", () => {
    const options = { excludedTools: ["shell"] };
    expect(isHarnessProfile(options)).toBe(false);
  });

  it("returns false for empty options object", () => {
    expect(isHarnessProfile({})).toBe(false);
  });
});

describe("resolveMiddleware", () => {
  it("returns an array as-is", () => {
    const arr = [{ name: "A" } as any];
    expect(resolveMiddleware(arr)).toBe(arr);
  });

  it("invokes a factory and returns its result", () => {
    const mw = { name: "B" } as any;
    expect(resolveMiddleware(() => [mw])).toEqual([mw]);
  });
});
