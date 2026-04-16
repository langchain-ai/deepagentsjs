import { describe, it, expect } from "vitest";
import {
  parseTasksJsonl,
  serializeTasksJsonl,
  serializeResultsJsonl,
} from "./parse.js";
import type { SwarmTaskSpec, SwarmTaskResult } from "./types.js";

describe("parseTasksJsonl", () => {
  it("parses valid single-line JSONL", () => {
    const input = '{"id":"t1","description":"do thing"}\n';
    const tasks = parseTasksJsonl(input);
    expect(tasks).toEqual([{ id: "t1", description: "do thing" }]);
  });

  it("parses multiple lines", () => {
    const input = [
      '{"id":"t1","description":"first"}',
      '{"id":"t2","description":"second"}',
      '{"id":"t3","description":"third"}',
    ].join("\n");
    const tasks = parseTasksJsonl(input);
    expect(tasks).toHaveLength(3);
    expect(tasks[2].id).toBe("t3");
  });

  it("preserves optional subagentType", () => {
    const input =
      '{"id":"t1","description":"do thing","subagentType":"analyst"}\n';
    const tasks = parseTasksJsonl(input);
    expect(tasks[0].subagentType).toBe("analyst");
  });

  it("ignores blank lines", () => {
    const input =
      '{"id":"t1","description":"first"}\n\n\n{"id":"t2","description":"second"}\n';
    const tasks = parseTasksJsonl(input);
    expect(tasks).toHaveLength(2);
  });

  it("throws on empty content", () => {
    expect(() => parseTasksJsonl("")).toThrow("tasks.jsonl is empty");
  });

  it("throws on whitespace-only content", () => {
    expect(() => parseTasksJsonl("  \n  \n  ")).toThrow("tasks.jsonl is empty");
  });

  it("throws on invalid JSON", () => {
    const input = '{"id":"t1","description":"ok"}\nnot json\n';
    expect(() => parseTasksJsonl(input)).toThrow("Line 2: invalid JSON");
  });

  it("throws on missing id", () => {
    const input = '{"description":"no id"}\n';
    expect(() => parseTasksJsonl(input)).toThrow("validation failed");
  });

  it("throws on empty id", () => {
    const input = '{"id":"","description":"empty id"}\n';
    expect(() => parseTasksJsonl(input)).toThrow("validation failed");
  });

  it("throws on missing description", () => {
    const input = '{"id":"t1"}\n';
    expect(() => parseTasksJsonl(input)).toThrow("validation failed");
  });

  it("throws on empty description", () => {
    const input = '{"id":"t1","description":""}\n';
    expect(() => parseTasksJsonl(input)).toThrow("validation failed");
  });

  it("throws on duplicate task ids", () => {
    const input = [
      '{"id":"dup","description":"first"}',
      '{"id":"dup","description":"second"}',
    ].join("\n");
    expect(() => parseTasksJsonl(input)).toThrow('duplicate task id "dup"');
  });

  it("collects multiple errors before throwing", () => {
    const input = [
      "not json",
      '{"id":"","description":""}',
      '{"id":"t1","description":"ok"}',
    ].join("\n");
    try {
      parseTasksJsonl(input);
      expect.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Line 1:");
      expect(msg).toContain("Line 2:");
      expect(msg).not.toContain("Line 3:");
    }
  });

  it("strips extra properties (zod passthrough not used)", () => {
    const input = '{"id":"t1","description":"d","extra":"field"}\n';
    const tasks = parseTasksJsonl(input);
    expect(tasks[0]).not.toHaveProperty("extra");
  });
});

describe("serializeTasksJsonl", () => {
  it("serializes tasks to JSONL with trailing newline", () => {
    const tasks: SwarmTaskSpec[] = [
      { id: "t1", description: "first" },
      { id: "t2", description: "second" },
    ];
    const output = serializeTasksJsonl(tasks);
    const lines = output.split("\n");
    expect(lines).toHaveLength(3); // 2 lines + trailing empty
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0])).toEqual({ id: "t1", description: "first" });
    expect(JSON.parse(lines[1])).toEqual({ id: "t2", description: "second" });
  });

  it("includes subagentType when present", () => {
    const tasks: SwarmTaskSpec[] = [
      { id: "t1", description: "d", subagentType: "analyst" },
    ];
    const output = serializeTasksJsonl(tasks);
    expect(JSON.parse(output.trim())).toHaveProperty("subagentType", "analyst");
  });

  it("handles empty array", () => {
    expect(serializeTasksJsonl([])).toBe("\n");
  });

  it("round-trips through parseTasksJsonl", () => {
    const tasks: SwarmTaskSpec[] = [
      { id: "a", description: "alpha" },
      { id: "b", description: "beta", subagentType: "custom" },
    ];
    const serialized = serializeTasksJsonl(tasks);
    const parsed = parseTasksJsonl(serialized);
    expect(parsed).toEqual(tasks);
  });
});

describe("serializeResultsJsonl", () => {
  it("serializes results to JSONL with trailing newline", () => {
    const results: SwarmTaskResult[] = [
      {
        id: "t1",
        subagentType: "general-purpose",
        status: "completed",
        result: "done",
      },
      {
        id: "t2",
        subagentType: "general-purpose",
        status: "failed",
        error: "timeout",
      },
    ];
    const output = serializeResultsJsonl(results);
    const lines = output.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.status).toBe("completed");
    expect(first.result).toBe("done");

    const second = JSON.parse(lines[1]);
    expect(second.status).toBe("failed");
    expect(second.error).toBe("timeout");
  });

  it("handles empty array", () => {
    expect(serializeResultsJsonl([])).toBe("\n");
  });
});
