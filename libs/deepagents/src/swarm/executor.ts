import { HumanMessage } from "@langchain/core/messages";
import type { BaseMessage, ContentBlock } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import type { ReactAgent } from "langchain";
import type { BackendProtocolV2 } from "../backends/v2/protocol.js";
import type {
  SwarmTaskSpec,
  SwarmTaskResult,
  SwarmExecutionSummary,
} from "./types.js";
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  TASK_TIMEOUT_MS,
} from "./types.js";
import { serializeResultsJsonl } from "./parse.js";
import type { SubagentFactory } from "../symbols.js";
import { createHash } from "node:crypto";

/**
 * Everything the executor needs to run a swarm.
 */
export interface SwarmExecutionOptions {
  /**
   * Validated task specs to dispatch.
   */
  tasks: SwarmTaskSpec[];

  /**
   * Map of subagent type name → compiled runnable.
   */
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;

  /**
   * Backend for writing results.
   */
  backend: BackendProtocolV2;

  /**
   * Max parallel dispatches. Defaults to DEFAULT_CONCURRENCY.
   */
  concurrency?: number;

  /**
   * Pre-serialized tasks.jsonl to write to the run directory (virtual-table form).
   */
  synthesizedTasksJsonl?: string;

  /**
   * Current agent state to filter and pass to subagents.
   */
  currentState: Record<string, unknown>;

  /**
   * Abort signal. When aborted, pending task dispatches are skipped
   * and in-flight subagent invocations are cancelled.
   */
  signal?: AbortSignal;

  /**
   * Factory functions for compiling subagent variants with dynamic responseFormat`.
   * Keyed by subagent type name. When a task has `responseSchema`, the executor calls
   * the factory to compile a variant and caches it for the duration of the swarm call.
   */
  subagentFactories?: Record<string, SubagentFactory>;
}

/**
 * State keys excluded when passing state to subagents.
 * Mirrors the pattern in middleware/subagents.ts.
 */
const EXCLUDED_STATE_KEYS = [
  "messages",
  "todos",
  "structuredResponse",
  "skillsMetadata",
  "memoryContents",
];

/**
 * Content block types that should be filtered out of subagent responses.
 */
const INVALID_CONTENT_BLOCK_TYPES = [
  "tool_use",
  "thinking",
  "redacted_thinking",
];

/**
 * Create a shallow copy of agent state with excluded keys removed.
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
 * Build a cache key for a (subagentType, responseSchema) pair. Default graphs
 * are keyed by type name alone. Schema variants use "type::hash" where hash is
 * a truncated SHA-256 of the serialized schema — the "::" separator guarantees
 * no collision with default keys.
 */
function buildSchemaCacheKey(
  subagentType: string,
  schema: Record<string, unknown>,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(schema))
    .digest("hex")
    .slice(0, 12);
  return `${subagentType}::${hash}`;
}

/**
 * Extract the text content from a subagent's final message.
 *
 * Handles both string content and array content blocks,
 * filtering out tool_use/thinking/redacted_thinking blocks.
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
    if (filtered.length === 0) {
      return "Task completed";
    }

    return filtered
      .map((block) => ("text" in block ? block.text : JSON.stringify(block)))
      .join("\n");
  }

  return "Task completed";
}

/**
 * Race a promise against a timeout, rejecting if the timeout fires first.
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
 * Dispatch a single task to a subagent with a timeout.
 */
async function dispatchTask(
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

  try {
    const result = await withTimeout(
      subagent.invoke(subagentState, {
        signal: config?.signal,
      }) as Promise<Record<string, unknown>>,
      TASK_TIMEOUT_MS,
    );

    return {
      id: task.id,
      subagentType,
      status: "completed",
      result: extractResultText(result),
    };
  } catch (err) {
    return {
      id: task.id,
      subagentType,
      status: "failed",
      error: (err as Error).message ?? String(err),
    };
  }
}

/**
 * Run async functions over an array with bounded concurrency.
 *
 * Maintains a pool of in-flight promises. When the pool is full,
 * waits for one to resolve before adding more. Returns results
 * in input order.
 */
