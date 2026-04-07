import { describe, it, expect } from "vitest";
import { parseTasksJsonl, serializeResultsJsonl } from "./parse.js";
import type { SwarmTaskResult } from "./types.js";

describe("parseTasksJsonl", () => {
  describe("valid input", () => {
    it("should parse a single valid task", () => {
      const content = JSON.stringify({ id: "task-1", description: "Do something" });
      const result = parseTasksJsonl(content);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: "task-1", description: "Do something" });
    });

    it("should parse multiple valid tasks", () => {
      const lines = [
        JSON.stringify({ id: "task-1", description: "First task" }),
        JSON.stringify({ id: "task-2", description: "Second task" }),
        JSON.stringify({ id: "task-3", description: "Third task" }),
      ].join("\n");
      const result = parseTasksJsonl(lines);
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("task-1");
      expect(result[1].id).toBe("task-2");
      expect(result[2].id).toBe("task-3");
    });

    it("should include subagentType when present", () => {
      const content = JSON.stringify({
        id: "task-1",
        description: "Do something",
        subagentType: "researcher",
      });
      const result = parseTasksJsonl(content);
      expect(result[0].subagentType).toBe("researcher");
    });

    it("should not include subagentType when absent", () => {
      const content = JSON.stringify({ id: "task-1", description: "Do something" });
      const result = parseTasksJsonl(content);
      expect(result[0]).not.toHaveProperty("subagentType");
    });
  });

  describe("empty input", () => {
    it("should throw when content is an empty string", () => {
      expect(() => parseTasksJsonl("")).toThrow(
        "tasks.jsonl is empty. The generation script must write at least one task.",
      );
    });

    it("should throw when content contains only whitespace and newlines", () => {
      expect(() => parseTasksJsonl("   \n\n   \n  ")).toThrow(
        "tasks.jsonl is empty. The generation script must write at least one task.",
      );
    });
  });

  describe("invalid JSON", () => {
    it("should collect an error for a line with invalid JSON and throw at the end", () => {
      const content = "not valid json";
      expect(() => parseTasksJsonl(content)).toThrow(
        "tasks.jsonl validation failed:",
      );
    });

    it("should report the correct line number for invalid JSON", () => {
      const lines = [
        JSON.stringify({ id: "task-1", description: "Valid" }),
        "{ bad json",
      ].join("\n");
      expect(() => parseTasksJsonl(lines)).toThrow("Line 2: invalid JSON");
    });
  });

  describe("schema validation errors", () => {
    it("should collect an error when id is missing", () => {
      const content = JSON.stringify({ description: "No id here" });
      expect(() => parseTasksJsonl(content)).toThrow(
        "tasks.jsonl validation failed:",
      );
    });

    it("should collect an error when description is missing", () => {
      const content = JSON.stringify({ id: "task-1" });
      expect(() => parseTasksJsonl(content)).toThrow(
        "tasks.jsonl validation failed:",
      );
    });

    it("should collect an error when id is an empty string", () => {
      const content = JSON.stringify({ id: "", description: "Some description" });
      expect(() => parseTasksJsonl(content)).toThrow(
        "tasks.jsonl validation failed:",
      );
    });

    it("should collect an error when description is an empty string", () => {
      const content = JSON.stringify({ id: "task-1", description: "" });
      expect(() => parseTasksJsonl(content)).toThrow(
        "tasks.jsonl validation failed:",
      );
    });
  });

  describe("duplicate IDs", () => {
    it("should collect an error for duplicate task IDs", () => {
      const lines = [
        JSON.stringify({ id: "task-1", description: "First" }),
        JSON.stringify({ id: "task-1", description: "Duplicate" }),
      ].join("\n");
      expect(() => parseTasksJsonl(lines)).toThrow(
        'duplicate task id "task-1"',
      );
    });
  });

  describe("multiple errors", () => {
    it("should report all errors across lines in a single throw", () => {
      const lines = [
        "{ bad json",
        JSON.stringify({ id: "", description: "Empty id" }),
        JSON.stringify({ id: "task-3", description: "Valid" }),
        JSON.stringify({ description: "Missing id" }),
      ].join("\n");

      let errorMessage = "";
      try {
        parseTasksJsonl(lines);
      } catch (e) {
        errorMessage = (e as Error).message;
      }

      expect(errorMessage).toContain("tasks.jsonl validation failed:");
      expect(errorMessage).toContain("Line 1: invalid JSON");
      expect(errorMessage).toContain("Line 2:");
      expect(errorMessage).toContain("Line 4:");
    });
  });
});

describe("serializeResultsJsonl", () => {
  it("should serialize results to JSONL with one object per line and a trailing newline", () => {
    const results: SwarmTaskResult[] = [
      { id: "task-1", description: "First", status: "completed", result: "Done" },
      { id: "task-2", description: "Second", status: "failed", error: "Oops" },
    ];
    const output = serializeResultsJsonl(results);
    const lines = output.split("\n");
    // Two data lines plus one empty string from the trailing newline
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0])).toEqual(results[0]);
    expect(JSON.parse(lines[1])).toEqual(results[1]);
  });

  it("should round-trip correctly through parse and serialize", () => {
    const original: SwarmTaskResult[] = [
      {
        id: "task-1",
        description: "Research something",
        subagentType: "researcher",
        status: "completed",
        result: "Found it",
      },
      {
        id: "task-2",
        description: "Write a report",
        status: "failed",
        error: "Ran out of tokens",
      },
    ];

    // Serialize results to JSONL
    const serialized = serializeResultsJsonl(original);

    // Parse the serialized output back as task specs (id, description, subagentType)
    const parsed = parseTasksJsonl(serialized);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe(original[0].id);
    expect(parsed[0].description).toBe(original[0].description);
    expect(parsed[0].subagentType).toBe(original[0].subagentType);
    expect(parsed[1].id).toBe(original[1].id);
    expect(parsed[1].description).toBe(original[1].description);
    expect(parsed[1]).not.toHaveProperty("subagentType");
  });
});
