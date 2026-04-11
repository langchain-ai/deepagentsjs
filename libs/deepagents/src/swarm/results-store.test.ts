import { describe, expect, it } from "vitest";
import {
  listResults,
  readResult,
  writeResult,
  writeSummary,
} from "./results-store.js";
import { resultPath, summaryPath } from "./layout.js";
import { createInMemoryBackend } from "./test-utils.js";
import type {
  CompletedResult,
  FailedResult,
  SwarmExecutionSummary,
} from "./types.js";

const RUN_DIR = "swarm_runs/test-run";
const NOW = "2024-01-01T00:00:00.000Z";

function completed(id: string, result = "the answer"): CompletedResult {
  return {
    id,
    status: "completed",
    subagentType: "general-purpose",
    attempts: 1,
    startedAt: NOW,
    finishedAt: NOW,
    result,
  };
}

function failed(id: string, error = "boom"): FailedResult {
  return {
    id,
    status: "failed",
    subagentType: "general-purpose",
    attempts: 3,
    startedAt: NOW,
    finishedAt: NOW,
    error,
  };
}

describe("writeResult / readResult", () => {
  it("round-trips a completed result", async () => {
    const backend = createInMemoryBackend();
    await writeResult(backend, RUN_DIR, completed("a"));
    const outcome = await readResult(backend, RUN_DIR, "a");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result).toEqual(completed("a"));
    }
  });

  it("round-trips a failed result", async () => {
    const backend = createInMemoryBackend();
    await writeResult(backend, RUN_DIR, failed("b", "subagent crashed"));
    const outcome = await readResult(backend, RUN_DIR, "b");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result.status).toBe("failed");
      if (outcome.result.status === "failed") {
        expect(outcome.result.error).toBe("subagent crashed");
      }
    }
  });

  it("returns missing for files that do not exist", async () => {
    const backend = createInMemoryBackend();
    const outcome = await readResult(backend, RUN_DIR, "ghost");
    expect(outcome.kind).toBe("missing");
  });

  it("returns corrupt for files with invalid JSON", async () => {
    const backend = createInMemoryBackend({
      [resultPath(RUN_DIR, "bad")]: "{ not json }",
    });
    const outcome = await readResult(backend, RUN_DIR, "bad");
    expect(outcome.kind).toBe("corrupt");
  });

  it("returns corrupt for files that don't match the schema", async () => {
    const backend = createInMemoryBackend({
      [resultPath(RUN_DIR, "wrong")]: JSON.stringify({ id: "wrong" }),
    });
    const outcome = await readResult(backend, RUN_DIR, "wrong");
    expect(outcome.kind).toBe("corrupt");
  });

  it("validates results before writing them", async () => {
    const backend = createInMemoryBackend();
    const invalid = { id: "bad" } as any;
    await expect(writeResult(backend, RUN_DIR, invalid)).rejects.toThrow();
    expect(backend.files.has(resultPath(RUN_DIR, "bad"))).toBe(false);
  });
});

describe("listResults", () => {
  it("returns an empty map for a missing results directory", async () => {
    const backend = createInMemoryBackend();
    const map = await listResults(backend, RUN_DIR);
    expect(map.size).toBe(0);
  });

  it("returns a map keyed by id with all parsed results", async () => {
    const backend = createInMemoryBackend();
    await writeResult(backend, RUN_DIR, completed("a"));
    await writeResult(backend, RUN_DIR, failed("b"));

    const map = await listResults(backend, RUN_DIR);
    expect(map.size).toBe(2);
    expect((map.get("a") as CompletedResult).status).toBe("completed");
    expect((map.get("b") as FailedResult).status).toBe("failed");
  });

  it("marks corrupt files as 'corrupt' rather than dropping them", async () => {
    const backend = createInMemoryBackend({
      [resultPath(RUN_DIR, "bad")]: "{ not json }",
    });
    await writeResult(backend, RUN_DIR, completed("good"));

    const map = await listResults(backend, RUN_DIR);
    expect(map.get("bad")).toBe("corrupt");
    expect((map.get("good") as CompletedResult).status).toBe("completed");
  });

  it("ignores non-json files in the results directory", async () => {
    const backend = createInMemoryBackend({
      [`${RUN_DIR}/results/notes.txt`]: "ignored",
    });
    await writeResult(backend, RUN_DIR, completed("a"));
    const map = await listResults(backend, RUN_DIR);
    expect(map.size).toBe(1);
    expect(map.has("a")).toBe(true);
  });
});

describe("writeSummary", () => {
  it("persists a validated summary to summary.json", async () => {
    const backend = createInMemoryBackend();
    const summary: SwarmExecutionSummary = {
      runDir: RUN_DIR,
      total: 3,
      completed: 2,
      failed: 1,
      skipped: 0,
      dispatched: 3,
      orphanedResultIds: [],
      startedAt: NOW,
      finishedAt: NOW,
    };
    await writeSummary(backend, RUN_DIR, summary);
    const stored = backend.files.get(summaryPath(RUN_DIR));
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!)).toEqual(summary);
  });

  it("rejects invalid summaries before writing", async () => {
    const backend = createInMemoryBackend();
    await expect(
      writeSummary(backend, RUN_DIR, { runDir: RUN_DIR } as any),
    ).rejects.toThrow();
    expect(backend.files.has(summaryPath(RUN_DIR))).toBe(false);
  });
});
