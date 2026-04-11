/**
 * Pure path helpers for the swarm run-directory layout.
 *
 * No I/O, no backend dependency. These functions exist so that the on-disk
 * layout has a single source of truth and is easy to refactor in one place.
 */

import {
  MANIFEST_FILENAME,
  RESULTS_DIRNAME,
  SUMMARY_FILENAME,
  SWARM_RUNS_ROOT,
  TASKS_DIRNAME,
} from "./types.js";

/** Build a run directory path under {@link SWARM_RUNS_ROOT}. */
export function runDirFor(name: string): string {
  return `${SWARM_RUNS_ROOT}/${name}`;
}

/** Path to the manifest file inside a run directory. */
export function manifestPath(runDir: string): string {
  return `${runDir}/${MANIFEST_FILENAME}`;
}

/** Subdirectory holding per-task prompt files. */
export function tasksDir(runDir: string): string {
  return `${runDir}/${TASKS_DIRNAME}`;
}

/** Subdirectory holding per-task result files. */
export function resultsDir(runDir: string): string {
  return `${runDir}/${RESULTS_DIRNAME}`;
}

/** Absolute path to the prompt file for a given task id. */
export function taskPath(runDir: string, id: string): string {
  return `${tasksDir(runDir)}/${id}.txt`;
}

/** Absolute path to the result file for a given task id. */
export function resultPath(runDir: string, id: string): string {
  return `${resultsDir(runDir)}/${id}.json`;
}

/** Absolute path to the summary file. */
export function summaryPath(runDir: string): string {
  return `${runDir}/${SUMMARY_FILENAME}`;
}

/**
 * Manifest-relative task path used inside `manifest.jsonl`.
 *
 * Stored as a relative path so the run directory is portable: copying the
 * directory to a new location does not invalidate the manifest.
 */
export function relativeTaskPath(id: string): string {
  return `${TASKS_DIRNAME}/${id}.txt`;
}

/**
 * Resolve a manifest-relative path against a run directory.
 *
 * Used by the executor when pre-loading task content from a `descriptionPath`
 * stored in the manifest.
 */
export function resolveRunRelativePath(runDir: string, relative: string): string {
  return `${runDir}/${relative}`;
}

/**
 * Extract the task id from a result filename of the form `<id>.json`.
 * Returns `null` for filenames that do not match the expected shape.
 */
export function resultIdFromFilename(filename: string): string | null {
  // Strip any directory components the backend may include in the FileInfo path.
  const base = filename.includes("/")
    ? filename.slice(filename.lastIndexOf("/") + 1)
    : filename;
  if (!base.endsWith(".json")) return null;
  const id = base.slice(0, -".json".length);
  return id.length > 0 ? id : null;
}
