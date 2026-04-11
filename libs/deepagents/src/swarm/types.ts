/**
 * Types, schemas, and constants for the swarm subsystem.
 *
 * The swarm system organizes work into "run directories" with the following layout:
 *
 *   swarm_runs/<run-name>/
 *     manifest.jsonl       — task metadata (one ManifestEntry per line)
 *     tasks/
 *       <id>.txt           — raw prompt content for each task (plain text)
 *     results/
 *       <id>.json          — TaskResult for each completed/failed task
 *     summary.json         — SwarmExecutionSummary for the most recent run
 *
 * Task content lives in plain-text files (no JSON escaping). Each result is its
 * own JSON file, which gives free crash recovery via file-existence checks and
 * removes any assumption that the backend supports atomic append.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Concurrency / retry / timeout constants
// ---------------------------------------------------------------------------

/** Default concurrency limit for swarm execution. */
export const DEFAULT_CONCURRENCY = 10;

/** Maximum allowed concurrency. */
export const MAX_CONCURRENCY = 50;

/** Default number of retry attempts per task. */
export const DEFAULT_MAX_RETRIES = 3;

/** Per-task timeout in seconds. */
export const TASK_TIMEOUT_SECONDS = 300;

// ---------------------------------------------------------------------------
// Layout constants — single source of truth for the run-directory shape
// ---------------------------------------------------------------------------

/** Root directory under which all swarm runs are created. */
export const SWARM_RUNS_ROOT = "swarm_runs";

/** Manifest filename inside a run directory. */
export const MANIFEST_FILENAME = "manifest.jsonl";

/** Subdirectory holding per-task prompt files. */
export const TASKS_DIRNAME = "tasks";

/** Subdirectory holding per-task result files. */
export const RESULTS_DIRNAME = "results";

/** Summary filename inside a run directory. */
export const SUMMARY_FILENAME = "summary.json";

// ---------------------------------------------------------------------------
// Tool input limits
// ---------------------------------------------------------------------------

/** Maximum tasks accepted in a single swarm_add_tasks call. */
export const MAX_ADD_TASKS_BATCH = 500;

/** Default page size for swarm_get_results when limit is omitted. */
export const DEFAULT_GET_RESULTS_LIMIT = 50;

/** Hard cap on swarm_get_results page size. */
export const MAX_GET_RESULTS_LIMIT = 200;

/**
 * Maximum bytes of inline `result` content returned per entry by
 * `swarm_get_results`. Larger results are truncated in the response with a
 * pointer to the on-disk file. The result file itself is never modified.
 */
export const MAX_RESULT_INLINE_SIZE = 10 * 1024;

// ---------------------------------------------------------------------------
// Core schemas
// ---------------------------------------------------------------------------

/**
 * Filesystem-safe identifier. The same string is used as a manifest key, a
 * task filename (`tasks/<id>.txt`), and a result filename (`results/<id>.json`),
 * so it must be safe across all supported backends.
 */
export const TaskIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.-]+$/, "id must match [A-Za-z0-9_.-]+");

/**
 * One row of `manifest.jsonl`. Carries only metadata — the actual task prompt
 * lives in the file referenced by `descriptionPath`.
 */
