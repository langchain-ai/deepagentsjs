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
}

/**
 * Configuration for a swarm execution run.
 *
 * These are the parameters the orchestrator passes when calling
 * the swarm tool.
 */
export interface SwarmConfig {
  /**
   * Path to the tasks.jsonl file (within the backend filesystem). The executor reads
   * this file via the backend to get the task list.
   */
  tasksPath: string;

  /**
   * Maximum number of subagents running simultaneously.
   *
   * @default 10
   * @minimum 1
   * @maximum 50
   */
  concurrency?: number;

  /**
   * Maximum number of attempts per task (including the initial attempt).
   *
   * @default 3
   * @minimum 1
   */
  maxRetries?: number;
}
