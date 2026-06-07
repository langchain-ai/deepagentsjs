import { describe, it, expect } from "vitest";
import { mergeProfiles } from "./merge.js";
import { createHarnessProfile } from "./create.js";
import { resolveMiddleware } from "./types.js";

describe("mergeProfiles — scalar fields", () => {
  it("override wins when set", () => {
    const base = createHarnessProfile({
      baseSystemPrompt: "base prompt",
      systemPromptSuffix: "base suffix",
    });
    const override = createHarnessProfile({
      baseSystemPrompt: "override prompt",
      systemPromptSuffix: "override suffix",
    });
    const merged = mergeProfiles(base, override);
    expect(merged.baseSystemPrompt).toBe("override prompt");
    expect(merged.systemPromptSuffix).toBe("override suffix");
  });

  it("base value is kept when override field is undefined", () => {
    const base = createHarnessProfile({
      baseSystemPrompt: "base prompt",
      systemPromptSuffix: "base suffix",
    });
    const merged = mergeProfiles(base, createHarnessProfile());
    expect(merged.baseSystemPrompt).toBe("base prompt");
    expect(merged.systemPromptSuffix).toBe("base suffix");
  });

  it("result is undefined when both fields are undefined", () => {
    const merged = mergeProfiles(
      createHarnessProfile(),
      createHarnessProfile(),
    );
    expect(merged.baseSystemPrompt).toBeUndefined();
    expect(merged.systemPromptSuffix).toBeUndefined();
  });
});

describe("mergeProfiles — toolDescriptionOverrides", () => {
  it("merges keys from both profiles; override wins on conflict", () => {
    const base = createHarnessProfile({
      toolDescriptionOverrides: { search: "Find things", execute: "Run code" },
    });
    const override = createHarnessProfile({
      toolDescriptionOverrides: {
        execute: "Execute safely",
        grep: "Search files",
      },
    });
    const merged = mergeProfiles(base, override);
    expect(merged.toolDescriptionOverrides).toMatchObject({
      search: "Find things",
      execute: "Execute safely",
      grep: "Search files",
    });
  });

  it("returns empty overrides when both are empty", () => {
    const merged = mergeProfiles(
      createHarnessProfile(),
      createHarnessProfile(),
    );
    expect(Object.keys(merged.toolDescriptionOverrides)).toHaveLength(0);
  });
});

describe("mergeProfiles — set union (excludedTools / excludedMiddleware)", () => {
  it("unions excludedTools from both profiles", () => {
    const base = createHarnessProfile({ excludedTools: ["shell", "execute"] });
    const override = createHarnessProfile({
      excludedTools: ["execute", "grep"],
    });
    const merged = mergeProfiles(base, override);
    expect(merged.excludedTools.has("shell")).toBe(true);
    expect(merged.excludedTools.has("execute")).toBe(true);
    expect(merged.excludedTools.has("grep")).toBe(true);
  });

  it("unions excludedMiddleware from both profiles", () => {
    const base = createHarnessProfile({ excludedMiddleware: ["MwA"] });
    const override = createHarnessProfile({ excludedMiddleware: ["MwB"] });
    const merged = mergeProfiles(base, override);
    expect(merged.excludedMiddleware.has("MwA")).toBe(true);
    expect(merged.excludedMiddleware.has("MwB")).toBe(true);
  });

  it("keeps base tools when override has none", () => {
    const base = createHarnessProfile({ excludedTools: ["shell"] });
    const merged = mergeProfiles(base, createHarnessProfile());
    expect(merged.excludedTools.has("shell")).toBe(true);
  });
});