async function withConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<SwarmTaskResult>,
): Promise<SwarmTaskResult[]> {
  const results: SwarmTaskResult[] = new Array(items.length);
  const executing = new Set<Promise<void>>();

  for (let idx = 0; idx < items.length; idx++) {
    const promise = fn(items[idx], idx).then((result) => {
      results[idx] = result;
    });

    const tracked = promise.then(() => {
      executing.delete(tracked);
    });
    executing.add(tracked);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

function validateSubagentTypes(
  tasks: SwarmTaskSpec[],
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>,
) {
  const unknownTypes = new Set<string>();
  for (const task of tasks) {
    const subagentType = task.subagentType ?? "general-purpose";
    if (!(subagentType in subagentGraphs)) {
      unknownTypes.add(subagentType);
    }
  }

  if (unknownTypes.size > 0) {
    const available = Object.keys(subagentGraphs).join(", ");
    throw new Error(
      `Unknown subagent type(s): ${[...unknownTypes].join(", ")}. Available: ${available}`,
    );
  }
}

function validateResponseSchemas(tasks: SwarmTaskSpec[]) {
  const invalidTypeTasks: string[] = [];
  const missingPropertiesTasks: string[] = [];
  for (const task of tasks) {
    if (task.responseSchema) {
      const schemaType = task.responseSchema.type;
      if (schemaType !== "object") {
        invalidTypeTasks.push(`"${task.id}" has type "${schemaType}"`);
        continue;
      }
      const properties = task.responseSchema.properties;
      if (
        !properties ||
        typeof properties !== "object" ||
        Object.keys(properties as Record<string, unknown>).length === 0
      ) {
        missingPropertiesTasks.push(`"${task.id}"`);
      }
    }
  }

  if (invalidTypeTasks.length > 0) {
    throw new Error(
      `responseSchema must have type "object" at the top level. ` +
        `Wrap array schemas in an object (e.g., { type: "object", properties: { results: { type: "array", ... } } }). ` +
        `Invalid tasks: ${invalidTypeTasks.join(", ")}.`,
    );
  }

  if (missingPropertiesTasks.length > 0) {
    throw new Error(
      `responseSchema must define "properties" with at least one field. ` +
        `Open schemas (e.g., { type: "object", additionalProperties: {...} } alone) are not supported — ` +
        `declare each expected field explicitly. ` +
        `Invalid tasks: ${missingPropertiesTasks.join(", ")}.`,
    );
  }
}

/**
 * Execute a swarm: dispatch tasks in parallel, collect results,
 * write output files, and return a summary.
 *
 * @throws Error if any task references an unknown subagent type
 */
export async function executeSwarm(
  options: SwarmExecutionOptions,
): Promise<SwarmExecutionSummary> {
  const {
    tasks,
    subagentGraphs,
    backend,
    concurrency = DEFAULT_CONCURRENCY,
    synthesizedTasksJsonl,
    currentState,
    signal,
    subagentFactories,
  } = options;

  // Generate run directory
  const resultsDir = `/swarm_runs/${crypto.randomUUID()}`;
  const effectiveConcurrency = Math.min(concurrency, MAX_CONCURRENCY);

  validateSubagentTypes(tasks, subagentGraphs);
  validateResponseSchemas(tasks);

  // Unified cache for all subagent graph lookups. Pre-seeded with the
  // default (no-schema) compiled graphs so every lookup — with or without
  // responseSchema — goes through the same code path.
  const variantCache = new Map<string, ReactAgent<any> | Runnable>();
  for (const [type, graph] of Object.entries(subagentGraphs)) {
    variantCache.set(type, graph);
  }

  /**
   * Resolve the subagent graph for a task. Uses a unified cache:
   * - No responseSchema → key is the type name (pre-seeded from subagentGraphs)
   * - Has responseSchema → key is "type::hash", compiled on first miss via factory
   */
  const resolveSubagent = (task: SwarmTaskSpec): ReactAgent<any> | Runnable => {
    const subagentType = task.subagentType ?? "general-purpose";
    const cacheKey = task.responseSchema
      ? buildSchemaCacheKey(subagentType, task.responseSchema)
      : subagentType;

    const cached = variantCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Cache miss - compile via factory
    const factory = subagentFactories?.[subagentType];
    if (!factory) {
      return subagentGraphs[subagentType];
    }

    const variant = factory(task.responseSchema);
    variantCache.set(cacheKey, variant);

    return variant;
  };

  // Filter state once
  const filteredState = filterStateForSubagent(currentState);

  // Dispatch all tasks
  const results = await withConcurrencyLimit(
    tasks,
    effectiveConcurrency,
    (task) => {
      if (signal?.aborted) {
        return Promise.resolve({
          id: task.id,
          subagentType: task.subagentType ?? "general-purpose",
          status: "failed" as const,
          error: "Aborted",
        });
      }
      const subagent = resolveSubagent(task);
      return dispatchTask(task, subagent, filteredState, { signal });
    },
  );

  // Write results.jsonl
  await backend.write(
    `${resultsDir}/results.jsonl`,
    serializeResultsJsonl(results),
  );

  // Write tasks.jsonl if synthesized (virtual-table form)
  if (synthesizedTasksJsonl) {
    await backend.write(`${resultsDir}/tasks.jsonl`, synthesizedTasksJsonl);
  }

  // Build summary
  const completedCount = results.filter((r) => r.status === "completed").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const failedTasks = results
    .filter((r) => r.status === "failed")
    .map((r) => ({ id: r.id, error: r.error ?? "" }));

  return {
    total: tasks.length,
    completed: completedCount,
    failed: failedCount,
    resultsDir,
    results,
    failedTasks,
  };
}
