import { describe, it, expect } from "vitest";
import {
  createHarnessProfile,
  parseHarnessProfileConfig,
  serializeProfile,
  resolveMiddleware,
  EMPTY_HARNESS_PROFILE,
  REQUIRED_MIDDLEWARE_NAMES,
} from "./types.js";

// ---------------------------------------------------------------------------
// createHarnessProfile
// ---------------------------------------------------------------------------

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

  // -- excludedMiddleware validation --

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

// ---------------------------------------------------------------------------
// EMPTY_HARNESS_PROFILE
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// parseHarnessProfileConfig
// ---------------------------------------------------------------------------

describe("parseHarnessProfileConfig", () => {
  it("parses a valid config object into a frozen profile", () => {
    const profile = parseHarnessProfileConfig({
      baseSystemPrompt: "Hello",
      excludedTools: ["shell"],
    });
    expect(profile.baseSystemPrompt).toBe("Hello");
    expect(profile.excludedTools.has("shell")).toBe(true);
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("parses an empty object into a no-op profile", () => {
    const profile = parseHarnessProfileConfig({});
    expect(profile.baseSystemPrompt).toBeUndefined();
    expect(profile.excludedTools.size).toBe(0);
  });

  it("parses generalPurposeSubagent config", () => {
    const profile = parseHarnessProfileConfig({
      generalPurposeSubagent: {
        enabled: false,
        description: "custom",
        systemPrompt: "do stuff",
      },
    });
    expect(profile.generalPurposeSubagent?.enabled).toBe(false);
    expect(profile.generalPurposeSubagent?.description).toBe("custom");
    expect(profile.generalPurposeSubagent?.systemPrompt).toBe("do stuff");
  });

  it("rejects unknown top-level keys (Zod strict)", () => {
    expect(() => parseHarnessProfileConfig({ unknownField: true })).toThrow();
  });

  it("rejects unknown keys inside generalPurposeSubagent", () => {
    expect(() =>
      parseHarnessProfileConfig({
        generalPurposeSubagent: { enabled: true, bogus: "x" },
      }),
    ).toThrow();
  });

  it("rejects wrong types for fields", () => {
    expect(() => parseHarnessProfileConfig({ baseSystemPrompt: 42 })).toThrow();

    expect(() =>
      parseHarnessProfileConfig({ excludedTools: "not-an-array" }),
    ).toThrow();
  });

  it("rejects __proto__ at the root level", () => {
    const poisoned = JSON.parse('{"__proto__": {"polluted": true}}');
    expect(() => parseHarnessProfileConfig(poisoned)).toThrow(
      'Rejected dangerous key "__proto__"',
    );
  });

  it("rejects constructor at a nested level", () => {
    const poisoned = JSON.parse(
      '{"toolDescriptionOverrides": {"constructor": "evil"}}',
    );
    expect(() => parseHarnessProfileConfig(poisoned)).toThrow(
      'Rejected dangerous key "constructor"',
    );
  });

  it("rejects prototype at any depth", () => {
    const poisoned = JSON.parse(
      '{"generalPurposeSubagent": {"prototype": "evil"}}',
    );
    expect(() => parseHarnessProfileConfig(poisoned)).toThrow(
      'Rejected dangerous key "prototype"',
    );
  });

  it("propagates excludedMiddleware validation errors", () => {
    expect(() =>
      parseHarnessProfileConfig({
        excludedMiddleware: ["FilesystemMiddleware"],
      }),
    ).toThrow("required middleware");
  });
});

// ---------------------------------------------------------------------------
// serializeProfile
// ---------------------------------------------------------------------------

describe("serializeProfile", () => {
  it("omits undefined and empty fields", () => {
    const profile = createHarnessProfile();
    const serialized = serializeProfile(profile);
    expect(serialized).toEqual({});
  });

  it("includes only populated fields", () => {
    const profile = createHarnessProfile({
      systemPromptSuffix: "Think step by step.",
      excludedTools: ["shell"],
    });
    const serialized = serializeProfile(profile);
    expect(serialized).toEqual({
      systemPromptSuffix: "Think step by step.",
      excludedTools: ["shell"],
    });
    expect(serialized).not.toHaveProperty("baseSystemPrompt");
    expect(serialized).not.toHaveProperty("excludedMiddleware");
    expect(serialized).not.toHaveProperty("toolDescriptionOverrides");
    expect(serialized).not.toHaveProperty("generalPurposeSubagent");
  });

  it("serializes all fields when populated", () => {
    const profile = createHarnessProfile({
      baseSystemPrompt: "Base",
      systemPromptSuffix: "Suffix",
      toolDescriptionOverrides: { foo: "bar" },
      excludedTools: ["a", "b"],
      excludedMiddleware: ["SomeMW"],
      generalPurposeSubagent: { enabled: true, description: "gp" },
    });
    const serialized = serializeProfile(profile);
    expect(serialized.baseSystemPrompt).toBe("Base");
    expect(serialized.systemPromptSuffix).toBe("Suffix");
    expect(serialized.toolDescriptionOverrides).toEqual({ foo: "bar" });
    expect(serialized.excludedTools).toEqual(
      expect.arrayContaining(["a", "b"]),
    );
    expect(serialized.excludedMiddleware).toEqual(["SomeMW"]);
    expect(serialized.generalPurposeSubagent).toEqual({
      enabled: true,
      description: "gp",
    });
  });

  it("omits generalPurposeSubagent fields that are undefined", () => {
    const profile = createHarnessProfile({
      generalPurposeSubagent: { enabled: false },
    });
    const serialized = serializeProfile(profile);
    expect(serialized.generalPurposeSubagent).toEqual({ enabled: false });
    expect(serialized.generalPurposeSubagent).not.toHaveProperty("description");
    expect(serialized.generalPurposeSubagent).not.toHaveProperty(
      "systemPrompt",
    );
  });

  it("throws when extraMiddleware is non-empty", () => {
    const mw = { name: "TestMW" } as any;
    const profile = createHarnessProfile({ extraMiddleware: [mw] });
    expect(() => serializeProfile(profile)).toThrow("extraMiddleware");
  });

  it("throws when extraMiddleware factory returns non-empty array", () => {
    const mw = { name: "TestMW" } as any;
    const profile = createHarnessProfile({ extraMiddleware: () => [mw] });
    expect(() => serializeProfile(profile)).toThrow("extraMiddleware");
  });
});

// ---------------------------------------------------------------------------
// resolveMiddleware
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Round-trip: create → serialize → parse
// ---------------------------------------------------------------------------

describe("round-trip serialization", () => {
  it("survives a create → serialize → parse cycle", () => {
    const original = createHarnessProfile({
      baseSystemPrompt: "You are helpful.",
      systemPromptSuffix: "Be concise.",
      toolDescriptionOverrides: { search: "Find things" },
      excludedTools: ["execute", "shell"],
      excludedMiddleware: ["OptionalMW"],
      generalPurposeSubagent: {
        enabled: true,
        description: "GP",
        systemPrompt: "You delegate.",
      },
    });

    const serialized = serializeProfile(original);
    const restored = parseHarnessProfileConfig(serialized);

    expect(restored.baseSystemPrompt).toBe(original.baseSystemPrompt);
    expect(restored.systemPromptSuffix).toBe(original.systemPromptSuffix);
    expect({ ...restored.toolDescriptionOverrides }).toEqual({
      ...original.toolDescriptionOverrides,
    });
    expect([...restored.excludedTools].sort()).toEqual(
      [...original.excludedTools].sort(),
    );
    expect([...restored.excludedMiddleware]).toEqual([
      ...original.excludedMiddleware,
    ]);
    expect(restored.generalPurposeSubagent).toEqual(
      original.generalPurposeSubagent,
    );
  });

  it("round-trips an empty profile to an empty object", () => {
    const original = createHarnessProfile();
    const serialized = serializeProfile(original);
    expect(serialized).toEqual({});
    const restored = parseHarnessProfileConfig(serialized);
    expect(restored.baseSystemPrompt).toBeUndefined();
    expect(restored.excludedTools.size).toBe(0);
  });
});