describe("mergeProfiles — extraMiddleware by name", () => {
  const mwA1 = { name: "MwA", version: 1 } as any;
  const mwA2 = { name: "MwA", version: 2 } as any;
  const mwB = { name: "MwB" } as any;
  const mwC = { name: "MwC" } as any;

  it("override instance replaces base instance at same position", () => {
    const base = createHarnessProfile({ extraMiddleware: [mwA1, mwB] });
    const override = createHarnessProfile({ extraMiddleware: [mwA2] });
    const merged = mergeProfiles(base, override);
    const mw = resolveMiddleware(merged.extraMiddleware);
    expect(mw[0]).toBe(mwA2);
    expect(mw[1]).toBe(mwB);
    expect(mw).toHaveLength(2);
  });

  it("novel override names are appended after base entries", () => {
    const base = createHarnessProfile({ extraMiddleware: [mwA1] });
    const override = createHarnessProfile({ extraMiddleware: [mwB, mwC] });
    const merged = mergeProfiles(base, override);
    const mw = resolveMiddleware(merged.extraMiddleware);
    expect(mw[0]).toBe(mwA1);
    expect(mw[1]).toBe(mwB);
    expect(mw[2]).toBe(mwC);
  });

  it("base duplicate names: only first occurrence is replaced", () => {
    const mwA1b = { name: "MwA", version: "1b" } as any;
    const base = createHarnessProfile({ extraMiddleware: [mwA1, mwA1b] });
    const override = createHarnessProfile({ extraMiddleware: [mwA2] });
    const merged = mergeProfiles(base, override);
    const mw = resolveMiddleware(merged.extraMiddleware);
    expect(mw[0]).toBe(mwA2);
    expect(mw).toHaveLength(1);
  });

  it("returns override array when base is empty", () => {
    const override = createHarnessProfile({ extraMiddleware: [mwA1] });
    const merged = mergeProfiles(createHarnessProfile(), override);
    const mw = resolveMiddleware(merged.extraMiddleware);
    expect(mw).toEqual([mwA1]);
  });

  it("returns base array when override is empty", () => {
    const base = createHarnessProfile({ extraMiddleware: [mwA1] });
    const merged = mergeProfiles(base, createHarnessProfile());
    const mw = resolveMiddleware(merged.extraMiddleware);
    expect(mw).toEqual([mwA1]);
  });

  it("resolves factories on each call for fresh instances", () => {
    let instanceId = 0;
    const factory = () => [{ name: "MwA", id: ++instanceId } as any];
    const base = createHarnessProfile({ extraMiddleware: [mwB] });
    const override = createHarnessProfile({ extraMiddleware: factory });
    const merged = mergeProfiles(base, override);

    const first = resolveMiddleware(merged.extraMiddleware);
    const second = resolveMiddleware(merged.extraMiddleware);

    const firstA = first.find((m) => m.name === "MwA") as any;
    const secondA = second.find((m) => m.name === "MwA") as any;
    expect(firstA).not.toBe(secondA);
    expect(firstA.id).toBeLessThan(secondA.id);
  });
});

describe("mergeProfiles — generalPurposeSubagent", () => {
  it("override wins per sub-field when set", () => {
    const base = createHarnessProfile({
      generalPurposeSubagent: { enabled: true, description: "base desc" },
    });
    const override = createHarnessProfile({
      generalPurposeSubagent: { description: "override desc" },
    });
    const merged = mergeProfiles(base, override);
    expect(merged.generalPurposeSubagent?.enabled).toBe(true);
    expect(merged.generalPurposeSubagent?.description).toBe("override desc");
  });

  it("inherits base sub-fields when override field is undefined", () => {
    const base = createHarnessProfile({
      generalPurposeSubagent: {
        enabled: false,
        description: "base",
        systemPrompt: "sp",
      },
    });
    const merged = mergeProfiles(base, createHarnessProfile());
    expect(merged.generalPurposeSubagent?.enabled).toBe(false);
    expect(merged.generalPurposeSubagent?.description).toBe("base");
    expect(merged.generalPurposeSubagent?.systemPrompt).toBe("sp");
  });

  it("returns undefined when both are undefined", () => {
    const merged = mergeProfiles(
      createHarnessProfile(),
      createHarnessProfile(),
    );
    expect(merged.generalPurposeSubagent).toBeUndefined();
  });

  it("uses override config when base has none", () => {
    const override = createHarnessProfile({
      generalPurposeSubagent: { enabled: false },
    });
    const merged = mergeProfiles(createHarnessProfile(), override);
    expect(merged.generalPurposeSubagent?.enabled).toBe(false);
  });
});

describe("mergeProfiles — result is frozen", () => {
  it("returns a frozen profile", () => {
    const merged = mergeProfiles(
      createHarnessProfile({ systemPromptSuffix: "a" }),
      createHarnessProfile({ systemPromptSuffix: "b" }),
    );
    expect(Object.isFrozen(merged)).toBe(true);
  });
});
