import { describe, it, expect } from "vitest";
import {
  buildSubagentSpecsPayload,
  SUBAGENT_SPECS_CONFIG_KEY,
  type SubAgent,
  type CompiledSubAgent,
} from "./subagents.js";

const DEFAULTS = {
  model: "openai:gpt-4o" as const,
  tools: [] as any[],
};

function makeDeclarativeSpec(name: string): SubAgent {
  return {
    name,
    description: `${name} description`,
    systemPrompt: `You are ${name}.`,
  };
}

function makeCompiledSpec(name: string): CompiledSubAgent {
  return {
    name,
    description: `${name} description`,
    runnable: { invoke: async () => ({}) } as any,
  };
}

describe("SUBAGENT_SPECS_CONFIG_KEY", () => {
  it("matches the Python constant value", () => {
    expect(SUBAGENT_SPECS_CONFIG_KEY).toBe("__deepagents_subagent_specs__");
  });
});

describe("buildSubagentSpecsPayload", () => {
  it("returns empty subagents for an empty array", () => {
    const payload = buildSubagentSpecsPayload([], DEFAULTS);
    expect(payload.subagents).toEqual([]);
  });

  it("packages a declarative SubAgent as a spec-based entry", () => {
    const spec = makeDeclarativeSpec("researcher");
    const payload = buildSubagentSpecsPayload([spec], DEFAULTS);

    expect(payload.subagents).toHaveLength(1);
    const entry = payload.subagents[0];
    expect(entry.name).toBe("researcher");
    expect(entry.description).toBe("researcher description");
    expect(entry.runnableBacked).toBe(false);
    expect(entry.runnable).toBeUndefined();
  });

  it("coalesces defaults into declarative specs", () => {
    const spec = makeDeclarativeSpec("researcher");
    const payload = buildSubagentSpecsPayload([spec], DEFAULTS);

    const entry = payload.subagents[0];
    expect(entry.spec.model).toBe("openai:gpt-4o");
    expect(entry.spec.tools).toEqual([]);
  });

  it("preserves spec model and tools when already set", () => {
    const spec: SubAgent = {
      ...makeDeclarativeSpec("researcher"),
      model: "anthropic:claude-sonnet-4-20250514",
      tools: [{ name: "custom" } as any],
    };
    const payload = buildSubagentSpecsPayload([spec], DEFAULTS);

    const entry = payload.subagents[0];
    expect(entry.spec.model).toBe("anthropic:claude-sonnet-4-20250514");
    expect(entry.spec.tools).toEqual([{ name: "custom" }]);
  });

  it("packages a CompiledSubAgent as a runnable-backed entry", () => {
    const compiled = makeCompiledSpec("coder");
    const payload = buildSubagentSpecsPayload([compiled], DEFAULTS);

    expect(payload.subagents).toHaveLength(1);
    const entry = payload.subagents[0];
    expect(entry.name).toBe("coder");
    expect(entry.description).toBe("coder description");
    expect(entry.runnableBacked).toBe(true);
    expect(entry.runnable).toBe(compiled.runnable);
  });

  it("creates a stub spec for compiled entries", () => {
    const compiled = makeCompiledSpec("coder");
    const payload = buildSubagentSpecsPayload([compiled], DEFAULTS);

    const entry = payload.subagents[0];
    expect(entry.spec).toEqual({
      name: "coder",
      description: "coder description",
      systemPrompt: "",
    });
  });

  it("handles mixed declarative and compiled subagents", () => {
    const spec = makeDeclarativeSpec("researcher");
    const compiled = makeCompiledSpec("coder");
    const payload = buildSubagentSpecsPayload([spec, compiled], DEFAULTS);

    expect(payload.subagents).toHaveLength(2);
    expect(payload.subagents[0].runnableBacked).toBe(false);
    expect(payload.subagents[0].name).toBe("researcher");
    expect(payload.subagents[1].runnableBacked).toBe(true);
    expect(payload.subagents[1].name).toBe("coder");
  });

  it("preserves entry order", () => {
    const specs = ["alpha", "beta", "gamma"].map(makeDeclarativeSpec);
    const payload = buildSubagentSpecsPayload(specs, DEFAULTS);

    expect(payload.subagents.map((e) => e.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});
