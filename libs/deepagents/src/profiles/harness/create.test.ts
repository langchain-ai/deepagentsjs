import { describe, it, expect } from "vitest";
import { createHarnessProfile, EMPTY_HARNESS_PROFILE } from "./create.js";
import { resolveMiddleware, REQUIRED_MIDDLEWARE_NAMES } from "./types.js";

describe("createHarnessProfile", () => {
  it("produces a no-op profile from empty options", () => {
    const profile = createHarnessProfile();

    expect(profile.baseSystemPrompt).toBeUndefined();
    expect(profile.systemPromptSuffix).toBeUndefined();
    expect(Object.keys(profile.toolDescriptionOverrides)).toHaveLength(0);
    expect(profile.excludedTools.size).toBe(0);
    expect(profile.excludedMiddleware.size).toBe(0);
    expect(resolveMiddleware(profile.extraMiddleware)).toHaveLength(0);
    expect(profile.generalPurposeSubagent).toBeUndefined();
  });

  it("freezes the returned profile", () => {
    const profile = createHarnessProfile();
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("freezes toolDescriptionOverrides", () => {
    const profile = createHarnessProfile({
      toolDescriptionOverrides: { foo: "bar" },
    });
    expect(Object.isFrozen(profile.toolDescriptionOverrides)).toBe(true);
  });

  it("freezes generalPurposeSubagent when provided", () => {
    const profile = createHarnessProfile({
      generalPurposeSubagent: { enabled: true, description: "test" },
    });
    expect(Object.isFrozen(profile.generalPurposeSubagent)).toBe(true);
  });

  it("converts excludedTools array to a Set", () => {
    const profile = createHarnessProfile({
      excludedTools: ["execute", "shell"],
    });
    expect(profile.excludedTools).toBeInstanceOf(Set);
    expect(profile.excludedTools.has("execute")).toBe(true);
    expect(profile.excludedTools.has("shell")).toBe(true);
  });

  it("converts excludedMiddleware array to a Set", () => {
    const profile = createHarnessProfile({
      excludedMiddleware: ["SomeMiddleware"],
    });
    expect(profile.excludedMiddleware).toBeInstanceOf(Set);
    expect(profile.excludedMiddleware.has("SomeMiddleware")).toBe(true);
  });

  it("creates a null-prototype object for toolDescriptionOverrides", () => {
    const profile = createHarnessProfile({
      toolDescriptionOverrides: { foo: "bar" },
    });
    expect(Object.getPrototypeOf(profile.toolDescriptionOverrides)).toBeNull();
  });

  it("accepts an extraMiddleware factory function", () => {
    const mw = { name: "TestMW" } as any;
    const factory = () => [mw];
    const profile = createHarnessProfile({ extraMiddleware: factory });
    expect(typeof profile.extraMiddleware).toBe("function");
    expect(resolveMiddleware(profile.extraMiddleware)).toEqual([mw]);
  });

  it("passes through string fields as-is", () => {
    const profile = createHarnessProfile({
      baseSystemPrompt: "You are a robot.",
      systemPromptSuffix: "Think step by step.",
    });
    expect(profile.baseSystemPrompt).toBe("You are a robot.");
    expect(profile.systemPromptSuffix).toBe("Think step by step.");
  });

  it("throws on empty string in excludedMiddleware", () => {
    expect(() => createHarnessProfile({ excludedMiddleware: [""] })).toThrow(
      "non-empty",
    );
  });

  it("throws on whitespace-only excludedMiddleware entry", () => {
    expect(() => createHarnessProfile({ excludedMiddleware: ["   "] })).toThrow(
      "non-empty",
    );
  });

  it("throws on excludedMiddleware entry containing a colon", () => {
    expect(() =>
      createHarnessProfile({ excludedMiddleware: ["module:Class"] }),
    ).toThrow("class-path syntax");
  });

  it("throws on excludedMiddleware entry starting with underscore", () => {
    expect(() =>
      createHarnessProfile({ excludedMiddleware: ["_PrivateMW"] }),
    ).toThrow('cannot start with "_"');
  });

  it("throws when excluding a required middleware name", () => {
    for (const name of REQUIRED_MIDDLEWARE_NAMES) {
      expect(() =>
        createHarnessProfile({ excludedMiddleware: [name] }),
      ).toThrow("required middleware");
    }
  });
});

describe("EMPTY_HARNESS_PROFILE", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(EMPTY_HARNESS_PROFILE)).toBe(true);
  });

  it("matches a default-constructed profile", () => {
    const fresh = createHarnessProfile();
    expect(EMPTY_HARNESS_PROFILE.baseSystemPrompt).toBe(fresh.baseSystemPrompt);
    expect(EMPTY_HARNESS_PROFILE.systemPromptSuffix).toBe(
      fresh.systemPromptSuffix,
    );
    expect(EMPTY_HARNESS_PROFILE.excludedTools.size).toBe(
      fresh.excludedTools.size,
    );
    expect(EMPTY_HARNESS_PROFILE.excludedMiddleware.size).toBe(
      fresh.excludedMiddleware.size,
    );
  });
});
