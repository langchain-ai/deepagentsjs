import { describe, it, expect } from "vitest";
import {
  parseSubagentMarkers,
  hasSubagentMarkers,
  SUBAGENT_MARKER_PREFIX,
} from "./subagents.js";

describe("subagent marker parsing", () => {
  describe("SUBAGENT_MARKER_PREFIX", () => {
    it("should have the correct prefix value", () => {
      expect(SUBAGENT_MARKER_PREFIX).toBe("SUBAGENT_TASK: ");
    });
  });

  describe("hasSubagentMarkers", () => {
    it("should return true when markers are present", () => {
      const output = `Some output
SUBAGENT_TASK: {"description": "test", "type": "general-purpose"}
More output`;
      expect(hasSubagentMarkers(output)).toBe(true);
    });

    it("should return false when no markers are present", () => {
      const output = "Just regular output\nNo markers here";
      expect(hasSubagentMarkers(output)).toBe(false);
    });

    it("should return false for empty output", () => {
      expect(hasSubagentMarkers("")).toBe(false);
    });

    it("should return true even for partial/malformed markers", () => {
      const output = "SUBAGENT_TASK: not valid json";
      expect(hasSubagentMarkers(output)).toBe(true);
    });
  });

  describe("parseSubagentMarkers", () => {
    describe("basic parsing", () => {
      it("should parse a single valid marker", () => {
        const output = `Processing...
SUBAGENT_TASK: {"description": "Analyze data", "type": "general-purpose"}
Done.`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(1);
        expect(result.subagentTasks[0]).toEqual({
          description: "Analyze data",
          type: "general-purpose",
        });
        expect(result.cleanOutput).toBe("Processing...\nDone.");
        expect(result.warnings).toHaveLength(0);
      });

      it("should parse multiple markers", () => {
        const output = `Start
SUBAGENT_TASK: {"description": "Task 1", "type": "general-purpose"}
Middle
SUBAGENT_TASK: {"description": "Task 2", "type": "research"}
SUBAGENT_TASK: {"description": "Task 3", "type": "general-purpose"}
End`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(3);
        expect(result.subagentTasks[0]).toEqual({
          description: "Task 1",
          type: "general-purpose",
        });
        expect(result.subagentTasks[1]).toEqual({
          description: "Task 2",
          type: "research",
        });
        expect(result.subagentTasks[2]).toEqual({
          description: "Task 3",
          type: "general-purpose",
        });
        expect(result.cleanOutput).toBe("Start\nMiddle\nEnd");
      });

      it("should return output unchanged when no markers", () => {
        const output = "Just regular output\nNo markers here";

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(0);
        expect(result.cleanOutput).toBe(output);
        expect(result.warnings).toHaveLength(0);
      });
    });

    describe("type handling", () => {
      it("should default type to general-purpose when not specified", () => {
        const output = `SUBAGENT_TASK: {"description": "Test task"}`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(1);
        expect(result.subagentTasks[0].type).toBe("general-purpose");
      });

      it("should preserve custom type when specified", () => {
        const output = `SUBAGENT_TASK: {"description": "Test", "type": "custom-agent"}`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks[0].type).toBe("custom-agent");
      });

      it("should default type when type is null", () => {
        const output = `SUBAGENT_TASK: {"description": "Test", "type": null}`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks[0].type).toBe("general-purpose");
      });

      it("should default type when type is a number", () => {
        const output = `SUBAGENT_TASK: {"description": "Test", "type": 123}`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks[0].type).toBe("general-purpose");
      });
    });

    describe("error handling", () => {
      it("should add warning for malformed JSON", () => {
        const output = `Good line
SUBAGENT_TASK: {not valid json}
Another good line`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(0);
        expect(result.cleanOutput).toBe(
          "Good line\nSUBAGENT_TASK: {not valid json}\nAnother good line",
        );
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("malformed subagent marker JSON");
      });

      it("should add warning for missing description", () => {
        const output = `SUBAGENT_TASK: {"type": "general-purpose"}`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(0);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("missing description");
      });

      it("should add warning for empty description", () => {
        const output = `SUBAGENT_TASK: {"description": "", "type": "general-purpose"}`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(0);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("missing description");
      });

      it("should add warning for whitespace-only description", () => {
        const output = `SUBAGENT_TASK: {"description": "   ", "type": "general-purpose"}`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(0);
        expect(result.warnings).toHaveLength(1);
      });

      it("should continue parsing after malformed marker", () => {
        const output = `SUBAGENT_TASK: {bad json}
SUBAGENT_TASK: {"description": "Valid task", "type": "general-purpose"}`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(1);
        expect(result.subagentTasks[0].description).toBe("Valid task");
        expect(result.warnings).toHaveLength(1);
      });
    });

    describe("edge cases", () => {
      it("should handle empty output", () => {
        const result = parseSubagentMarkers("");

        expect(result.subagentTasks).toHaveLength(0);
        expect(result.cleanOutput).toBe("");
        expect(result.warnings).toHaveLength(0);
      });

      it("should handle output with only markers", () => {
        const output = `SUBAGENT_TASK: {"description": "Task 1", "type": "general-purpose"}
SUBAGENT_TASK: {"description": "Task 2", "type": "general-purpose"}`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(2);
        expect(result.cleanOutput).toBe("");
      });

      it("should handle special characters in description", () => {
        const output = `SUBAGENT_TASK: {"description": "Handle 'quotes' and \\"escaped\\" chars", "type": "general-purpose"}`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(1);
        expect(result.subagentTasks[0].description).toBe(
          "Handle 'quotes' and \"escaped\" chars",
        );
      });

      it("should handle unicode in description", () => {
        const output = `SUBAGENT_TASK: {"description": "Process émojis 🚀 and ünïcödé", "type": "general-purpose"}`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(1);
        expect(result.subagentTasks[0].description).toBe(
          "Process émojis 🚀 and ünïcödé",
        );
      });

      it("should trim whitespace from JSON", () => {
        const output = `SUBAGENT_TASK:    {"description": "Test", "type": "general-purpose"}   `;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(1);
        expect(result.subagentTasks[0].description).toBe("Test");
      });

      it("should handle newlines in the middle of output", () => {
        const output =
          'Line 1\n\n\nLine 2\nSUBAGENT_TASK: {"description": "Test", "type": "general-purpose"}\n\nLine 3';

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(1);
        expect(result.cleanOutput).toBe("Line 1\n\n\nLine 2\n\nLine 3");
      });
    });

    describe("realistic scenarios", () => {
      it("should parse output from a CSV processing loop", () => {
        const output = `Processing tasks.csv...
SUBAGENT_TASK: {"description": "Analyze Q1 sales for North region", "type": "general-purpose"}
SUBAGENT_TASK: {"description": "Analyze Q2 sales for South region", "type": "general-purpose"}
SUBAGENT_TASK: {"description": "Analyze Q3 sales for East region", "type": "general-purpose"}
Finished processing 3 rows.`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(3);
        expect(result.subagentTasks[0].description).toBe(
          "Analyze Q1 sales for North region",
        );
        expect(result.cleanOutput).toBe(
          "Processing tasks.csv...\nFinished processing 3 rows.",
        );
      });

      it("should handle mixed valid and invalid markers", () => {
        const output = `Starting batch...
SUBAGENT_TASK: {"description": "Valid task 1", "type": "general-purpose"}
SUBAGENT_TASK: {broken
SUBAGENT_TASK: {"description": "Valid task 2", "type": "research"}
SUBAGENT_TASK: {"type": "no-description"}
SUBAGENT_TASK: {"description": "Valid task 3", "type": "general-purpose"}
Done.`;

        const result = parseSubagentMarkers(output);

        expect(result.subagentTasks).toHaveLength(3);
        expect(result.subagentTasks.map((t) => t.description)).toEqual([
          "Valid task 1",
          "Valid task 2",
          "Valid task 3",
        ]);
        expect(result.warnings).toHaveLength(2); // broken JSON + missing description
      });
    });
  });
});
