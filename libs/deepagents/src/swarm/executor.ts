import { HumanMessage } from "@langchain/core/messages";
import type { BaseMessage, ContentBlock } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import type { ReactAgent } from "langchain";
import type {
  SwarmTaskSpec,
  SwarmTaskResult,
  SwarmSummary,
  SwarmResultEntry,
} from "./types.js";
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  TASK_TIMEOUT_MS,
} from "./types.js";
import { parseTableJsonl, serializeTableJsonl } from "./parse.js";
import type { SubagentFactory } from "../symbols.js";
import { createHash } from "node:crypto";
import { evaluateFilter, type SwarmFilter } from "./filter.js";
import { interpolateInstruction } from "./interpolate.js";

/**
 * State keys excluded when building the subagent's initial state.
 * These are orchestrator-level concerns that subagents should not inherit.
 */
const EXCLUDED_STATE_KEYS = [
  "messages",
  "todos",
  "structuredResponse",
  "skillsMetadata",
  "memoryContents",
];

/**
 * Content block types filtered out when extracting text from a subagent's
 * response. Tool calls, thinking, and redacted thinking are not user-facing.
 */
const INVALID_CONTENT_BLOCK_TYPES = [
  "tool_use",
  "thinking",
  "redacted_thinking",
];

/**
 * Synchronous callback for writing a file to the session's pending-writes
 * buffer. Each call replaces any previous pending write to the same path.
 */
export type WriteCallback = (path: string, content: string) => void;

/**
 * Synchronous callback for reading a file, checking `pendingWrites` first
 * and falling back to the backend. This ensures `swarm.execute` can read
 * a table that `swarm.create` wrote in the same eval (before
 * `pendingWrites` are flushed to the backend).
 */
export type ReadCallback = (path: string) => Promise<string>;

/**
 * Intermediate result from {@link prepareSwarm}. Contains everything the
 * dispatch loop needs: the task specs, a mapping back to table row indices,
 * the mutable rows array for streaming writes, and any interpolation errors.
 */
interface PreparedSwarm {
  /**
   * Task specs ready for dispatch, one per matched + successfully interpolated row.
   */
  tasks: SwarmTaskSpec[];

  /**
   * Map from task id to its index in the `rows` array, for writing results back.
   */
  rowIndexById: Map<string, number>;

  /**
   * The full table rows array (mutable — results are merged in-place during dispatch).
   */
  rows: Record<string, unknown>[];

  /**
   * Number of rows excluded by the filter clause.
   */
  skipped: number;

  /**
   * Rows that matched the filter but failed instruction interpolation.
   */
  interpolationErrors: Array<{ id: string; error: string }>;
}

/**
 * Full set of options for {@link executeSwarm}. Combines the user-facing
 * options from `swarm.execute()` with runtime dependencies injected by
 * the session bridge (backend, subagent graphs, abort signal, etc.).
 */
export interface SwarmExecutionOptions {
  /**
   * Path to the JSONL table file to execute against.
   */
  file: string;

  /**
   * Prompt template with `{column}` placeholders, interpolated per row.
   */
  instruction: string;

  /**
   * Column name to write results into. @default "result"
   */
  column?: string;

  /**
   * Only dispatch rows matching this clause; others pass through unchanged.
   */
  filter?: SwarmFilter;

  /**
   * Subagent type for all dispatched rows. @default "general-purpose"
   */
  subagentType?: string;

  /**
   * JSON Schema for structured output. Must have `type: "object"` at top level.
   */
  responseSchema?: Record<string, unknown>;

  /**
   * Maximum concurrent subagent dispatches. @default DEFAULT_CONCURRENCY
   */
  concurrency?: number;

  /**
   * Pre-compiled subagent graphs keyed by type name.
   */
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;

  /**
   * Factory functions for compiling subagent variants with dynamic responseFormat.
   */
  subagentFactories?: Record<string, SubagentFactory>;

  /**
   * Current agent state, filtered before passing to subagents.
   */
  currentState: Record<string, unknown>;

  /**
   * Abort signal. When aborted, pending dispatches are skipped and in-flight calls cancelled.
   */
  signal?: AbortSignal;

  /**
   * Read callback that checks `pendingWrites` before falling back to
   * the backend. Required so `swarm.execute` can read tables written
   * by `swarm.create` in the same eval.
   */
  read: ReadCallback;

  /**
   * Write callback for streaming results back to the table as they complete.
   */
  write: WriteCallback;
}

/**
 * Create a shallow copy of the orchestrator's state with internal keys
 * (messages, todos, etc.) removed so subagents start with a clean slate.
 */
