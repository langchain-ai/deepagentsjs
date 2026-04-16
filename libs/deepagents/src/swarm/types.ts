/**
 * Default number of concurrent subagent invocations per swarm call.
 */
export const DEFAULT_CONCURRENCY = 10;

/**
 * Maximum allowed concurrency. Higher values risk rate limits.
 */
export const MAX_CONCURRENCY = 50;

/**
 * Per-task timeout in milliseconds (300 seconds).
 */
export const TASK_TIMEOUT_MS = 300_000;

/**
 * A single row from tasks.jsonl. Represents one unit of work to dispatch
 * to a subagent.
 */
export interface SwarmTaskSpec {
  /**
   * Unique identifier. Used to correlate with results.
   */
  id: string;

  /**
   * Complete, self-contained prompt for the subagent.
   */
  description: string;

  /**
   * Which subagent type to dispatch to. Defaults to "general-purpose".
   */
  subagentType?: string;
}

/**
 * A single row from results.jsonl. Represents the outcome of one
 * dispatched task.
 */
export interface SwarmTaskResult {
  /**
   * Correlates with the input task spec.
   */
  id: string;

  /**
   * The subagent type that processed this task.
   */
  subagentType: string;

  /**
   * Whether the subagent returned a result or errored.
   */
  status: "completed" | "failed";

  /**
   * The subagent's final text output. Present when status is "completed".
   */
  result?: string;

  /**
   * The error message. Present when status is "failed".
   */
  error?: string;
}

/**
 * Compact error summary for a failed task, included in the swarm tool response
 * so the orchestrator can decide how to handle failures.
 */
export interface FailedTaskInfo {
  /**
   * The task ID that failed.
   */
  id: string;

  /**
   * The error message from the failure.
   */
  error: string;
}

/**
 * Structured response returned by the executor. The swarm tool handler
 * serializes this as JSON and returns it to the orchestrator.
 */
export interface SwarmExecutionSummary {
  /**
   * Total number of tasks dispatched.
   */
  total: number;

  /**
   * Number of tasks that returned a result.
   */
  completed: number;

  /**
   * Number of tasks that errored.
   */
  failed: number;

  /**
   * Path to the run directory containing results.jsonl.
   */
  resultsDir: string;

  /**
   * Details for every failed task. Empty array if all succeeded.
   */
  failedTasks: FailedTaskInfo[];
}
