/**
 * Batched subagent dispatch for swarm execution.
 *
 * When `batchSize > 1`, multiple table rows are grouped into a single
 * subagent call. The subagent receives a combined prompt and a wrapped
 * array schema; results are unpacked per-row and merged back into the
 * table once per batch.
 *
 * This module is consumed by `executor.ts` and separated to keep the
 * single-row and batched dispatch paths independently readable.
 */

import { HumanMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import type { ReactAgent } from "langchain";
import type { SwarmTaskSpec, SwarmTaskResult } from "./types.js";
import { TASK_TIMEOUT_MS } from "./types.js";
import { serializeTableJsonl } from "./parse.js";
import {
  type DispatchContext,
  withTimeout,
  extractResultText,
  tryParseJson,
  mergeResultIntoRow,
  prependContext,
  enqueue,
} from "./executor.js";

/**
 * A single item from a batch subagent's structured response array.
 */
interface BatchResultItem {
  /**
   * Row identifier echoed back by the subagent.
   */
  id: string;

  /**
   *
   */
  [key: string]: unknown;
}

/**
 * Narrow an `unknown` value to a plain object shape, or return `undefined` if it isn't one.
 */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Detect a wrapped batch schema shaped like `{type:"object", properties:{results:{type:"array",
 * items:{type:"object", properties:{id, ...}}}}}`. When detected, the executor preserves the
 * user's descriptions and only enforces the per-batch `minItems` / `maxItems`.
 */
function isPreWrappedBatchSchema(schema: Record<string, unknown>): boolean {
  const props = asObject(schema.properties);
  if (props === undefined) {
    return false;
  }

  const results = asObject(props.results);
  if (results === undefined) {
    return false;
  }

  if (results.type !== "array") {
    return false;
  }

  const items = asObject(results.items);
  if (items === undefined) {
    return false;
  }

  if (items.type !== "object") {
    return false;
  }

  const itemProps = asObject(items.properties);
  if (itemProps === undefined) {
    return false;
  }

  return "id" in itemProps;
}

/**
 * Shallow-clone a pre-wrapped schema and stamp `minItems` / `maxItems` on `results`. Every other
 * orchestrator-authored field — including `description` prose on `results`, `id`, and item property
 * fields — is preserved.
 */
function enforceBatchCount(
  schema: Record<string, unknown>,
  count: number,
): Record<string, unknown> {
  const props = asObject(schema.properties);
  if (props === undefined) {
    return schema;
  }

  const results = asObject(props.results);
  if (results === undefined) {
    return schema;
  }

  return {
    ...schema,
    properties: {
      ...props,
      results: {
        ...results,
        minItems: count,
        maxItems: count,
      },
    },
  };
}

/**
 * Wrap a per-item `responseSchema` into a batch envelope: `{ results: [{ id, ...itemProps }] }` with
 * `minItems`/`maxItems` set to `count`. If the schema is already pre-wrapped (orchestrator authored),
 * only stamps the count constraints.
 */
function wrapBatchSchema(
  itemSchema: Record<string, unknown>,
  count: number,
): Record<string, unknown> {
  if (isPreWrappedBatchSchema(itemSchema) === true) {
    return enforceBatchCount(itemSchema, count);
  }

  const userProps = (itemSchema.properties ?? {}) as Record<string, unknown>;
  const userRequired = Array.isArray(itemSchema.required)
    ? (itemSchema.required as string[])
    : [];

  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            ...userProps,
          },
          required: ["id", ...userRequired],
        },
        minItems: count,
        maxItems: count,
      },
    },
    required: ["results"],
  };
}

/**
 * Partition an array into fixed-size chunks. The last chunk may be smaller than `size` when `items.length`
 * is not evenly divisible.
 */
function groupIntoBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Build a single combined prompt for a batch of tasks. Each task's already-interpolated description is listed
 * with its id so the subagent can map results back.
 */
function composeBatchInstruction(
  batch: SwarmTaskSpec[],
  context: string | undefined,
): string {
  const items = batch
    .map((task) => `[${task.id}] ${task.description}`)
    .join("\n");

  const body =
    `Process ${batch.length} items. Return a JSON "results" array ` +
    `with exactly ${batch.length} entries. Each entry must include ` +
    `the item's id exactly as shown.\n\n` +
    `Items:\n${items}`;

  return prependContext(body, context);
}

/**
 * Map a batch subagent's response array back to individual task results. Items are matched by `id`; any task
 * whose id is missing from the response is marked as failed.
 */
