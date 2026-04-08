/**
 * Default concurrency limit for swarm execution.
 */
export const DEFAULT_CONCURRENCY = 10;

/**
 * Maximum allowed concurrency.
 */
export const MAX_CONCURRENCY = 50;

/**
 * Default number of retry attempts per task.
 */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Per-task timeout in seconds.
 */
export const TASK_TIMEOUT_SECONDS = 300;

/**
 * A single task specification as written by the task generation script.
 *
 * Input fields only — the executor adds status/result/error after execution.
 * These are read from the tasks.jsonl file produced by the orchestrator's
 * generation script.
 */
export interface SwarmTaskSpec {
  /**
   * Unique identifier for this task. Must be unique within the task list.
   */
  id: string;

  /**
   * The complete, self-contained prompt for the subagent.
   */
  description: string;

  /**
   * Which subagent type to use. Must match a name from the agent's configured subagents.
   *
   * @default "general-purpose"
   */
  subagentType?: string;
}

/**
 * A completed task with execution results.
 *
 * Extends SwarmTaskSpec with output fields added by the executor
 * after the task has been run (successfully or not).
 */
export interface SwarmTaskResult extends SwarmTaskSpec {
  /**
   * Whether the task completed successfully or failed after all retries.
   */
  status: "completed" | "failed";

  /**
   * The subagent's final response text. Present when status is "completed".
   */
  result?: string;

  /**
   * Error message. Present when status is "failed".
   */
  error?: string;
}

/**
 * Summary returned as the swarm tool's response to the orchestrator.
 *
 * This is what the orchestrator LLM sees as the tool result.
 * It provides enough information to decide next steps without
 * reading any file.
 */
export interface SwarmExecutionSummary {
  /**
   * Total number of tasks in the run.
   */
  total: number;

  /**
   * Number of tasks that completed successfully.
   */
  completed: number;

  /**
   * Number of tasks that failed after all retry attempts.
   */
  failed: number;

  /**
   * Path to the results directory for this run.
   *
   * Contains a single `results.jsonl` file with one JSON object per line,
   * each including the original task fields plus `status`, `result`, and/or `error`.
   */
  resultsDir: string;

  /**
   * Present only when the results file could not be written.
   */
  writeError?: string;

  /**
   * Inline results fallback when resultsDir write fails.
   */
  results?: SwarmTaskResult[];
}
