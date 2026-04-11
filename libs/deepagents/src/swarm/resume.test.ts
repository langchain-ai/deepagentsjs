import { describe, expect, it } from "vitest";
import { computePending } from "./resume.js";
import type {
  CompletedResult,
  FailedResult,
  ManifestEntry,
  TaskResult,
} from "./types.js";

const NOW = "2024-01-01T00:00:00.000Z";

function entry(id: string): ManifestEntry {
  return { id, descriptionPath: `tasks/${id}.txt` };
}

function completed(id: string): CompletedResult {
  return {
    id,
    status: "completed",
    subagentType: "general-purpose",
    attempts: 1,
    startedAt: NOW,
    finishedAt: NOW,
    result: "ok",
  };
}

function failed(id: string): FailedResult {
  return {
    id,
    status: "failed",
    subagentType: "general-purpose",
    attempts: 3,
    startedAt: NOW,
    finishedAt: NOW,
    error: "boom",
  };
}

describe("computePending", () => {
  it("returns an empty plan for an empty manifest", () => {
    const plan = computePending([], new Map(), false);
    expect(plan.pending).toEqual([]);
    expect(plan.alreadyCompleted).toEqual([]);
    expect(plan.alreadyFailed).toEqual([]);
    expect(plan.retrying).toEqual([]);
    expect(plan.orphanedResultIds).toEqual([]);
  });

  it("dispatches all manifest entries when no results exist", () => {
    const manifest = [entry("a"), entry("b")];
    const plan = computePending(manifest, new Map(), false);
    expect(plan.pending).toEqual(manifest);
  });

  it("skips completed entries", () => {
    const manifest = [entry("a"), entry("b")];
    const results = new Map<string, TaskResult>([["a", completed("a")]]);
    const plan = computePending(manifest, results, false);
    expect(plan.pending.map((e) => e.id)).toEqual(["b"]);
    expect(plan.alreadyCompleted).toEqual(["a"]);
  });

  it("skips failed entries by default", () => {
    const manifest = [entry("a"), entry("b")];
    const results = new Map<string, TaskResult>([["a", failed("a")]]);
    const plan = computePending(manifest, results, false);
    expect(plan.pending.map((e) => e.id)).toEqual(["b"]);
    expect(plan.alreadyFailed).toEqual(["a"]);
    expect(plan.retrying).toEqual([]);
  });

  it("re-dispatches failed entries when retryFailed is true", () => {
    const manifest = [entry("a"), entry("b")];
    const results = new Map<string, TaskResult>([["a", failed("a")]]);
    const plan = computePending(manifest, results, true);
    expect(plan.pending.map((e) => e.id)).toEqual(["a", "b"]);
    expect(plan.retrying).toEqual(["a"]);
    expect(plan.alreadyFailed).toEqual([]);
  });

  it("treats corrupt result files as not-yet-run", () => {
    const manifest = [entry("a")];
    const results = new Map<string, TaskResult | "corrupt">([["a", "corrupt"]]);
    const plan = computePending(manifest, results, false);
    expect(plan.pending.map((e) => e.id)).toEqual(["a"]);
  });

  it("partitions a mixed manifest correctly", () => {
    const manifest = [entry("done"), entry("oops"), entry("missing"), entry("bad")];
    const results = new Map<string, TaskResult | "corrupt">([
      ["done", completed("done")],
      ["oops", failed("oops")],
      ["bad", "corrupt"],
    ]);
    const plan = computePending(manifest, results, false);
    expect(plan.pending.map((e) => e.id).sort()).toEqual(["bad", "missing"]);
    expect(plan.alreadyCompleted).toEqual(["done"]);
    expect(plan.alreadyFailed).toEqual(["oops"]);
    expect(plan.retrying).toEqual([]);
  });

  it("reports orphaned result ids that are not in the manifest", () => {
    const manifest = [entry("a")];
    const results = new Map<string, TaskResult | "corrupt">([
      ["a", completed("a")],
      ["zombie", completed("zombie")],
      ["leftover", "corrupt"],
    ]);
    const plan = computePending(manifest, results, false);
    expect(plan.orphanedResultIds).toEqual(["leftover", "zombie"]);
    expect(plan.pending).toEqual([]);
  });
});
