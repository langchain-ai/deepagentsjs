/**
 * Read, write, and list per-task result files for a swarm run.
 *
 * Each task has its own JSON file at `results/<id>.json`. This layout gives us
 * three properties for free:
 *
 * 1. **Resume**: file existence is the source of truth for "this task is done".
 *    The executor only needs to `ls` the directory to know what to skip.
 * 2. **Idempotent re-runs**: re-writing the same result file is safe; the last
 *    write wins. Concurrent dispatchers don't corrupt anything.
 * 3. **No append assumption**: every backend supports `write(path, content)`.
 *    There's no atomic append requirement, no cross-write races on a shared
 *    file, and no spill-threshold logic for large content.
 */

import type { BackendProtocolV2 } from "../backends/protocol.js";
import { readTextFile, writeTextFile } from "./io.js";
import { resultIdFromFilename, resultPath, resultsDir, summaryPath } from "./layout.js";
import {
  SwarmExecutionSummary,
  SwarmExecutionSummarySchema,
  TaskResult,
  TaskResultSchema,
} from "./types.js";

/**
 * Sentinel returned by {@link readResult} for files that exist but cannot be
 * parsed (corrupted JSON or schema mismatch). Treated as "not yet run" by the
 * resume planner so the next swarm call overwrites them.
 */
export type ReadResultOutcome =
  | { kind: "ok"; result: TaskResult }
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string };

/**
 * Write a single result file. The result is validated against
 * {@link TaskResultSchema} before being written so we never persist a malformed
 * record.
 */
export async function writeResult(
  backend: BackendProtocolV2,
  runDir: string,
  result: TaskResult,
): Promise<void> {
  const validated = TaskResultSchema.parse(result);
  const path = resultPath(runDir, validated.id);
  const writeError = await writeTextFile(
    backend,
    path,
    JSON.stringify(validated, null, 2),
  );
  if (writeError) {
    throw new Error(
      `failed to write result for '${validated.id}': ${writeError.error}`,
    );
  }
}

/** Read a single result file. Distinguishes missing from corrupt. */
export async function readResult(
  backend: BackendProtocolV2,
  runDir: string,
  id: string,
): Promise<ReadResultOutcome> {
  const path = resultPath(runDir, id);
  const read = await readTextFile(backend, path);
  if (read.kind === "missing") return { kind: "missing" };
  if (read.kind === "error") {
    return { kind: "corrupt", reason: read.error };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch (err: any) {
    return { kind: "corrupt", reason: `invalid JSON: ${err?.message ?? err}` };
  }

  const validated = TaskResultSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      kind: "corrupt",
      reason: `schema mismatch: ${validated.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    };
  }
  return { kind: "ok", result: validated.data };
}

/**
 * List all result files in the run directory and return them keyed by id.
 *
 * - Files that don't match `<id>.json` are ignored.
 * - Files that exist but fail to parse are recorded as `"corrupt"` rather than
 *   omitted, so the resume planner can re-dispatch them.
 * - A missing results directory yields an empty map (the common case for a
 *   fresh run).
 */
export async function listResults(
  backend: BackendProtocolV2,
  runDir: string,
): Promise<Map<string, TaskResult | "corrupt">> {
  const dir = resultsDir(runDir);
  let lsResult;
  try {
    lsResult = await backend.ls(dir);
  } catch (_err) {
    // Some backends throw on missing directories instead of returning errors.
    return new Map();
  }
  if (lsResult.error) {
    // Treat any error as "no results yet". A fresh run has no results
    // directory, and the executor should not fail on that.
    return new Map();
  }
  const files = lsResult.files ?? [];

  const out = new Map<string, TaskResult | "corrupt">();
  for (const fileInfo of files) {
    if (fileInfo.is_dir) continue;
    const id = resultIdFromFilename(fileInfo.path);
    if (!id) continue;
    const outcome = await readResult(backend, runDir, id);
    if (outcome.kind === "ok") {
      out.set(id, outcome.result);
    } else if (outcome.kind === "corrupt") {
      out.set(id, "corrupt");
    }
    // missing → backend lied about the listing; skip silently.
  }
  return out;
}

/**
 * Persist the run-level summary. Failure here is non-fatal — per-task result
 * files remain authoritative — so callers swallow errors and log them
 * separately.
 */
export async function writeSummary(
  backend: BackendProtocolV2,
  runDir: string,
  summary: SwarmExecutionSummary,
): Promise<void> {
  const validated = SwarmExecutionSummarySchema.parse(summary);
  const path = summaryPath(runDir);
  const writeError = await writeTextFile(
    backend,
    path,
    JSON.stringify(validated, null, 2),
  );
  if (writeError) {
    throw new Error(`failed to write summary at '${path}': ${writeError.error}`);
  }
}