function unpackBatchResult(
  batch: SwarmTaskSpec[],
  rawResults: BatchResultItem[],
): SwarmTaskResult[] {
  const subagentType = batch[0]?.subagentType ?? "general-purpose";
  const byId = new Map<string, BatchResultItem>();
  for (const item of rawResults) {
    if (typeof item.id === "string") {
      byId.set(item.id, item);
    }
  }

  return batch.map((task) => {
    const match = byId.get(task.id);
    if (!match) {
      return {
        id: task.id,
        subagentType,
        status: "failed" as const,
        error: `No result returned for id "${task.id}"`,
      };
    }

    const { id: _, ...rest } = match;
    return {
      id: task.id,
      subagentType,
      status: "completed" as const,
      result: JSON.stringify(rest),
    };
  });
}

/**
 * Dispatch a batch of tasks to a single subagent call. The subagent receives a combined prompt and a wrapped
 * array schema. On success, the structured response is unpacked into per-task results. On failure, every task
 * in the batch is marked failed with the same error.
 */
function dispatchBatch(
  batch: SwarmTaskSpec[],
  subagent: ReactAgent<any> | Runnable,
  filteredState: Record<string, unknown>,
  context: string | undefined,
  config?: { signal?: AbortSignal },
): Promise<SwarmTaskResult[]> {
  const subagentType = batch[0]?.subagentType ?? "general-purpose";
  const prompt = composeBatchInstruction(batch, context);
  const subagentState = {
    ...filteredState,
    messages: [new HumanMessage({ content: prompt })],
  };

  return withTimeout(
    subagent.invoke(subagentState, { signal: config?.signal }) as Promise<
      Record<string, unknown>
    >,
    TASK_TIMEOUT_MS,
  ).then(
    (result) => {
      if (result.structuredResponse != null) {
        const sr = result.structuredResponse as { results?: unknown[] };
        if (Array.isArray(sr.results)) {
          return unpackBatchResult(batch, sr.results as BatchResultItem[]);
        }
      }

      const text = extractResultText(result);
      const parsed = tryParseJson(text);

      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as any).results)
      ) {
        return unpackBatchResult(
          batch,
          (parsed as any).results as BatchResultItem[],
        );
      }

      return batch.map((task) => ({
        id: task.id,
        subagentType,
        status: "failed" as const,
        error: "Could not parse batch response as results array",
      }));
    },
    (err) =>
      batch.map((task) => ({
        id: task.id,
        subagentType,
        status: "failed" as const,
        error: (err as Error).message ?? String(err),
      })),
  );
}

/**
 * Dispatch tasks in batches, grouping `effectiveBatchSize` rows into each subagent call. Results are unpacked
 * per-row and merged back into the table once per batch.
 */
export async function dispatchBatched(
  ctx: DispatchContext & {
    effectiveBatchSize: number;
    subagentType?: string;
    responseSchema: Record<string, unknown>;
  },
): Promise<void> {
  const batches = groupIntoBatches(ctx.tasks, ctx.effectiveBatchSize);
  const batchSubagentType = ctx.subagentType ?? "general-purpose";
  let taskOffset = 0;

  for (const batch of batches) {
    if (ctx.signal?.aborted) {
      for (let i = 0; i < batch.length; i++) {
        ctx.results[taskOffset + i] = {
          id: batch[i].id,
          subagentType: batchSubagentType,
          status: "failed",
          error: "Aborted",
        };
      }
      taskOffset += batch.length;
      continue;
    }

    const wrappedSchema = wrapBatchSchema(ctx.responseSchema, batch.length);
    const subagent = ctx.resolveSubagent(batchSubagentType, wrappedSchema);
    const currentOffset = taskOffset;

    const promise = dispatchBatch(
      batch,
      subagent,
      ctx.filteredState,
      ctx.context,
      { signal: ctx.signal },
    ).then((batchResults) => {
      for (let i = 0; i < batchResults.length; i++) {
        const res = batchResults[i];
        ctx.results[currentOffset + i] = res;

        const rowIdx = ctx.rowIndexById.get(res.id);
        if (
          res.status === "completed" &&
          res.result != null &&
          rowIdx != null
        ) {
          const value = tryParseJson(res.result);
          ctx.rows[rowIdx] = mergeResultIntoRow(
            ctx.rows[rowIdx],
            ctx.column,
            value,
          );
        }
      }
      ctx.write(ctx.file, serializeTableJsonl(ctx.rows));
    });

    await enqueue(promise, ctx.executing, ctx.effectiveConcurrency);
    taskOffset += batch.length;
  }
}
