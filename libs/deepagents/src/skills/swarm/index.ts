import { createTable, loadTable, saveTable } from "./table.js";
import { interpolate, extractPlaceholders } from "./interpolate.js";
import { readColumn } from "./utils.js";
import { evaluateFilter } from "./filter.js";
import { dispatch, deduplicateFailures, mergeResult } from "./executor.js";
import {
  createBatches,
  wrapSchema,
  buildBatchPrompt,
  unpackBatchResults,
} from "./batching.js";
import type {
  CreateSource,
  SwarmHandle,
  RunOptions,
  RunResult,
  RowsOptions,
  TaskSpec,
  TaskResult,
} from "./types.js";

/**
 * Verify every `{column}` reference in `instruction` resolves on at
 * least one matched row. Throws with a list of unresolved paths.
 */
function validatePlaceholders(
  instruction: string,
  rows: Record<string, unknown>[],
): void {
  const placeholders = extractPlaceholders(instruction);
  if (placeholders.length === 0) {
    return;
  }
  const unresolved = placeholders.filter(
    (p) => !rows.some((r) => readColumn(r, p) !== undefined),
  );
  if (unresolved.length > 0) {
    throw new Error(
      `instruction references unknown column(s): ${unresolved.join(", ")}`,
    );
  }
}

/**
 * Maximum concurrent subagent dispatches per `run()` call.
 *
 * When matched rows exceed this, batching is applied automatically.
 * Auto-computed batch sizes are capped at MAX_BATCH_SIZE to keep
 * structured-output responses reliable (large batches drop items).
 */
const MAX_SUBAGENTS = 10;

/**
 * Maximum rows per batch when auto-batching.
 */
const MAX_BATCH_SIZE = 50;

/**
 * Create a table from a source specification and persist it to the backend.
 *
 * Thin wrapper around `createTable` — validates the source, builds rows,
 * runs eviction if necessary, and persists the table as JSONL.
 *
 * @param source - Exactly one of `glob`, `filePaths`, or `tasks`.
 * @returns A lightweight handle with the table's ID, row count, and columns.
 */
export async function create(source: CreateSource): Promise<SwarmHandle> {
  return createTable(source);
}

/**
 * Dispatch one subagent call per matched row.
 *
 * Interpolates the instruction template for each row, collects
 * interpolation errors as failures, and dispatches the valid tasks
 * through the executor's worker pool.
 *
 * @param matched - Rows that passed the filter.
 * @param opts - Dispatch configuration.
 * @returns Combined array of dispatch results and interpolation errors.
 */
async function dispatchSingle(
  matched: Record<string, unknown>[],
  opts: {
    instruction: string;
    context?: string;
    subagentType: string;
    responseSchema?: Record<string, unknown>;
    concurrency: number;
  },
): Promise<TaskResult[]> {
  const tasks: TaskSpec[] = [];
  const interpolationErrors: TaskResult[] = [];

  for (const row of matched) {
    const rowId = String(row.id);
    try {
      let prompt = interpolate(opts.instruction, row);
      if (opts.context) {
        prompt = `${opts.context}\n\n${prompt}`;
      }
      tasks.push({
        id: rowId,
        prompt,
        subagentType: opts.subagentType,
        responseSchema: opts.responseSchema,
      });
    } catch (e) {
      interpolationErrors.push({
        id: rowId,
        status: "failed",
        error: (e as Error).message,
      });
    }
  }

  const dispatchResults = await dispatch(tasks, {
    concurrency: opts.concurrency,
  });

  return [...dispatchResults, ...interpolationErrors];
}

/**
 * Dispatch rows in batches, sending multiple rows per subagent call.
 *
 * Groups matched rows into batches, builds a single prompt per batch
 * containing all rows' data, wraps the response schema for batch
 * output, dispatches each batch as one task, and unpacks the batch
 * responses back into per-row results.
 *
 * Rows missing from a batch response are marked as failed.
 *
 * @param matched - Rows that passed the filter.
 * @param opts - Dispatch configuration including `batchSize`.
 * @returns Per-row results unpacked from batch responses.
 */
async function dispatchBatched(
  matched: Record<string, unknown>[],
  opts: {
    instruction: string;
    context?: string;
    column: string;
    subagentType: string;
    responseSchema?: Record<string, unknown>;
    concurrency: number;
    batchSize: number;
  },
): Promise<TaskResult[]> {
  const batches = createBatches(matched, opts.batchSize);

  const batchTasks: TaskSpec[] = batches.map((batch, i) => ({
    id: `batch_${i}`,
    prompt: buildBatchPrompt(opts.instruction, batch, opts.context),
    subagentType: opts.subagentType,
    responseSchema: wrapSchema(opts.responseSchema, batch.length),
  }));

  const batchResults = await dispatch(batchTasks, {
    concurrency: opts.concurrency,
  });

  const rowResults: TaskResult[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchResult = batchResults[i];

    if (batchResult.status === "failed") {
      for (const row of batch) {
        rowResults.push({
          id: String(row.id),
          status: "failed",
          error: batchResult.error,
        });
      }
      continue;
    }

    const expectedIds = batch.map((r) => String(r.id));
    const { results: unpacked } = unpackBatchResults(
      batchResult.result ?? "",
      expectedIds,
    );

    for (const row of batch) {
      const rowId = String(row.id);
      const value = unpacked.get(rowId);
      if (value !== undefined) {
        rowResults.push({
          id: rowId,
          status: "completed",
          result: typeof value === "string" ? value : JSON.stringify(value),
        });
      } else {
        rowResults.push({
          id: rowId,
          status: "failed",
          error: "Missing from batch response",
        });
      }
    }
  }

  return rowResults;
}

