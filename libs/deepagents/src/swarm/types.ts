import type { SwarmFilter } from "./filter.js";

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
 * A single unit of work to dispatch to a subagent.
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

  /**
   * JSON Schema for dynamic structured output. Must have `type: "object"`
   * at the top level. When provided, the executor compiles a subagent
   * variant via SubagentFactory with this as the `responseFormat`.
   */
  responseSchema?: Record<string, unknown>;

  /**
   * Raw row data from the source table. Used by batched dispatch to
   * compose a compact prompt (instruction once + per-item variable values).
   */
  rowData?: Record<string, unknown>;
}

/**
 * The outcome of one dispatched task.
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
 * Source definition for `swarm.create`.
 */
export interface CreateTableSource {
  /**
   * Glob pattern(s) → one row per matched file with `{ id, file }`.
   */
  glob?: string | string[];

  /**
   * Explicit paths → one row per file with `{ id, file }`.
   */
  filePaths?: string[];

  /**
   * Pre-built rows. Each must have `id: string`.
   */
  tasks?: Array<Record<string, unknown>>;
}

/**
 * Options for `swarm.execute`.
 */
export interface SwarmExecuteOptions {
  /**
   * Prompt template with `{column}` / `{dotted.path}` placeholders.
   */
  instruction: string;

  /**
   * Column name to write results into. @default "result"
   */
  column?: string;

  /**
   * Only dispatch rows matching this clause; others pass through.
   */
  filter?: SwarmFilter;

  /**
   * Subagent type for all dispatched rows. @default "general-purpose"
   */
  subagentType?: string;

  /**
   * JSON Schema for structured output. Column value becomes parsed object.
   */
  responseSchema?: Record<string, unknown>;

  /**
   * Max concurrent dispatches. @default DEFAULT_CONCURRENCY
   */
  concurrency?: number;

  /**
   * Number of rows to group into a single subagent call. Requires
   * `responseSchema`. Each batch dispatches one subagent with a wrapped
   * array schema and results are matched back to rows by id.
   * @default 1
   */
  batchSize?: number;
}

/**
 * Per-row outcome included in the {@link SwarmSummary}.
 */
export interface SwarmResultEntry {
  /**
   * Row identifier from the source table.
   */
  id: string;

  /**
   * The subagent type that processed this row.
   */
  subagentType: string;

  /**
   * Whether the subagent completed successfully or errored.
   */
  status: "completed" | "failed";

  /**
   * The subagent's text output. Present when status is `"completed"`
   */
  result?: string;

  /**
   * Error message. Present when status is `"failed"`.
   */
  error?: string;
}

/**
 * In-memory summary returned by `swarm.execute`.
 *
 * This object lives in QuickJS memory and is JSON-stringified back to the
 * caller. Results are also written as columns on the source table rows, so
 * the summary is a convenience view — not the canonical store.
 */
export interface SwarmSummary {
  /**
   * Number of rows dispatched (after filtering).
   */
  total: number;

  /**
   * Number of rows that completed successfully.
   */
  completed: number;

  /**
   * Number of rows that failed (dispatch errors + interpolation errors).
   */
  failed: number;

  /**
   * Number of rows excluded by the filter clause.
   */
  skipped: number;

  /**
   * Path to the JSONL table file that was executed against.
   */
  file: string;

  /**
   * Column name where results were written.
   */
  column: string;

  /**
   * Per-row outcomes, in dispatch order.
   */
  results: SwarmResultEntry[];

  /**
   * Compact list of every failed row with its error message.
   */
  failedTasks: Array<{ id: string; error: string }>;
}
