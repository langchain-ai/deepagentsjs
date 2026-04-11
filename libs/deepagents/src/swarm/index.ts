/**
 * Public exports for the swarm subsystem.
 *
 * Internal modules (`layout`, `manifest`, `results-store`, `io`,
 * `test-utils`) are intentionally not re-exported — they are implementation
 * details of the executor and middleware.
 */

export type {
  AddTaskInput,
  CompletedResult,
  FailedResult,
  GetResultsEntry,
  ManifestEntry,
  PendingResultEntry,
  SwarmAddTasksInput,
  SwarmExecutionSummary,
  SwarmGetResultsInput,
  SwarmGetResultsResponse,
  SwarmInitInput,
  SwarmInput,
  TaskResult,
} from "./types.js";

export {
  DEFAULT_CONCURRENCY,
  DEFAULT_GET_RESULTS_LIMIT,
  DEFAULT_MAX_RETRIES,
  MAX_ADD_TASKS_BATCH,
  MAX_CONCURRENCY,
  MAX_GET_RESULTS_LIMIT,
  MAX_RESULT_INLINE_SIZE,
  TASK_TIMEOUT_SECONDS,
} from "./types.js";

export { executeSwarm, type SwarmExecutionOptions } from "./executor.js";
export { computePending, type ResumePlan } from "./resume.js";
