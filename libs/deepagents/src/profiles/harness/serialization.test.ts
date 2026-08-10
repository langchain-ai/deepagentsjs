import { describe, it, expect } from "vitest";
import {
  parseHarnessProfileConfig,
  serializeProfile,
} from "./serialization.js";
import { createHarnessProfile } from "./create.js";

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