export const ManifestEntrySchema = z.object({
  id: TaskIdSchema,
  /** Path relative to the run directory, e.g. `tasks/0001.txt`. */
  descriptionPath: z.string().min(1),
  /** Subagent name. Defaults to `general-purpose` when omitted. */
  subagentType: z.string().min(1).optional(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

/**
 * Input shape for a single task supplied to `swarm_add_tasks`. The orchestrator
 * provides the raw prompt `content` inline; the helper writes it to
 * `tasks/<id>.txt` and adds the corresponding manifest entry.
 */
export const AddTaskInputSchema = z.object({
  id: TaskIdSchema,
  content: z.string().min(1),
  subagentType: z.string().min(1).optional(),
});
export type AddTaskInput = z.infer<typeof AddTaskInputSchema>;

/**
 * Fields shared by completed and failed result files.
 */
const ResultBaseSchema = z.object({
  id: TaskIdSchema,
  subagentType: z.string().min(1),
  attempts: z.number().int().min(1),
  startedAt: z.string(),
  finishedAt: z.string(),
});

export const CompletedResultSchema = ResultBaseSchema.extend({
  status: z.literal("completed"),
  result: z.string(),
});
export type CompletedResult = z.infer<typeof CompletedResultSchema>;

export const FailedResultSchema = ResultBaseSchema.extend({
  status: z.literal("failed"),
  error: z.string(),
});
export type FailedResult = z.infer<typeof FailedResultSchema>;

/**
 * Discriminated union over the two result variants. Stored as the contents of
 * `results/<id>.json` for every dispatched task.
 */
export const TaskResultSchema = z.discriminatedUnion("status", [
  CompletedResultSchema,
  FailedResultSchema,
]);
export type TaskResult = z.infer<typeof TaskResultSchema>;

/**
 * Run-level statistics returned from the `swarm` tool and persisted to
 * `summary.json` at the end of every executor invocation.
 */
export const SwarmExecutionSummarySchema = z.object({
  /** Path to the run directory whose manifest was executed. */
  runDir: z.string(),
  /** Number of entries in the manifest at the time of this call. */
  total: z.number().int(),
  /** Number of result files with `status: "completed"` after this call. */
  completed: z.number().int(),
  /** Number of result files with `status: "failed"` after this call. */
  failed: z.number().int(),
  /** Tasks that already had a result file and were not re-dispatched. */
  skipped: z.number().int(),
  /** Tasks dispatched (and completed or failed) during this call. */
  dispatched: z.number().int(),
  /** Result files whose id is no longer present in the manifest. */
  orphanedResultIds: z.array(z.string()),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type SwarmExecutionSummary = z.infer<typeof SwarmExecutionSummarySchema>;

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------

export const SwarmInitInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .optional()
    .describe(
      "Optional run name. If omitted a random suffix is generated. Must be filesystem-safe.",
    ),
});
export type SwarmInitInput = z.infer<typeof SwarmInitInputSchema>;

export const SwarmAddTasksInputSchema = z.object({
  runDir: z
    .string()
    .min(1)
    .describe("Run directory returned by swarm_init."),
  tasks: z
    .array(AddTaskInputSchema)
    .min(1)
    .max(MAX_ADD_TASKS_BATCH)
    .describe(
      `Batch of tasks to add. At most ${MAX_ADD_TASKS_BATCH} per call. Each task's id must be unique within the batch and the existing manifest.`,
    ),
});
export type SwarmAddTasksInput = z.infer<typeof SwarmAddTasksInputSchema>;

export const SwarmInputSchema = z.object({
  runDir: z
    .string()
    .min(1)
    .describe("Run directory containing the manifest to execute."),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONCURRENCY)
    .optional()
    .describe(
      `Maximum subagents running simultaneously. Default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY}.`,
    ),
  maxRetries: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      `Attempts per task before it is recorded as failed. Default ${DEFAULT_MAX_RETRIES}.`,
    ),
  retryFailed: z
    .boolean()
    .optional()
    .describe(
      "When true, re-dispatch tasks whose previous result file is `failed`. Default false.",
    ),
});
export type SwarmInput = z.infer<typeof SwarmInputSchema>;

export const SwarmGetResultsInputSchema = z.object({
  runDir: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_GET_RESULTS_LIMIT)
    .optional()
    .describe(
      `Maximum results returned in this page. Default ${DEFAULT_GET_RESULTS_LIMIT}, max ${MAX_GET_RESULTS_LIMIT}.`,
    ),
  ids: z
    .array(TaskIdSchema)
    .optional()
    .describe(
      "If set, restrict the response to these manifest ids. Unknown ids are reported in `missingIds`.",
    ),
  statusFilter: z
    .enum(["completed", "failed", "pending", "all"])
    .optional()
    .describe(
      "Restrict the response to entries with the given status. `pending` matches manifest entries with no result file yet. Default `all`.",
    ),
});
export type SwarmGetResultsInput = z.infer<typeof SwarmGetResultsInputSchema>;

/**
 * Synthetic placeholder returned by `swarm_get_results` for manifest entries
 * that have no result file yet.
 */
export interface PendingResultEntry {
  id: string;
  status: "pending";
  subagentType?: string;
}

export type GetResultsEntry = TaskResult | PendingResultEntry;

export interface SwarmGetResultsResponse {
  results: GetResultsEntry[];
  total: number;
  offset: number;
  pageSize: number;
  hasMore: boolean;
  missingIds: string[];
}
