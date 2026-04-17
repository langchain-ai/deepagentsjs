/**
 * Swarm module public API.
 *
 * Re-exports types, constants, and functions for parallel task execution.
 */

export type {
  FailedTaskInfo,
  SwarmExecutionSummary,
  SwarmTaskResult,
  SwarmTaskSpec,
} from "./types.js";

export {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  TASK_TIMEOUT_MS,
} from "./types.js";

export {
  parseTasksJsonl,
  serializeTasksJsonl,
  serializeResultsJsonl,
} from "./parse.js";

export { executeSwarm, type SwarmExecutionOptions } from "./executor.js";

export {
  resolveVirtualTableTasks,
  type VirtualTableInput,
  type VirtualTableResult,
} from "./virtual-table.js";
