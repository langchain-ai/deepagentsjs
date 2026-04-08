import { BaseMessage, HumanMessage, ReactAgent } from "langchain";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  MAX_CONCURRENCY,
  SwarmExecutionSummary,
  SwarmTaskResult,
  SwarmTaskSpec,
  TASK_TIMEOUT_SECONDS,
} from "./types.js";
import { Runnable, type RunnableConfig } from "@langchain/core/runnables";
import { BackendProtocolV2 } from "../backends/protocol.js";
import { filterStateForSubagent } from "../middleware/subagents.js";
import { serializeResultsJsonl } from "./parse.js";

// Content block types that carry no useful text for the orchestrator.
const NON_TEXT_BLOCK_TYPES = new Set([
  "tool_use",
  "thinking",
  "redacted_thinking",
]);

/**
 * Options for the swarm executor.
 */
export interface SwarmExecutionOptions {
  /**
   * Map of subagent name -> compiled agent graph.
   */
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;

  /**
   * Backend for reading/writing the tasks.jsonl file.
   */
  backend: BackendProtocolV2;

  /**
   * Path to the tasks.jsonl file within the backend filesystem.
   */
  tasksPath: string;

  /**
   * Current parent agent state (filtered before passing to subagents).
   */
  parentState: Record<string, unknown>;

  /**
   * LangGraph RunnableConfig to forward to subagent invocations.
   */
  config?: RunnableConfig;

  /**
   * Maximum concurrent subagents.
   *
   * @default 10
   */
  concurrency?: number;

  /**
   * Max attemtps per task.
   *
   * @default 3
   */
  maxRetries?: number;
}

/**
 * Controls concurrent access to a shared resource by limiting the number
 * of async operations that can run simultaneously.
 */
interface Semaphore {
  /**
   * Acquire a slot. Resolves immediately if a slot is available,
   * otherwise waits until one is released.
   */
  acquire(): Promise<void>;

  /**
   * Release a slot, unblocking the next waiting caller if any.
   */
  release(): void;
}

/**
 * Write the enriched results file back to the backend.
 */
async function writeResults(
  backend: BackendProtocolV2,
  tasksPath: string,
  results: SwarmTaskResult[],
): Promise<void> {
  const content = serializeResultsJsonl(results);
  if (backend.uploadFiles) {
    await backend.uploadFiles([[tasksPath, new TextEncoder().encode(content)]]);
  } else {
    await backend.write(tasksPath, content);
  }
}

/**
 * Create a semaphore that limits the number of concurrent async operations.
 *
 * @param limit - Maximum number of concurrent operations
 */
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
      if (next) {
        next();
      }
    },
  };
}

/**
 * Extract the final text content from a subagent result.
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

/**
 * Run a single task against its subagent with a timeout.
 *
 * @returns SwarmTaskResult with status "completed" or "failed"
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
      ...task,
      status: "completed",
      result: extractResultText(result),
    };
  } catch (err: any) {
    return {
      ...task,
      status: "failed",
      error: err.message ?? `Task "${task.id}" failed`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a swarm run: fan out tasks across subagents with concurrency
 * control and a multi-pass retry loop.
 *
 * Algorithm:
 * 1. Parse the pending task list.
 * 2. For each pass, launch all pending tasks concurrently bounded by a
 *    semaphore (concurrency cap).
 * 3. After each pass, collect results. Failed tasks are re-queued for
 *    the next pass.
 * 4. Repeat until all tasks succeed or the retry limit is exhausted.
 * 5. Write the enriched tasks.jsonl back via the backend.
 * 6. Return a structured summary.
 *
 * @param tasks - Validated task specs to execute
 * @param options - Executor configuration
 * @returns SwarmExecutionSummary with total/completed/failed counts
 */
export async function executeSwarm(
  tasks: SwarmTaskSpec[],
  options: SwarmExecutionOptions,
): Promise<SwarmExecutionSummary> {
  const {
    subagentGraphs,
    backend,
    tasksPath,
    parentState,
    config,
    concurrency = DEFAULT_CONCURRENCY,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options;

  const effectiveConcurrency = Math.max(
    1,
    Math.min(concurrency, MAX_CONCURRENCY),
  );

  // Validate subagent types to ensure valid subagents
  const unknownTask = tasks.find(
    (t) => !((t.subagentType ?? "general-purpose") in subagentGraphs),
  );
  if (unknownTask) {
    const type = unknownTask.subagentType ?? "general-purpose";
    const allowed = Object.keys(subagentGraphs)
      .map((k) => `"${k}"`)
      .join(", ");
    throw new Error(
      `Task "${unknownTask.id}" references unknown subagentType "${type}". ` +
        `Available: ${allowed}`,
    );
  }

  const semaphore = createSemaphore(effectiveConcurrency);
  const resultsMap = new Map<string, SwarmTaskResult>();
  let pendingTasks = [...tasks];

  for (
    let attempt = 1;
    attempt <= maxRetries && pendingTasks.length > 0;
    attempt++
  ) {
    const isLastAttempt = attempt === maxRetries;

    const runWithSemaphore = async (
      task: SwarmTaskSpec,
    ): Promise<SwarmTaskResult> => {
      await semaphore.acquire();
      try {
        const subagent = subagentGraphs[task.subagentType ?? "general-purpose"];
        return await runSingleTask(task, subagent, parentState, config);
      } finally {
        semaphore.release();
      }
    };

    const passResults = await Promise.all(pendingTasks.map(runWithSemaphore));

    const nextPending: SwarmTaskSpec[] = [];
    for (let idx = 0; idx < passResults.length; idx++) {
      const taskResult = passResults[idx];
      if (taskResult.status === "completed" || isLastAttempt) {
        resultsMap.set(taskResult.id, taskResult);
      } else {
        nextPending.push(pendingTasks[idx]);
      }
    }

    pendingTasks = nextPending;
  }

  const results: SwarmTaskResult[] = tasks.map(
    (task) =>
      resultsMap.get(task.id) ?? {
        ...task,
        status: "failed",
        error: "not executed",
      },
  );
  await writeResults(backend, tasksPath, results);

  return {
    total: results.length,
    completed: results.filter((r) => r.status === "completed").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
}