/**
 * Dispatch work across table rows and update the table in place.
 *
 * Loads the table, partitions rows by filter, interpolates the
 * instruction template per-row (or builds batch prompts), dispatches
 * to subagents via `tools.task()`, merges results into rows, and
 * persists the updated table.
 *
 * @param handle - A table handle or object with an `id` field.
 * @param options - Dispatch configuration (instruction, filter, schema, etc.).
 * @returns A summary with completion counts and deduplicated failure groups.
 */
export async function run(
  handle: SwarmHandle | { id: string },
  options: RunOptions,
): Promise<RunResult> {
  if (
    options === undefined &&
    "instruction" in (handle as Record<string, unknown>)
  ) {
    throw new Error(
      "run() called with wrong signature. Use run(table, { instruction, ... }) not run({ table, instruction, ... })",
    );
  }
  const allRows = await loadTable(handle.id);
  const {
    instruction,
    context,
    column = "result",
    filter,
    subagentType = "general-purpose",
    responseSchema,
    batchSize,
    concurrency,
  } = options;

  const effectiveConcurrency = Math.max(
    1,
    Math.min(concurrency ?? MAX_SUBAGENTS, MAX_SUBAGENTS),
  );

  // -----------------------------------------------------------------------
  // 1. Partition rows into matched (dispatched) and skipped (filtered out)
  // -----------------------------------------------------------------------

  const matched: Record<string, unknown>[] = [];
  let skippedCount = 0;

  for (const row of allRows) {
    if (!filter || evaluateFilter(filter, row)) {
      matched.push(row);
    } else {
      skippedCount++;
    }
  }

  if (matched.length === 0) {
    return {
      completed: 0,
      failed: 0,
      skipped: allRows.length,
      failures: [],
    };
  }

  validatePlaceholders(instruction, matched);

  // -----------------------------------------------------------------------
  // 2. Resolve effective batch size and schema
  //
  // Auto-batch when matched rows exceed MAX_SUBAGENTS to cap total cost.
  // If no responseSchema is provided, generate a minimal one so batch
  // results can be unpacked per-row.
  // -----------------------------------------------------------------------

  const autoBatchSize =
    matched.length > MAX_SUBAGENTS
      ? Math.min(Math.ceil(matched.length / MAX_SUBAGENTS), MAX_BATCH_SIZE)
      : 1;

  const effectiveBatchSize = batchSize ?? autoBatchSize;

  const effectiveSchema: Record<string, unknown> | undefined =
    effectiveBatchSize >= 2 && !responseSchema
      ? {
          type: "object",
          additionalProperties: false,
          properties: { [column]: { type: "string" } },
          required: [column],
        }
      : responseSchema;

  // -----------------------------------------------------------------------
  // 3. Dispatch — single or batched
  // -----------------------------------------------------------------------

  let allResults: TaskResult[];

  if (effectiveBatchSize >= 2) {
    allResults = await dispatchBatched(matched, {
      instruction,
      context,
      column,
      subagentType,
      responseSchema: effectiveSchema,
      concurrency: effectiveConcurrency,
      batchSize: effectiveBatchSize,
    });
  } else {
    allResults = await dispatchSingle(matched, {
      instruction,
      context,
      subagentType,
      responseSchema: effectiveSchema,
      concurrency: effectiveConcurrency,
    });
  }

  // -----------------------------------------------------------------------
  // 3. Merge results into rows
  // -----------------------------------------------------------------------

  let completed = 0;
  let failed = 0;

  const rowById = new Map<string, Record<string, unknown>>();
  for (const row of matched) {
    rowById.set(String(row.id), row);
  }

  for (const result of allResults) {
    const row = rowById.get(result.id);
    if (!row) {
      failed++;
      continue;
    }

    if (result.status === "completed" && result.result != null) {
      let value: unknown = result.result;
      if (responseSchema) {
        try {
          value = JSON.parse(result.result);
        } catch {
          failed++;
          continue;
        }
      }
      mergeResult(row, column, value);
      completed++;
    } else {
      failed++;
    }
  }

  // -----------------------------------------------------------------------
  // 4. Persist and return summary
  // -----------------------------------------------------------------------

  await saveTable(handle.id, allRows);

  return {
    completed,
    failed,
    skipped: skippedCount,
    failures: deduplicateFailures(allResults),
  };
}

/**
 * Retrieve rows from a table, optionally filtered and projected.
 *
 * Loads the table and applies filter, column projection, and row
 * limiting in that order. Use for inspection and JS-based aggregation
 * — the heavy data stays in the sandbox and only the computed result
 * (via `console.log`) goes back to the agent's context.
 *
 * @param handle - A table handle or object with an `id` field.
 * @param options - Optional filtering, projection, and limiting.
 * @returns Array of row objects matching the criteria.
 */
export async function rows(
  handle: SwarmHandle | { id: string },
  options?: RowsOptions,
): Promise<Record<string, unknown>[]> {
  let result = await loadTable(handle.id);

  if (options?.filter) {
    const f = options.filter;
    result = result.filter((row) => evaluateFilter(f, row));
  }

  if (options?.columns) {
    const cols = options.columns;
    result = result.map((row) => {
      const projected: Record<string, unknown> = {};
      for (const col of cols) {
        if (col in row) projected[col] = row[col];
      }
      return projected;
    });
  }

  if (options?.limit != null && options.limit >= 0) {
    result = result.slice(0, options.limit);
  }

  return result;
}
