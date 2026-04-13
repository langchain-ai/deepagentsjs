/**
 * Types and constants for the swarm subsystem.
 *
 * Swarm operates on a table stored as JSONL: each row is an independent task
 * with an ID, a prompt, and (after execution) a result. The input table
 * (`tasks.jsonl`) is produced by a generation script; the output table
 * (`results.jsonl`) is written by the executor.
 */

/** Default number of subagents running simultaneously. */
export const DEFAULT_CONCURRENCY = 10;

/** Hard cap on concurrent subagents. */
export const MAX_CONCURRENCY = 50;

/** Per-task timeout in seconds. */
export const TASK_TIMEOUT_SECONDS = 300;

/**
 * A single task as read from `tasks.jsonl`.
 *
 * Each row is a self-contained unit of work: the `description` field carries
 * the full prompt the subagent will receive. No shared context, no global
 * instructions — each task stands alone.
 */
export interface SwarmTaskSpec {
  /** Unique identifier for this task. Used to correlate with results. */
  id: string;

  /** Complete, self-contained prompt for the subagent. */
  description: string;

  /**
   * Which subagent to dispatch to.
   * @defaultValue `"general-purpose"`
   */
  subagentType?: string;
}

/**
 * A single result row written to `results.jsonl`.
 *
 * Does not include the original `description` — the results table is lean.
 * If the aggregation script needs the original prompt, it can join back to
 * `tasks.jsonl` by `id`.
 */
export interface SwarmTaskResult {
  /** Correlates with the input task. */
  id: string;

  /** The subagent that processed (or attempted) this task. */
  subagentType: string;

  /** Whether the subagent returned a result or errored. */
  status: "completed" | "failed";

  /** The subagent's final text output. Present when `status` is `"completed"`. */
  result?: string;

  /** The raw error message. Present when `status` is `"failed"`. */
  error?: string;
}

/** Compact failure record included in the swarm summary. */
export interface FailedTaskInfo {
  id: string;
  error: string;
}

/**
 * Summary returned by the `swarm` tool to the orchestrator.
 *
 * Provides enough information for the orchestrator to decide next steps
 * (aggregate, retry, abort) without reading the results file.
 */
export interface SwarmExecutionSummary {
  /** Number of tasks in the input file. */
  total: number;

  /** Tasks that returned a result. */
  completed: number;

  /** Tasks that errored. */
  failed: number;

  /** Path to the run directory containing `results.jsonl`. */
  resultsDir: string;

  /**
   * One entry per failed task with its ID and error message.
   * Lets the orchestrator triage failures directly from the summary.
   */
  failedTasks: FailedTaskInfo[];
}
