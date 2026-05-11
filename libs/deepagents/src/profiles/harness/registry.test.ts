import { describe, it, expect, beforeEach } from "vitest";
import {
  registerHarnessProfile,
  registerHarnessProfileImpl,
  getHarnessProfile,
  resolveHarnessProfile,
  applyProfilePrompt,
  hasUserRegisteredProfiles,
  snapshotBuiltinKeys,
  _resetRegistryForTesting,
} from "./registry.js";
import { createHarnessProfile, EMPTY_HARNESS_PROFILE } from "./create.js";

beforeEach(() => {
  _resetRegistryForTesting();
});

describe("registerHarnessProfile + getHarnessProfile", () => {
  it("registers and retrieves a profile by exact key", () => {
    registerHarnessProfile("openai:gpt-5.4", {
      systemPromptSuffix: "Be concise.",
    });
    const profile = getHarnessProfile("openai:gpt-5.4");
    expect(profile?.systemPromptSuffix).toBe("Be concise.");
  });

  it("accepts a pre-built HarnessProfile", () => {
    const profile = createHarnessProfile({ systemPromptSuffix: "Pre-built." });
    registerHarnessProfile("openai:gpt-5.4", profile);
    expect(getHarnessProfile("openai:gpt-5.4")?.systemPromptSuffix).toBe(
      "Pre-built.",
    );
  });

  it("returns undefined for an unregistered key", () => {
    expect(getHarnessProfile("openai:gpt-5.4")).toBeUndefined();
  });

  it("falls back to provider profile when no exact match exists", () => {
    registerHarnessProfile("openai", {
      systemPromptSuffix: "Provider default.",
    });
    const profile = getHarnessProfile("openai:gpt-5.4");
    expect(profile?.systemPromptSuffix).toBe("Provider default.");
  });

  it("merges provider and exact profiles when both exist", () => {
    registerHarnessProfile("openai", { excludedTools: ["shell"] });
    registerHarnessProfile("openai:gpt-5.4", { excludedTools: ["grep"] });
    const profile = getHarnessProfile("openai:gpt-5.4");
    expect(profile?.excludedTools.has("shell")).toBe(true);
    expect(profile?.excludedTools.has("grep")).toBe(true);
  });

  it("exact profile scalar wins over provider profile scalar", () => {
    registerHarnessProfile("openai", { systemPromptSuffix: "Provider." });
    registerHarnessProfile("openai:gpt-5.4", { systemPromptSuffix: "Model." });
    const profile = getHarnessProfile("openai:gpt-5.4");
    expect(profile?.systemPromptSuffix).toBe("Model.");
  });

  it("returns undefined for a spec with multiple colons", () => {
    expect(getHarnessProfile("a:b:c")).toBeUndefined();
  });

  it("returns undefined for a spec with empty halves", () => {
    expect(getHarnessProfile(":model")).toBeUndefined();
    expect(getHarnessProfile("provider:")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    registerHarnessProfile("openai", { systemPromptSuffix: "x" });
    expect(getHarnessProfile("")).toBeUndefined();
  });

  it("returns a provider profile when looking up a bare provider key", () => {
    registerHarnessProfile("openai", { systemPromptSuffix: "Provider." });
    const profile = getHarnessProfile("openai");
    expect(profile?.systemPromptSuffix).toBe("Provider.");
  });
});

describe("additive merge on re-registration", () => {
  it("unions excludedTools across registrations", () => {
    registerHarnessProfile("openai", { excludedTools: ["shell"] });
    registerHarnessProfile("openai", { excludedTools: ["grep"] });
    const profile = getHarnessProfile("openai");
    expect(profile?.excludedTools.has("shell")).toBe(true);
    expect(profile?.excludedTools.has("grep")).toBe(true);
  });

  it("second scalar wins over first", () => {
    registerHarnessProfile("openai", { systemPromptSuffix: "first" });
    registerHarnessProfile("openai", { systemPromptSuffix: "second" });
    expect(getHarnessProfile("openai")?.systemPromptSuffix).toBe("second");
  });

  it("merges toolDescriptionOverrides across registrations", () => {
    registerHarnessProfile("openai", {
      toolDescriptionOverrides: { search: "Find" },
    });
    registerHarnessProfile("openai", {
      toolDescriptionOverrides: { execute: "Run" },
    });
    const profile = getHarnessProfile("openai");
    expect(profile?.toolDescriptionOverrides).toMatchObject({
      search: "Find",
      execute: "Run",
    });
  });
});

describe("applyProfilePrompt", () => {
  it("returns basePrompt unchanged when profile has no overrides", () => {
    const profile = createHarnessProfile();
    expect(applyProfilePrompt(profile, "Default prompt.")).toBe(
      "Default prompt.",
    );
  });

  it("replaces base prompt when baseSystemPrompt is set", () => {
    const profile = createHarnessProfile({
      baseSystemPrompt: "Replacement prompt.",
    });
    expect(applyProfilePrompt(profile, "Default prompt.")).toBe(
      "Replacement prompt.",
    );
  });

  it("appends suffix with double newline when systemPromptSuffix is set", () => {
    const profile = createHarnessProfile({
      systemPromptSuffix: "Think step by step.",
    });
    expect(applyProfilePrompt(profile, "Default prompt.")).toBe(
      "Default prompt.\n\nThink step by step.",
    );
  });

  it("replaces base then appends suffix when both are set", () => {
    const profile = createHarnessProfile({
      baseSystemPrompt: "New base.",
      systemPromptSuffix: "And a suffix.",
    });
    expect(applyProfilePrompt(profile, "Default prompt.")).toBe(
      "New base.\n\nAnd a suffix.",
    );
  });
});

describe("resolveHarnessProfile", () => {
  it("resolves by spec string", () => {
    registerHarnessProfile("anthropic:claude-opus-4-7", {
      systemPromptSuffix: "Opus suffix.",
    });
    const profile = resolveHarnessProfile({
      spec: "anthropic:claude-opus-4-7",
    });
    expect(profile.systemPromptSuffix).toBe("Opus suffix.");
  });

  it("returns EMPTY_HARNESS_PROFILE when spec matches nothing", () => {
    expect(resolveHarnessProfile({ spec: "unknown:model" })).toBe(
      EMPTY_HARNESS_PROFILE,
    );
  });

  it("resolves provider:identifier when no spec", () => {
    registerHarnessProfile("anthropic:claude-opus-4-7", {
      systemPromptSuffix: "Opus.",
    });
    const profile = resolveHarnessProfile({
      providerHint: "anthropic",
      identifierHint: "claude-opus-4-7",
    });
    expect(profile.systemPromptSuffix).toBe("Opus.");
  });

  it("resolves by identifierHint when it contains a colon", () => {
    registerHarnessProfile("anthropic:claude-opus-4-7", {
      systemPromptSuffix: "Opus.",
    });
    const profile = resolveHarnessProfile({
      identifierHint: "anthropic:claude-opus-4-7",
    });
    expect(profile.systemPromptSuffix).toBe("Opus.");
  });

  it("resolves by providerHint alone when identifier gives no match", () => {
    registerHarnessProfile("anthropic", { systemPromptSuffix: "Provider." });
    const profile = resolveHarnessProfile({
      providerHint: "anthropic",
      identifierHint: "unknown-model",
    });
    expect(profile.systemPromptSuffix).toBe("Provider.");
  });

  it("returns EMPTY_HARNESS_PROFILE when no hints match", () => {
    expect(
      resolveHarnessProfile({
        providerHint: "unknown",
        identifierHint: "model",
      }),
    ).toBe(EMPTY_HARNESS_PROFILE);
  });

  it("returns EMPTY_HARNESS_PROFILE when called with no arguments", () => {
    expect(resolveHarnessProfile()).toBe(EMPTY_HARNESS_PROFILE);
  });
});

describe("hasUserRegisteredProfiles", () => {
  it("returns false when no profiles are registered", () => {
    expect(hasUserRegisteredProfiles()).toBe(false);
  });

  it("returns true after a user registration", () => {
    registerHarnessProfile("openai", { systemPromptSuffix: "x" });
    expect(hasUserRegisteredProfiles()).toBe(true);
  });

  it("returns false for built-in profiles snapshotted before user registration", () => {
    registerHarnessProfileImpl(
      "anthropic:claude-opus-4-7",
      createHarnessProfile({ systemPromptSuffix: "builtin" }),
    );
    snapshotBuiltinKeys();
    expect(hasUserRegisteredProfiles()).toBe(false);

    registerHarnessProfile("openai", { systemPromptSuffix: "user" });
    expect(hasUserRegisteredProfiles()).toBe(true);
  });
});

describe("_resetRegistryForTesting", () => {
  it("clears all registered profiles", () => {
    registerHarnessProfile("openai", { systemPromptSuffix: "x" });
    _resetRegistryForTesting();
    expect(getHarnessProfile("openai")).toBeUndefined();
  });

  it("resets builtinsLoaded so bootstrap runs again", () => {
    registerHarnessProfile("openai", { systemPromptSuffix: "x" });
    _resetRegistryForTesting();
    expect(hasUserRegisteredProfiles()).toBe(false);
  });
});
