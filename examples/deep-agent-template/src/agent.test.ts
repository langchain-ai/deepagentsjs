/**
 * Unit tests for the deep agent graph configuration.
 *
 * These tests validate the graph structure, exported constants, and tool
 * behaviour **without** making any LLM API calls.
 */

import { describe, it, expect } from "vitest";
import { agent, SUBAGENTS, utcNow, confidenceCheck } from "./agent.js";

describe("graph structure", () => {
  it("should have a messages channel in its state", () => {
    const channels = Object.keys(agent.graph?.channels ?? {});
    expect(channels).toContain("messages");
  });

  it("should have the built-in deep-agent channels (todos, files)", () => {
    const channels = Object.keys(agent.graph?.channels ?? {});
    expect(channels).toContain("todos");
    expect(channels).toContain("files");
  });
});

describe("sub-agents", () => {
  it("should define exactly two sub-agents (researcher, critic)", () => {
    expect(SUBAGENTS).toHaveLength(2);
    const names = SUBAGENTS.map((s) => s.name);
    expect(names).toContain("researcher");
    expect(names).toContain("critic");
  });

  it("should give the researcher both tools", () => {
    const researcher = SUBAGENTS.find((s) => s.name === "researcher")!;
    const toolNames = researcher.tools!.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["utc_now", "confidence_check"])
    );
  });

  it("should give the critic only confidence_check", () => {
    const critic = SUBAGENTS.find((s) => s.name === "critic")!;
    const toolNames = critic.tools!.map((t) => t.name);
    expect(toolNames).toContain("confidence_check");
    expect(toolNames).not.toContain("utc_now");
  });

  it("should include system prompts for each sub-agent", () => {
    for (const sub of SUBAGENTS) {
      expect(sub.systemPrompt).toBeTruthy();
      expect(typeof sub.systemPrompt).toBe("string");
    }
  });
});

describe("utcNow tool", () => {
  it("should return a valid ISO-8601 timestamp", async () => {
    const result = await utcNow.invoke({});
    // ISO-8601 pattern: YYYY-MM-DDTHH:MM:SS.sssZ
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("should return a timestamp close to now", async () => {
    const before = Date.now();
    const result = await utcNow.invoke({});
    const after = Date.now();
    const ts = new Date(result as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("confidenceCheck tool", () => {
  it("should be named confidence_check", () => {
    expect(confidenceCheck.name).toBe("confidence_check");
  });

  it("should format a claim with its confidence", async () => {
    const result = await confidenceCheck.invoke({
      claim: "The sky is blue",
      confidence: 0.95,
    });
    expect(result).toContain("claim='The sky is blue'");
    expect(result).toContain("confidence=0.95");
  });

  it("should clamp confidence to [0, 1]", async () => {
    const tooHigh = await confidenceCheck.invoke({
      claim: "test",
      confidence: 5,
    });
    expect(tooHigh).toContain("confidence=1.00");

    const tooLow = await confidenceCheck.invoke({
      claim: "test",
      confidence: -3,
    });
    expect(tooLow).toContain("confidence=0.00");
  });

  it("should handle boundary values exactly", async () => {
    const zero = await confidenceCheck.invoke({
      claim: "x",
      confidence: 0,
    });
    expect(zero).toContain("confidence=0.00");

    const one = await confidenceCheck.invoke({
      claim: "x",
      confidence: 1,
    });
    expect(one).toContain("confidence=1.00");
  });
});
