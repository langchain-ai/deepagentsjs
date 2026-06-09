import { createTable, loadTable, saveTable } from "./table.js";
import { interpolate, extractPlaceholders } from "./interpolate.js";
import { readColumn } from "./utils.js";
import { evaluateFilter } from "./filter.js";
import { dispatch, deduplicateFailures, mergeResult } from "./executor.js";
import {
  resolveBatchGroups,
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
  ReduceOptions,
  TaskSpec,
  TaskResult,
} from "./types.js";

/**
 * Maximum concurrent subagent dispatches per `run()` call.
 *
 * When matched rows exceed this and no explicit `batchSize` is set,
 * auto-batching groups rows to stay within this concurrency budget.
 */
const MAX_SUBAGENTS = 10;

/**
 * Default per-reducer token budget for `reduce()`.
 *
 * When the rows being reduced exceed this, the reduction fans out into
 * parallel leaf reducers whose summaries are combined hierarchically.
 * Sized well under a model's context window to leave room for the
 * instruction, the subagent's reasoning, and its output.
 */
const REDUCE_TOKEN_BUDGET = 50_000;

/**
 * A dispatch unit is a single task for the executor. It tracks
 * whether it covers one row (single) or multiple (batch) so the
 * merge step knows how to unpack the result.
 */
interface DispatchUnit {
  /**
   * The task to dispatch to the executor.
   */
  task: TaskSpec;

  /**
   * Row IDs covered by this task. Single: length 1. Batch: length > 1.
   */
  rowIds: string[];
}

/**
 * Build dispatch units from pre-grouped batches.
 *
 * Single-row batches produce interpolated per-row prompts with the
 * user's responseSchema. Multi-row batches produce batch prompts
 * with a wrapped schema.
 */
function buildDispatchUnits(
  batches: Record<string, unknown>[][],
  opts: {
    instruction: string;
    context?: string;
    subagentType?: string;
    responseSchema: Record<string, unknown>;
    mode: "agent" | "invoke";
  },
): { units: DispatchUnit[]; errors: TaskResult[] } {
  const units: DispatchUnit[] = [];
  const errors: TaskResult[] = [];

  let batchIndex = 0;
  for (const batch of batches) {
    if (batch.length === 1) {
      // Single-row dispatch: interpolate instruction, use schema directly
      const row = batch[0];
      const rowId = String(row.id);

      try {
        let prompt = interpolate(opts.instruction, row);
        if (opts.context) {
          prompt = `${opts.context}\n\n${prompt}`;
        }

        units.push({
          task: {
            id: rowId,
            prompt,
            subagentType: opts.subagentType,
            responseSchema: opts.responseSchema,
            mode: opts.mode,
          },
          rowIds: [rowId],
        });
      } catch (err) {
        errors.push({
          id: rowId,
          status: "failed",
          error: (err as Error).message,
        });
      }
    } else {
      // Multi-row batch: build batch prompt, wrap schema
      const rowIds = batch.map((r) => String(r.id));
      units.push({
        task: {
          id: `batch_${batchIndex}`,
          prompt: buildBatchPrompt(opts.instruction, batch, opts.context),
          subagentType: opts.subagentType,
          responseSchema: wrapSchema(opts.responseSchema, batch.length),
          mode: opts.mode,
        },
        rowIds,
      });
      batchIndex++;
    }
  }

  return { units, errors };
}

/**
 * Normalize dispatch results into per-row results.
 *
 * Single-row units pass through directly. Batch units are unpacked
 * into one result per row — missing rows become failures.
 */
