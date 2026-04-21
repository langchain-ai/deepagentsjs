// ---------------------------------------------------------------------------
// Swarm table types
// ---------------------------------------------------------------------------

import { SwarmFilter } from "./filter.js";

/**
 * Source definition for {@link createTable}. Exactly one of `glob`,
 * `filePaths`, or `tasks` must be provided.
 */
export interface CreateTableSource {
  /**
   * Glob pattern(s) to resolve into file-per-row entries.
   * Each matched file becomes a row with `{ id, file }` columns.
   */
  glob?: string | string[];

  /**
   * Explicit file paths to include as rows.
   * Each path becomes a row with `{ id, file }` columns.
   */
  filePaths?: string[];

  /**
   * Pre-built row objects to write directly as the table.
   * Each object must have an `id` field (string).
   */
  tasks?: Array<Record<string, unknown>>;
}

/**
 * Options for `swarm.execute`. Passed from the QuickJS guest to the
 * host-side executor.
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
   * Max concurrent subagent dispatches. @default DEFAULT_CONCURRENCY
   */
  concurrency?: number;
}

/**
 * Per-task result included inline in the {@link SwarmSummary}.
 *
 * Identical shape to {@link SwarmTaskResult} — kept as a named type so
 * the table API surface is self-contained.
 */
export interface SwarmResultEntry {
  /**
   * Row ID that was dispatched.
   */
  id: string;

  /**
   * Subagent type that processed this row.
   */
  subagentType: string;

  /**
   * Whether the subagent completed or failed.
   */
  status: "completed" | "failed";

  /**
   * Subagent's final text output. Present when status is `"completed"`.
   */
  result?: string;

  /**
   * Error message. Present when status is `"failed"`.
   */
  error?: string;
}

/**
 * Summary returned by `swarm.execute`. Lives in QuickJS memory — only
 * enters LLM tokens if the agent explicitly returns it from `js_eval`.
 *
 * No `resultsDir`, no persisted `results.jsonl`. Results are inline in
 * `results` and also written as columns on the table file.
 */
export interface SwarmSummary {
  /**
   * Total number of rows dispatched (matched filter).
   */
  total: number;

  /**
   * Number of rows that completed successfully.
   */
  completed: number;

  /**
   * Number of rows that failed.
   */
  failed: number;

  /**
   * Number of rows excluded by filter (not dispatched).
   */
  skipped: number;

  /**
   * The table file that was enriched.
   */
  file: string;

  /**
   * The column name where results were written.
   */
  column: string;

  /**
   * Per-row results for immediate JS aggregation.
   */
  results: SwarmResultEntry[];

  /**
   * Compact error info for every failed row.
   */
  failedTasks: Array<{ id: string; error: string }>;
}