function filterStateForSubagent(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!EXCLUDED_STATE_KEYS.includes(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Extract the final text output from a subagent's result state.
 *
 * Checks `structuredResponse` first (returns JSON-stringified), then falls
 * back to the last message's content, filtering out tool-use and thinking
 * blocks. Returns `"Task completed"` if no usable content is found.
 */
function extractResultText(result: Record<string, unknown>): string {
  if (result.structuredResponse != null) {
    return JSON.stringify(result.structuredResponse);
  }

  const messages = result.messages as BaseMessage[] | undefined;
  const lastMessage = messages?.[messages.length - 1];
  if (!lastMessage) {
    return "Task completed";
  }

  const content = lastMessage.content;
  if (typeof content === "string") {
    return content || "Task completed";
  }

  if (Array.isArray(content)) {
    const filtered = (content as ContentBlock[]).filter(
      (block) => !INVALID_CONTENT_BLOCK_TYPES.includes(block.type),
    );
    if (filtered.length === 0) return "Task completed";
    return filtered
      .map((block) => ("text" in block ? block.text : JSON.stringify(block)))
      .join("\n");
  }

  return "Task completed";
}

/**
 * Race a promise against a timeout. Rejects with a descriptive error
 * if the timeout fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}`)), ms);
    }),
  ]);
}

/**
 * Dispatch a single task to a subagent with a per-task timeout.
 *
 * Builds the subagent's initial state (filtered orchestrator state + task
 * description as a HumanMessage), invokes the subagent, and normalizes
 * the result into a {@link SwarmTaskResult}. Never throws — errors are
 * captured in the returned result's `error` field.
 */
function dispatchTask(
  task: SwarmTaskSpec,
  subagent: ReactAgent<any> | Runnable,
  filteredState: Record<string, unknown>,
  config?: { signal?: AbortSignal },
): Promise<SwarmTaskResult> {
  const subagentType = task.subagentType ?? "general-purpose";
  const subagentState = {
    ...filteredState,
    messages: [new HumanMessage({ content: task.description })],
  };

  return withTimeout(
    subagent.invoke(subagentState, { signal: config?.signal }) as Promise<
      Record<string, unknown>
    >,
    TASK_TIMEOUT_MS,
  ).then(
    (result) => ({
      id: task.id,
      subagentType,
      status: "completed" as const,
      result: extractResultText(result),
    }),
    (err) => ({
      id: task.id,
      subagentType,
      status: "failed" as const,
      error: (err as Error).message ?? String(err),
    }),
  );
}

/**
 * Attempt to parse a string as JSON. Returns the parsed value on success,
 * or the original string if parsing fails. Used to convert structured
 * output result strings into objects for column storage.
 */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Verify that every referenced subagent type has a corresponding compiled
 * graph. Throws a descriptive error listing unknown types and available ones.
 */
function validateSubagentTypes(
  types: Set<string>,
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>,
) {
  const unknown = [...types].filter((t) => !(t in subagentGraphs));
  if (unknown.length > 0) {
    const available = Object.keys(subagentGraphs).join(", ");
    throw new Error(
      `Unknown subagent type(s): ${unknown.join(", ")}. Available: ${available}`,
    );
  }
}

/**
 * Validate a single task's `responseSchema`. Enforces that the top-level
 * type is `"object"` and that at least one property is declared.
 *
 * @throws Error with a message identifying the invalid task by id.
 */
function validateResponseSchema(
  taskId: string,
  schema: Record<string, unknown>,
) {
  if (schema.type !== "object") {
    throw new Error(
      `responseSchema must have type "object" at the top level. ` +
        `Wrap array schemas in an object. Invalid task: "${taskId}" has type "${schema.type}".`,
    );
  }

  const properties = schema.properties;

  if (
    !properties ||
    typeof properties !== "object" ||
    Object.keys(properties as Record<string, unknown>).length === 0
  ) {
    throw new Error(
      `responseSchema must define "properties" with at least one field. Invalid task: "${taskId}".`,
    );
  }
}

/**
 * Build a resolver function that maps `(subagentType, responseSchema?)` to
 * a compiled subagent graph.
 *
 * Default (no-schema) graphs are pre-seeded from `subagentGraphs`. When a
 * `responseSchema` is provided, the resolver compiles a variant via the
 * corresponding {@link SubagentFactory} and caches it under a
 * `"type::sha256hash"` key so identical schemas are compiled only once.
 */
function buildSubagentResolver(
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>,
  subagentFactories?: Record<string, SubagentFactory>,
) {
  const cache = new Map<string, ReactAgent<any> | Runnable>(
    Object.entries(subagentGraphs),
  );

  return (
    subagentType: string,
    responseSchema?: Record<string, unknown>,
  ): ReactAgent<any> | Runnable => {
    if (!responseSchema) {
      return cache.get(subagentType) ?? subagentGraphs[subagentType];
    }

    const hash = createHash("sha256")
      .update(JSON.stringify(responseSchema))
      .digest("hex")
      .slice(0, 12);
    const cacheKey = `${subagentType}::${hash}`;

    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const factory = subagentFactories?.[subagentType];
    if (!factory) {
      return subagentGraphs[subagentType];
    }

    const variant = factory(responseSchema);
    cache.set(cacheKey, variant);
    return variant;
  };
}

/**
 * Read a JSONL table, partition rows by filter, and interpolate the
 * instruction template against each matched row to produce task specs.
 *
 * Rows that fail interpolation (e.g., missing a referenced column) are
 * recorded in `interpolationErrors` rather than throwing, so partial
 * results are still dispatched.
 *
 * @throws Error if the table file cannot be read or parsed.
 */
async function prepareSwarm(
  read: ReadCallback,
  file: string,
  instruction: string,
  filter: SwarmFilter | undefined,
  subagentType: string | undefined,
  responseSchema: Record<string, unknown> | undefined,
): Promise<PreparedSwarm> {
  const content = await read(file);
  const rows = parseTableJsonl(content);

  const tasks: SwarmTaskSpec[] = [];
  const rowIndexById = new Map<string, number>();
  const interpolationErrors: Array<{ id: string; error: string }> = [];

  let skipped = 0;

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    if (filter && !evaluateFilter(filter, row)) {
      skipped++;
      continue;
    }

    const id = typeof row.id === "string" ? row.id : `row-${idx}`;
    try {
      const description = interpolateInstruction(instruction, row);
      tasks.push({
        id,
        description,
        ...(subagentType != null && { subagentType }),
        ...(responseSchema != null && { responseSchema }),
      });
      rowIndexById.set(id, idx);
    } catch (err) {
      interpolationErrors.push({
        id,
        error: (err as Error).message ?? String(err),
      });
    }
  }

  return { tasks, rowIndexById, rows, skipped, interpolationErrors };
}

/**
 * Assemble a {@link SwarmSummary} from dispatch results and any
 * interpolation errors. Failed tasks include both dispatch failures
 * and rows that could not be interpolated.
 */
function buildSummary(
  results: SwarmTaskResult[],
  interpolationErrors: Array<{ id: string; error: string }>,
  file: string,
  column: string,
  skipped: number,
): SwarmSummary {
  const completed = results.filter((r) => r.status === "completed").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const entries: SwarmResultEntry[] = results.map((r) => ({
    id: r.id,
    subagentType: r.subagentType,
    status: r.status,
    ...(r.result != null && { result: r.result }),
    ...(r.error != null && { error: r.error }),
  }));

  const failedTasks = [
    ...results
      .filter((r) => r.status === "failed")
      .map((r) => ({ id: r.id, error: r.error ?? "" })),
    ...interpolationErrors.map(({ id, error }) => ({
      id,
      error: `Interpolation: ${error}`,
    })),
  ];

  return {
    total: results.length,
    completed,
    failed: failed + interpolationErrors.length,
    skipped,
    file,
    column,
    results: entries,
    failedTasks,
  };
}

/**
 * Execute a swarm against a JSONL table file.
 *
 * Reads the table, partitions rows by filter, interpolates instructions,
 * dispatches with bounded concurrency, and streams each result back as a
 * column on the original row via the write callback.
 */
export async function executeSwarm(
  options: SwarmExecutionOptions,
): Promise<SwarmSummary> {
  const {
    file,
    instruction,
    column = "result",
    filter,
    subagentType,
    responseSchema,
    concurrency,
    subagentGraphs,
    subagentFactories,
    currentState,
    signal,
    read,
    write,
  } = options;

  const { tasks, rowIndexById, rows, skipped, interpolationErrors } =
    await prepareSwarm(
      read,
      file,
      instruction,
      filter,
      subagentType,
      responseSchema,
    );

  const effectiveConcurrency = Math.min(
    concurrency ?? DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );

  const usedTypes = new Set(
    tasks.map((t) => t.subagentType ?? "general-purpose"),
  );
  validateSubagentTypes(usedTypes, subagentGraphs);

  for (const task of tasks) {
    if (task.responseSchema) {
      validateResponseSchema(task.id, task.responseSchema);
    }
  }

  const resolveSubagent = buildSubagentResolver(
    subagentGraphs,
    subagentFactories,
  );
  const filteredState = filterStateForSubagent(currentState);

  // Dispatch with bounded concurrency, streaming writed on completion
  const results: SwarmTaskResult[] = new Array(tasks.length);
  const executing = new Set<Promise<void>>();

  for (let idx = 0; idx < tasks.length; idx++) {
    const task = tasks[idx];

    if (signal?.aborted) {
      results[idx] = {
        id: task.id,
        subagentType: task.subagentType ?? "general-purpose",
        status: "failed",
        error: "Aborted",
      };
      continue;
    }

    const subagent = resolveSubagent(
      task.subagentType ?? "general-purpose",
      task.responseSchema,
    );
    const promise = dispatchTask(task, subagent, filteredState, {
      signal,
    }).then((result) => {
      results[idx] = result;

      // Merge result into the row and write the updated table. write() is synchronous (pushes to pendingWrites),
      // so no serialization chain is needed — concurrent .then callbacks run as sequential microtasks.
      const rowIdx = rowIndexById.get(result.id);
      if (
        result.status === "completed" &&
        result.result != null &&
        rowIdx != null
      ) {
        const value = responseSchema
          ? tryParseJson(result.result)
          : result.result;
        rows[rowIdx] = { ...rows[rowIdx], [column]: value };
        write(file, serializeTableJsonl(rows));
      }
    });

    const tracked = promise.then(() => {
      executing.delete(tracked);
    });
    executing.add(tracked);
    if (executing.size >= effectiveConcurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);

  return buildSummary(results, interpolationErrors, file, column, skipped);
}
