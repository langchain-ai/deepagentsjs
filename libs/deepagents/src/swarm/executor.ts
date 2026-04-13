/**
 * Swarm executor: dispatches tasks to subagents in parallel with concurrency
 * control and writes a results table.
 *
 * Each task runs exactly once — there are no retries. The orchestrator owns
 * error recovery and can decide to re-run failures, split tasks, or proceed
 * with partial results based on the summary.
 */

import { BaseMessage, HumanMessage, ReactAgent } from "langchain";
import { Runnable, type RunnableConfig } from "@langchain/core/runnables";
import type { BackendProtocolV2 } from "../backends/protocol.js";
import { filterStateForSubagent } from "../middleware/subagents.js";
import { serializeResultsJsonl } from "./parse.js";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  TASK_TIMEOUT_SECONDS,
  type FailedTaskInfo,
  type SwarmExecutionSummary,
  type SwarmTaskResult,
  type SwarmTaskSpec,
} from "./types.js";

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_SUBAGENT = "general-purpose";

/** Content block types that carry no useful text for the orchestrator. */
const NON_TEXT_BLOCK_TYPES = new Set([
  "tool_use",
  "thinking",
  "redacted_thinking",
]);

// ── Semaphore ───────────────────────────────────────────────────────────

/**
 * Limits concurrent async operations. FIFO queue — waiting callers
 * resolve in the order they acquired.
 */
interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
}

function createSemaphore(limit: number): Semaphore {
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    async acquire(): Promise<void> {
      if (active < limit) {
        active++;
        return;
      }
      await new Promise<void>((resolve) => queue.push(resolve));
      active++;
    },
    release(): void {
      active--;
      const next = queue.shift();
      if (next) next();
    },
  };
}

// ── Result extraction ───────────────────────────────────────────────────

/**
 * Extract the user-visible text from a subagent's response.
 *
 * Preference order:
 * 1. `structuredResponse` (serialized to JSON)
 * 2. Last message's text content (tool_use/thinking blocks filtered out)
 * 3. Fallback: `"Task completed"` / `"Task completed (no output)"`
 */
function extractResultText(result: Record<string, unknown>): string {
  if (result.structuredResponse != null) {
    return JSON.stringify(result.structuredResponse);
  }

  const messages = result.messages as BaseMessage[] | undefined;
  const lastMessage = messages?.[messages.length - 1];

  if (!lastMessage) {
    return "Task completed (no output)";
  }

  const content = lastMessage.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return (
      content
        .filter((block) => !NON_TEXT_BLOCK_TYPES.has(block.type))
        .map((block) => ("text" in block ? block.text : JSON.stringify(block)))
        .join("\n") || "Task completed"
    );
  }

  return "Task completed";
}

// ── Single task execution ───────────────────────────────────────────────

/**
 * Invoke a subagent for a single task with a per-task timeout.
 *
 * Returns a lean `SwarmTaskResult` without the original `description`.
 */
async function runSingleTask(
  task: SwarmTaskSpec,
  subagent: ReactAgent<any> | Runnable,
  parentState: Record<string, unknown>,
  config?: RunnableConfig,
): Promise<SwarmTaskResult> {
  const subagentState = {
    ...filterStateForSubagent(parentState),
    messages: [new HumanMessage({ content: task.description })],
  };

  const subagentType = task.subagentType ?? DEFAULT_SUBAGENT;
  const timeoutMs = TASK_TIMEOUT_SECONDS * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      subagent.invoke(subagentState, config) as Promise<
        Record<string, unknown>
      >,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${TASK_TIMEOUT_SECONDS}s`)),
          timeoutMs,
        );
      }),
    ]);

    return {
      id: task.id,
      subagentType,
      status: "completed",
      result: extractResultText(result),
    };
  } catch (err: any) {
    return {
      id: task.id,
      subagentType,
      status: "failed",
      error: err.message ?? `Task "${task.id}" failed`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Results file writer ─────────────────────────────────────────────────

/**
 * Write the results table to a unique run directory.
 *
 * @returns The run directory path (e.g. `swarm_runs/<uuid>`)
 */
async function writeResults(
  backend: BackendProtocolV2,
  results: SwarmTaskResult[],
): Promise<string> {
  const runId = randomUUID();
  const resultsDir = `swarm_runs/${runId}`;
  const resultsPath = `${resultsDir}/results.jsonl`;
  const content = serializeResultsJsonl(results);
  await backend.write(resultsPath, content);
  return resultsDir;
}

// ── Public API ──────────────────────────────────────────────────────────

/** Options for {@link executeSwarm}. */
export interface SwarmExecutionOptions {
  /** Map of subagent name to compiled agent graph. */
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;

  /** Backend for writing result files. */
  backend: BackendProtocolV2;

  /** Current parent agent state (filtered before passing to subagents). */
  parentState: Record<string, unknown>;

  /** LangGraph RunnableConfig forwarded to subagent invocations. */
  config?: RunnableConfig;

  /**
   * Maximum concurrent subagents.
   * @defaultValue {@link DEFAULT_CONCURRENCY}
   */
  concurrency?: number;
}

/**
 * Execute a swarm run: fan out tasks across subagents with concurrency control.
 *
 * Each task is dispatched exactly once — there are no retries. The summary
 * includes a `failedTasks` array so the orchestrator can decide how to handle
 * failures.
 *
 * @param tasks - Validated task specs to execute
 * @param options - Executor configuration
 * @returns Summary with counts, results directory, and failed task details
 *
 * @throws Error if any task references an unknown `subagentType`
 */
export async function executeSwarm(
  tasks: SwarmTaskSpec[],
  options: SwarmExecutionOptions,
): Promise<SwarmExecutionSummary> {
  const {
    subagentGraphs,
    backend,
    parentState,
    config,
    concurrency = DEFAULT_CONCURRENCY,
  } = options;

  const effectiveConcurrency = Math.max(
    1,
    Math.min(concurrency, MAX_CONCURRENCY),
  );

  // ── Validate subagent types before dispatch ──────────────────────────
  const unknownTask = tasks.find(
    (t) => !((t.subagentType ?? DEFAULT_SUBAGENT) in subagentGraphs),
  );
  if (unknownTask) {
    const type = unknownTask.subagentType ?? DEFAULT_SUBAGENT;
    const allowed = Object.keys(subagentGraphs)
      .map((k) => `"${k}"`)
      .join(", ");
    throw new Error(
      `Task "${unknownTask.id}" references unknown subagentType "${type}". ` +
        `Available: ${allowed}`,
    );
  }

  // ── Dispatch all tasks in parallel under the semaphore ───────────────
  const semaphore = createSemaphore(effectiveConcurrency);

  const runWithSemaphore = async (
    task: SwarmTaskSpec,
  ): Promise<SwarmTaskResult> => {
    await semaphore.acquire();
    try {
      const subagent = subagentGraphs[task.subagentType ?? DEFAULT_SUBAGENT];
      return await runSingleTask(task, subagent, parentState, config);
    } finally {
      semaphore.release();
    }
  };

  const results = await Promise.all(tasks.map(runWithSemaphore));

  // ── Write results and build summary ──────────────────────────────────
  const resultsDir = await writeResults(backend, results);

  const completedCount = results.filter((r) => r.status === "completed").length;
  const failedResults = results.filter((r) => r.status === "failed");

  const failedTasks: FailedTaskInfo[] = failedResults.map((r) => ({
    id: r.id,
    error: r.error ?? `Task "${r.id}" failed`,
  }));

  return {
    total: results.length,
    completed: completedCount,
    failed: failedResults.length,
    resultsDir,
    failedTasks,
  };
}
