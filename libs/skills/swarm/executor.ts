import type { FailureGroup, TaskResult, TaskSpec } from "./types.js";
import { normalizeSchema } from "./utils.js";

/**
 * PTC tool declaration for subagent dispatch.
 *
 * At runtime in QuickJS, `tools` is an ambient global injected by the
 * PTC layer. For vitest, set up `globalThis.tools` in `beforeEach`.
 */
declare const tools: {
  task?: (args: {
    description: string;
    subagent_type: string;
    response_schema?: Record<string, unknown>;
  }) => Promise<string>;
};

/**
 * Column names that must not be overwritten by structured output merging.
 */
const RESERVED_COLUMNS = new Set(["id", "file"]);

/**
 * Call the PTC `task` tool.
 *
 * @internal Exported for testing — not part of the public API.
 * @param args - Task arguments forwarded to the subagent middleware.
 * @returns The subagent's response as a string.
 * @throws Error if the `task` PTC tool is not configured.
 */
export async function callTask(args: {
  description: string;
  subagent_type: string;
  response_schema?: Record<string, unknown>;
}): Promise<string> {
  if (typeof tools.task !== "function") {
    throw new Error("Swarm requires a 'task' tool in the PTC configuration.");
  }
  const normalizedArgs =
    args.response_schema != null
      ? { ...args, response_schema: normalizeSchema(args.response_schema) }
      : args;
  return tools.task(normalizedArgs);
}

/**
 * Dispatch an array of task specs to subagents with bounded concurrency.
 *
 * Spawns up to `concurrency` workers that pull from the task queue.
 * Each worker calls the task function and records the result (or error)
 * at the same index as the input spec, preserving order.
 *
 * @param tasks - Task specs to dispatch.
 * @param options - Dispatch options (currently just `concurrency`).
 * @returns Results in the same order as the input tasks.
 */
export async function dispatch(
  tasks: TaskSpec[],
  options: { concurrency: number },
): Promise<TaskResult[]> {
  const results = new Array<TaskResult>(tasks.length);

  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      const spec = tasks[i];
      try {
        const output = await callTask({
          description: spec.prompt,
          subagent_type: spec.subagentType,
          ...(spec.responseSchema != null && {
            response_schema: spec.responseSchema,
          }),
        });
        results[i] = {
          id: spec.id,
          status: "completed",
          result: String(output),
        };
      } catch (err: unknown) {
        const msg =
          err != null && typeof (err as Error).message === "string"
            ? (err as Error).message
            : String(err);
        results[i] = { id: spec.id, status: "failed", error: msg };
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(options.concurrency, tasks.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

/**
 * Group failed task results by error message.
 *
 * Produces deduplicated failure groups sorted by count descending,
 * each containing the shared error message, the count of affected
 * rows, and the full list of affected row IDs.
 *
 * @param results - Array of task results (may include completed results).
 * @returns Deduplicated failure groups, sorted by count descending.
 */
export function deduplicateFailures(results: TaskResult[]): FailureGroup[] {
  const groups = new Map<string, string[]>();

  for (const r of results) {
    if (r.status !== "failed" || !r.error) {
      continue;
    }

    const ids = groups.get(r.error);
    if (ids) {
      ids.push(r.id);
    } else {
      groups.set(r.error, [r.id]);
    }
  }

  const out: FailureGroup[] = [];
  for (const [error, ids] of groups) {
    out.push({ error, count: ids.length, ids });
  }
  out.sort((a, b) => b.count - a.count);

  return out;
}

/**
 * Merge a subagent result into a table row.
 *
 * When the value is a plain object (structured output), each property
 * is spread onto the row as a top-level column — except reserved
 * columns (`id`, `file`) which are never overwritten.
 *
 * When the value is a primitive, array, or null, it is stored under
 * the specified column name.
 *
 * @param row - The table row to update (mutated in place).
 * @param column - Column name for non-object values.
 * @param value - The subagent's result (parsed JSON or raw string).
 */
export function mergeResult(
  row: Record<string, unknown>,
  column: string,
  value: unknown,
): void {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!RESERVED_COLUMNS.has(k)) {
        row[k] = v;
      }
    }
  } else {
    row[column] = value;
  }
}