function unpackDispatchResults(
  units: DispatchUnit[],
  results: TaskResult[],
): TaskResult[] {
  const rowResults: TaskResult[] = [];

  for (let idx = 0; idx < units.length; idx++) {
    const unit = units[idx];
    const result = results[idx];

    if (unit.rowIds.length === 1) {
      rowResults.push(result);
      continue;
    }

    if (result.status === "failed") {
      for (const rowId of unit.rowIds) {
        rowResults.push({ id: rowId, status: "failed", error: result.error });
      }
      continue;
    }

    const { results: unpacked } = unpackBatchResults(
      result.result ?? "",
      unit.rowIds,
    );
    for (const rowId of unit.rowIds) {
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
 * Parse and merge per-row results into table rows.
 *
 * Each completed result is JSON-parsed and spread onto the
 * corresponding row via `mergeResult`.
 */
function mergeRowResults(
  rowResults: TaskResult[],
  rowById: Map<string, Record<string, unknown>>,
): { completed: number; failed: number } {
  let completed = 0;
  let failed = 0;

  for (const result of rowResults) {
    const row = rowById.get(result.id);
    if (!row) {
      failed++;
      continue;
    }

    if (result.status === "completed" && result.result != null) {
      try {
        mergeResult(row, JSON.parse(result.result));
        completed++;
      } catch {
        failed++;
      }
    } else {
      failed++;
    }
  }

  return { completed, failed };
}

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
 * Create a table from a source specification and store it in memory.
 *
 * @param source - Exactly one of `glob`, `filePaths`, or `tasks`.
 * @returns A lightweight handle with the table's ID, row count, and columns.
 */
export async function create(source: CreateSource): Promise<SwarmHandle> {
  return createTable(source);
}

/**
 * Dispatch work across table rows and update the table in place.
 *
 * Loads the table, partitions rows by filter, interpolates the
 * instruction template per-row (or builds batch prompts), dispatches
 * to subagents via `tools.swarm_task()`, merges results into rows,
 * and persists the updated table.
 *
 * @param handle - A table handle or object with an `id` field.
 * @param options - Dispatch configuration (instruction, filter, schema, etc.).
 * @returns A summary with completion counts and deduplicated failure groups.
 */
export async function run(
  tableId: string,
  options: RunOptions,
): Promise<RunResult> {
  const allRows = await loadTable(tableId);
  const {
    instruction,
    context,
    filter,
    subagentType,
    responseSchema,
    batchSize,
    concurrency,
  } = options;
  const mode = subagentType != null ? "agent" : "invoke";

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
  // 2. Resolve batches and build dispatch units
  // -----------------------------------------------------------------------

  const batches = resolveBatchGroups(matched, effectiveConcurrency, batchSize);

  const { units, errors: interpolationErrors } = buildDispatchUnits(batches, {
    instruction,
    context,
    subagentType,
    responseSchema,
    mode,
  });

  // -----------------------------------------------------------------------
  // 3. Dispatch
  // -----------------------------------------------------------------------

  const dispatchResults = await dispatch(
    units.map((u) => u.task),
    { concurrency: effectiveConcurrency },
  );

  // -----------------------------------------------------------------------
  // 4. Unpack and merge results into rows
  // -----------------------------------------------------------------------

  const rowById = new Map<string, Record<string, unknown>>();
  for (const row of matched) {
    rowById.set(String(row.id), row);
  }

  const rowResults = unpackDispatchResults(units, dispatchResults);
  const { completed, failed: mergeFailed } = mergeRowResults(
    rowResults,
    rowById,
  );
  const failed = mergeFailed + interpolationErrors.length;
  const allRowResults = [...interpolationErrors, ...rowResults];

  // -----------------------------------------------------------------------
  // 5. Persist and return summary
  // -----------------------------------------------------------------------

  await saveTable(tableId, allRows);

  return {
    completed,
    failed,
    skipped: skippedCount,
    failures: deduplicateFailures(allRowResults),
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
  tableId: string,
  options?: RowsOptions,
): Promise<Record<string, unknown>[]> {
  let result = await loadTable(tableId);

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

/**
 * Estimate the token count of a string with a chars/4 heuristic.
 *
 * Deliberately rough — used only to decide when reducer input exceeds a
 * context budget, where a conservative over-estimate is safe.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Greedily pack items into chunks whose total estimated size stays
 * within `budget`. Each item lands in exactly one chunk; an item larger
 * than the budget on its own becomes a single-item chunk.
 */
function chunkBySize<T>(
  items: T[],
  sizeOf: (item: T) => number,
  budget: number,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentSize = 0;

  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && currentSize + size > budget) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(item);
    currentSize += size;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Build the prompt for a leaf reducer that synthesizes raw table rows.
 */
function buildLeafPrompt(
  instruction: string,
  rowsChunk: Record<string, unknown>[],
): string {
  return (
    `${instruction}\n\n` +
    `Base your answer only on the following ${rowsChunk.length} ` +
    `record(s):\n\n${JSON.stringify(rowsChunk, null, 2)}`
  );
}

/**
 * Build the prompt for a reducer that combines partial summaries from
 * earlier reducers into a single unified answer.
 */
function buildCombinePrompt(instruction: string, partials: string[]): string {
  const sections = partials
    .map((p, i) => `--- Partial summary ${i + 1} of ${partials.length} ---\n${p}`)
    .join("\n\n");
  return (
    `${instruction}\n\n` +
    `The data was processed in ${partials.length} groups, each summarized ` +
    `below. Combine them into a single unified answer. Do not refer to the ` +
    `grouping or to "partial summaries" in your output.\n\n${sections}`
  );
}

/**
 * Dispatch a set of reducer prompts and return their text outputs.
 *
 * Reducers run in invoke mode by default (a single model call, no tools);
 * pass `subagentType` to run them as full agents. Throws if any reducer
 * fails — a partial synthesis would silently misrepresent the data.
 */
async function dispatchReducers(
  specs: Array<{ id: string; prompt: string }>,
  subagentType: string | undefined,
  mode: "agent" | "invoke",
  concurrency: number,
): Promise<string[]> {
  const tasks: TaskSpec[] = specs.map((s) => ({
    id: s.id,
    prompt: s.prompt,
    mode,
    ...(subagentType != null && { subagentType }),
  }));

  const results = await dispatch(tasks, { concurrency });

  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    const detail = deduplicateFailures(results)
      .map((g) => `${g.error} (${g.count})`)
      .join("; ");
    throw new Error(`reduce: ${failed.length} reducer(s) failed: ${detail}`);
  }

  return results.map((r) => r.result ?? "");
}

/**
 * Synthesize table rows into a single artifact via a subagent, keeping
 * the row data out of the orchestrator's context.
 *
 * Unlike `rows()` — which pulls raw data back into the eval (and thus the
 * agent's context) — `reduce()` dispatches the synthesis to a separate,
 * disposable context and returns only the result. When the rows fit one
 * reducer's token budget, a single reducer runs. When they don't, rows
 * are split into parallel leaf reducers whose summaries are combined
 * hierarchically until one answer remains — so no single context (and
 * never the orchestrator's) holds the full dataset.
 *
 * @param tableId - A table handle's `id`.
 * @param options - Synthesis instruction plus optional filter/projection.
 * @returns The synthesized artifact as a string.
 */
export async function reduce(
  tableId: string,
  options: ReduceOptions,
): Promise<string> {
  const {
    instruction,
    filter,
    columns,
    subagentType,
    tokenBudget = REDUCE_TOKEN_BUDGET,
    concurrency,
  } = options;

  if (typeof instruction !== "string" || instruction.length === 0) {
    throw new Error("reduce() requires a non-empty string instruction");
  }

  // -----------------------------------------------------------------------
  // 1. Load, filter, and project the rows to synthesize
  // -----------------------------------------------------------------------

  let data = await loadTable(tableId);

  if (filter) {
    data = data.filter((row) => evaluateFilter(filter, row));
  }

  if (columns) {
    data = data.map((row) => {
      const projected: Record<string, unknown> = {};
      for (const col of columns) {
        if (col in row) projected[col] = row[col];
      }
      return projected;
    });
  }

  if (data.length === 0) {
    return "No rows matched the reduce filter.";
  }

  const mode = subagentType != null ? "agent" : "invoke";
  const effectiveConcurrency = Math.max(
    1,
    Math.min(concurrency ?? MAX_SUBAGENTS, MAX_SUBAGENTS),
  );

  // -----------------------------------------------------------------------
  // 2. Single reducer when everything fits one context
  // -----------------------------------------------------------------------

  if (estimateTokens(JSON.stringify(data)) <= tokenBudget) {
    const [result] = await dispatchReducers(
      [{ id: "reduce_0", prompt: buildLeafPrompt(instruction, data) }],
      subagentType,
      mode,
      1,
    );
    return result;
  }

  // -----------------------------------------------------------------------
  // 3. Map: leaf reducers over row chunks, in parallel
  // -----------------------------------------------------------------------

  const rowChunks = chunkBySize(
    data,
    (row) => estimateTokens(JSON.stringify(row)),
    tokenBudget,
  );

  let partials = await dispatchReducers(
    rowChunks.map((chunk, i) => ({
      id: `reduce_leaf_${i}`,
      prompt: buildLeafPrompt(instruction, chunk),
    })),
    subagentType,
    mode,
    effectiveConcurrency,
  );

  // -----------------------------------------------------------------------
  // 4. Reduce: fold partial summaries until a single answer remains
  // -----------------------------------------------------------------------

  while (partials.length > 1) {
    // Combine in one pass when the partials fit a single context.
    if (estimateTokens(partials.join("\n\n")) <= tokenBudget) {
      const [combined] = await dispatchReducers(
        [
          {
            id: "reduce_root",
            prompt: buildCombinePrompt(instruction, partials),
          },
        ],
        subagentType,
        mode,
        1,
      );
      return combined;
    }

    const partialGroups = chunkBySize(
      partials,
      (p) => estimateTokens(p),
      tokenBudget,
    );

    // Each partial already exceeds the budget alone — grouping can't
    // shrink the count, so combine everything in one final best-effort
    // pass rather than loop forever.
    if (partialGroups.length >= partials.length) {
      const [combined] = await dispatchReducers(
        [
          {
            id: "reduce_root",
            prompt: buildCombinePrompt(instruction, partials),
          },
        ],
        subagentType,
        mode,
        1,
      );
      return combined;
    }

    partials = await dispatchReducers(
      partialGroups.map((group, i) => ({
        id: `reduce_combine_${i}`,
        prompt: buildCombinePrompt(instruction, group),
      })),
      subagentType,
      mode,
      effectiveConcurrency,
    );
  }

  return partials[0];
}
