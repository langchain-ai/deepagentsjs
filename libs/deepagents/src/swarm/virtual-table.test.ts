import { describe, it, expect, vi } from "vitest";
import { resolveVirtualTableTasks } from "./virtual-table.js";
import type { BackendProtocolV2 } from "../backends/v2/protocol.js";

function createMockBackend(
  files: Record<string, { path: string }[]> = {},
): BackendProtocolV2 {
  return {
    glob: vi.fn(async (pattern: string) => {
      if (pattern in files) {
        return { files: files[pattern] };
      }
      return { files: [] };
    }),
  } as unknown as BackendProtocolV2;
}

describe("resolveVirtualTableTasks", () => {
  describe("explicit filePaths", () => {
    it("creates one task per file path", async () => {
      const backend = createMockBackend();
      const result = await resolveVirtualTableTasks(
        {
          filePaths: ["data/a.txt", "data/b.txt"],
          instruction: "Classify this file",
        },
        backend,
      );

      expect("error" in result).toBe(false);
      if ("tasks" in result) {
        expect(result.tasks).toHaveLength(2);
        expect(result.tasks[0].description).toBe(
          "Classify this file\n\nFile: data/a.txt",
        );
        expect(result.tasks[1].description).toBe(
          "Classify this file\n\nFile: data/b.txt",
        );
      }
    });

    it("uses basename as task id", async () => {
      const backend = createMockBackend();
      const result = await resolveVirtualTableTasks(
        { filePaths: ["data/report.txt"], instruction: "Summarize" },
        backend,
      );

      expect("tasks" in result).toBe(true);
      if ("tasks" in result) {
        expect(result.tasks[0].id).toBe("report.txt");
      }
    });

    it("disambiguates basename collisions with parent dir", async () => {
      const backend = createMockBackend();
      const result = await resolveVirtualTableTasks(
        {
          filePaths: ["en/readme.md", "fr/readme.md"],
          instruction: "Translate",
        },
        backend,
      );

      expect("tasks" in result).toBe(true);
      if ("tasks" in result) {
        const ids = result.tasks.map((t) => t.id);
        expect(ids).toContain("en-readme.md");
        expect(ids).toContain("fr-readme.md");
      }
    });

    it("deduplicates file paths", async () => {
      const backend = createMockBackend();
      const result = await resolveVirtualTableTasks(
        {
          filePaths: ["data/a.txt", "data/a.txt", "data/a.txt"],
          instruction: "Analyze",
        },
        backend,
      );

      expect("tasks" in result).toBe(true);
      if ("tasks" in result) {
        expect(result.tasks).toHaveLength(1);
      }
    });

    it("returns error when filePaths is empty", async () => {
      const backend = createMockBackend();
      const result = await resolveVirtualTableTasks(
        { filePaths: [], instruction: "Analyze" },
        backend,
      );

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("No files matched");
      }
    });
  });

  describe("glob patterns", () => {
    it("resolves a single glob pattern", async () => {
      const backend = createMockBackend({
        "feedback/*.txt": [
          { path: "feedback/001.txt" },
          { path: "feedback/002.txt" },
        ],
      });

      const result = await resolveVirtualTableTasks(
        { glob: "feedback/*.txt", instruction: "Classify" },
        backend,
      );

      expect("tasks" in result).toBe(true);
      if ("tasks" in result) {
        expect(result.tasks).toHaveLength(2);
      }
    });

    it("resolves multiple glob patterns", async () => {
      const backend = createMockBackend({
        "feedback/*.txt": [{ path: "feedback/001.txt" }],
        "reports/*.csv": [{ path: "reports/q1.csv" }],
      });

      const result = await resolveVirtualTableTasks(
        { glob: ["feedback/*.txt", "reports/*.csv"], instruction: "Analyze" },
        backend,
      );

      expect("tasks" in result).toBe(true);
      if ("tasks" in result) {
        expect(result.tasks).toHaveLength(2);
      }
    });

    it("deduplicates across glob patterns", async () => {
      const backend = createMockBackend({
        "data/*.txt": [{ path: "data/a.txt" }, { path: "data/b.txt" }],
        "data/a.*": [{ path: "data/a.txt" }],
      });

      const result = await resolveVirtualTableTasks(
        { glob: ["data/*.txt", "data/a.*"], instruction: "Read" },
        backend,
      );

      expect("tasks" in result).toBe(true);
      if ("tasks" in result) {
        expect(result.tasks).toHaveLength(2);
      }
    });

    it("strips leading slash from glob pattern", async () => {
      const backend = createMockBackend({
        "batch_*.txt": [
          { path: "batch_1.txt" },
          { path: "batch_2.txt" },
        ],
      });

      const result = await resolveVirtualTableTasks(
        { glob: "/batch_*.txt", instruction: "Classify" },
        backend,
      );

      expect(backend.glob).toHaveBeenCalledWith("batch_*.txt");
      expect("tasks" in result).toBe(true);
      if ("tasks" in result) {
        expect(result.tasks).toHaveLength(2);
      }
    });

    it("returns error when glob matches nothing", async () => {
      const backend = createMockBackend();
      const result = await resolveVirtualTableTasks(
        { glob: "nothing/*.txt", instruction: "Read" },
        backend,
      );

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("No files matched");
        expect(result.error).toContain("nothing/*.txt");
      }
    });

    it("returns error when glob itself fails", async () => {
      const backend = {
        glob: vi.fn(async () => ({ error: "permission denied" })),
      } as unknown as BackendProtocolV2;

      const result = await resolveVirtualTableTasks(
        { glob: "secret/*", instruction: "Read" },
        backend,
      );

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("permission denied");
      }
    });
  });

  describe("combined filePaths and glob", () => {
    it("merges explicit paths with glob results", async () => {
      const backend = createMockBackend({
        "feedback/*.txt": [{ path: "feedback/001.txt" }],
      });

      const result = await resolveVirtualTableTasks(
        {
          filePaths: ["extra/manual.txt"],
          glob: "feedback/*.txt",
          instruction: "Process",
        },
        backend,
      );

      expect("tasks" in result).toBe(true);
      if ("tasks" in result) {
        expect(result.tasks).toHaveLength(2);
        const paths = result.tasks.map(
          (t) => t.description.split("\n\nFile: ")[1],
        );
        expect(paths).toContain("extra/manual.txt");
        expect(paths).toContain("feedback/001.txt");
      }
    });
  });

  describe("subagentType", () => {
    it("includes subagentType when provided", async () => {
      const backend = createMockBackend();
      const result = await resolveVirtualTableTasks(
        {
          filePaths: ["a.txt"],
          instruction: "Analyze",
          subagentType: "analyst",
        },
        backend,
      );

      expect("tasks" in result).toBe(true);
      if ("tasks" in result) {
        expect(result.tasks[0].subagentType).toBe("analyst");
      }
    });

    it("omits subagentType when not provided", async () => {
      const backend = createMockBackend();
      const result = await resolveVirtualTableTasks(
        { filePaths: ["a.txt"], instruction: "Analyze" },
        backend,
      );

      expect("tasks" in result).toBe(true);
      if ("tasks" in result) {
        expect(result.tasks[0]).not.toHaveProperty("subagentType");
      }
    });
  });

  describe("tasksJsonl", () => {
    it("returns valid JSONL alongside tasks", async () => {
      const backend = createMockBackend();
      const result = await resolveVirtualTableTasks(
        { filePaths: ["a.txt", "b.txt"], instruction: "Process" },
        backend,
      );

      expect("tasksJsonl" in result).toBe(true);
      if ("tasksJsonl" in result) {
        const lines = result.tasksJsonl.split("\n").filter((l) => l.trim());
        expect(lines).toHaveLength(2);
        const parsed = lines.map((l) => JSON.parse(l));
        expect(parsed[0].id).toBe("a.txt");
        expect(parsed[1].id).toBe("b.txt");
      }
    });
  });

  describe("sorting", () => {
    it("returns tasks in sorted path order", async () => {
      const backend = createMockBackend();
      const result = await resolveVirtualTableTasks(
        { filePaths: ["z.txt", "a.txt", "m.txt"], instruction: "Read" },
        backend,
      );

      expect("tasks" in result).toBe(true);
      if ("tasks" in result) {
        const ids = result.tasks.map((t) => t.id);
        expect(ids).toEqual(["a.txt", "m.txt", "z.txt"]);
      }
    });
  });
});
