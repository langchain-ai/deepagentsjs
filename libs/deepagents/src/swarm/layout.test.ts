import { describe, expect, it } from "vitest";
import {
  manifestPath,
  relativeTaskPath,
  resolveRunRelativePath,
  resultIdFromFilename,
  resultPath,
  resultsDir,
  runDirFor,
  summaryPath,
  taskPath,
  tasksDir,
} from "./layout.js";

describe("layout helpers", () => {
  const runDir = "swarm_runs/test-run";

  it("runDirFor builds path under swarm_runs root", () => {
    expect(runDirFor("test-run")).toBe("swarm_runs/test-run");
  });

  it("manifestPath returns manifest.jsonl inside the run directory", () => {
    expect(manifestPath(runDir)).toBe("swarm_runs/test-run/manifest.jsonl");
  });

  it("tasksDir and resultsDir return the conventional subdirectories", () => {
    expect(tasksDir(runDir)).toBe("swarm_runs/test-run/tasks");
    expect(resultsDir(runDir)).toBe("swarm_runs/test-run/results");
  });

  it("taskPath uses the id as the filename with .txt extension", () => {
    expect(taskPath(runDir, "0001")).toBe("swarm_runs/test-run/tasks/0001.txt");
  });

  it("resultPath uses the id as the filename with .json extension", () => {
    expect(resultPath(runDir, "0001")).toBe(
      "swarm_runs/test-run/results/0001.json",
    );
  });

  it("summaryPath returns summary.json inside the run directory", () => {
    expect(summaryPath(runDir)).toBe("swarm_runs/test-run/summary.json");
  });

  it("relativeTaskPath stays portable across run directories", () => {
    expect(relativeTaskPath("alpha")).toBe("tasks/alpha.txt");
  });

  it("resolveRunRelativePath joins a run-relative path against a runDir", () => {
    expect(resolveRunRelativePath(runDir, "tasks/0001.txt")).toBe(
      "swarm_runs/test-run/tasks/0001.txt",
    );
  });

  describe("resultIdFromFilename", () => {
    it("strips the .json suffix from a bare filename", () => {
      expect(resultIdFromFilename("0001.json")).toBe("0001");
    });

    it("strips directory components before extracting the id", () => {
      expect(resultIdFromFilename("results/0001.json")).toBe("0001");
      expect(
        resultIdFromFilename("swarm_runs/run/results/foo.bar.json"),
      ).toBe("foo.bar");
    });

    it("returns null for non-json filenames", () => {
      expect(resultIdFromFilename("0001.txt")).toBeNull();
      expect(resultIdFromFilename("manifest.jsonl")).toBeNull();
    });

    it("returns null for an empty id", () => {
      expect(resultIdFromFilename(".json")).toBeNull();
    });
  });
});
