import { describe, it, expect, beforeEach } from "vitest";
import {
  getHarnessProfile,
  hasUserRegisteredProfiles,
  ensureBuiltinsLoaded,
  registerHarnessProfile,
  _resetRegistryForTesting,
} from "./registry.js";

beforeEach(() => {
  _resetRegistryForTesting();
});

describe("built-in profile registration", () => {
  it("registers anthropic:claude-opus-4-7 with a non-empty systemPromptSuffix", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("anthropic:claude-opus-4-7")?.systemPromptSuffix,
    ).toBeTruthy();
  });

  it("registers anthropic:claude-sonnet-4-6 with a non-empty systemPromptSuffix", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("anthropic:claude-sonnet-4-6")?.systemPromptSuffix,
    ).toBeTruthy();
  });

  it("registers anthropic:claude-haiku-4-5 with a non-empty systemPromptSuffix", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("anthropic:claude-haiku-4-5")?.systemPromptSuffix,
    ).toBeTruthy();
  });

  it("registers openai:gpt-5.1-codex with a non-empty systemPromptSuffix", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("openai:gpt-5.1-codex")?.systemPromptSuffix,
    ).toBeTruthy();
  });

  it("registers openai:gpt-5.2-codex with a non-empty systemPromptSuffix", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("openai:gpt-5.2-codex")?.systemPromptSuffix,
    ).toBeTruthy();
  });

  it("registers openai:gpt-5.3-codex with a non-empty systemPromptSuffix", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("openai:gpt-5.3-codex")?.systemPromptSuffix,
    ).toBeTruthy();
  });
});

describe("built-in profile content", () => {
  it("opus 4.7 suffix contains <use_parallel_tool_calls>", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("anthropic:claude-opus-4-7")?.systemPromptSuffix,
    ).toContain("<use_parallel_tool_calls>");
  });

  it("opus 4.7 suffix contains <subagent_usage>", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("anthropic:claude-opus-4-7")?.systemPromptSuffix,
    ).toContain("<subagent_usage>");
  });

  it("opus 4.7 suffix contains <tool_usage>", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("anthropic:claude-opus-4-7")?.systemPromptSuffix,
    ).toContain("<tool_usage>");
  });

  it("sonnet 4.6 suffix contains <use_parallel_tool_calls>", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("anthropic:claude-sonnet-4-6")?.systemPromptSuffix,
    ).toContain("<use_parallel_tool_calls>");
  });

  it("sonnet 4.6 suffix does not contain <subagent_usage>", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("anthropic:claude-sonnet-4-6")?.systemPromptSuffix,
    ).not.toContain("<subagent_usage>");
  });

  it("haiku 4.5 suffix contains <use_parallel_tool_calls>", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("anthropic:claude-haiku-4-5")?.systemPromptSuffix,
    ).toContain("<use_parallel_tool_calls>");
  });

  it("codex suffix contains ## Plan Hygiene", () => {
    ensureBuiltinsLoaded();
    expect(
      getHarnessProfile("openai:gpt-5.1-codex")?.systemPromptSuffix,
    ).toContain("## Plan Hygiene");
  });

  it("all three codex variants share the same suffix", () => {
    ensureBuiltinsLoaded();
    const s1 = getHarnessProfile("openai:gpt-5.1-codex")?.systemPromptSuffix;
    const s2 = getHarnessProfile("openai:gpt-5.2-codex")?.systemPromptSuffix;
    const s3 = getHarnessProfile("openai:gpt-5.3-codex")?.systemPromptSuffix;
    expect(s1).toBe(s2);
    expect(s1).toBe(s3);
  });
});

describe("provider fallback with built-ins", () => {
  it("returns undefined for anthropic:unknown-model (no provider-wide anthropic profile)", () => {
    ensureBuiltinsLoaded();
    expect(getHarnessProfile("anthropic:unknown-model")).toBeUndefined();
  });

  it("returns undefined for openai:gpt-5.4 (non-Codex model, no provider-wide openai profile)", () => {
    ensureBuiltinsLoaded();
    expect(getHarnessProfile("openai:gpt-5.4")).toBeUndefined();
  });
});

describe("user registration after bootstrap", () => {
  it("user suffix wins when registered on top of a built-in", () => {
    registerHarnessProfile("anthropic:claude-opus-4-7", {
      systemPromptSuffix: "User override.",
    });
    const profile = getHarnessProfile("anthropic:claude-opus-4-7");
    expect(profile?.systemPromptSuffix).toBe("User override.");
  });

  it("hasUserRegisteredProfiles returns false when only built-ins are loaded", () => {
    ensureBuiltinsLoaded();
    expect(hasUserRegisteredProfiles()).toBe(false);
  });

  it("hasUserRegisteredProfiles returns false when merging onto an existing built-in key", () => {
    registerHarnessProfile("anthropic:claude-opus-4-7", {
      systemPromptSuffix: "User override.",
    });
    expect(hasUserRegisteredProfiles()).toBe(false);
  });

  it("hasUserRegisteredProfiles returns true after a user registration on a novel key", () => {
    registerHarnessProfile("openai:gpt-5.4", { systemPromptSuffix: "x" });
    expect(hasUserRegisteredProfiles()).toBe(true);
  });
});

describe("_resetRegistryForTesting with built-ins", () => {
  it("clears user registrations; built-ins reload automatically on next access", () => {
    registerHarnessProfile("openai:gpt-5.4", { systemPromptSuffix: "user" });
    expect(hasUserRegisteredProfiles()).toBe(true);

    _resetRegistryForTesting();

    expect(getHarnessProfile("openai:gpt-5.4")).toBeUndefined();
    expect(getHarnessProfile("anthropic:claude-opus-4-7")).toBeDefined();
    expect(hasUserRegisteredProfiles()).toBe(false);
  });

  it("resets builtinsLoaded so bootstrap runs again on next access", () => {
    ensureBuiltinsLoaded();
    _resetRegistryForTesting();
    expect(getHarnessProfile("anthropic:claude-sonnet-4-6")).toBeDefined();
  });
});
