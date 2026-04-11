/**
 * Swarm executor: dispatches a manifest's worth of tasks to subagents,
 * collects per-task results, and writes a run summary.
 *
 * The executor is the only piece of the swarm subsystem that talks to
 * subagents directly. Everything else (manifest parsing, result storage,
 * resume planning) is delegated to focused modules so this file stays
 * about the dispatch loop and nothing else.
 *
 * High-level flow:
 *   1. Read and validate the manifest.
 *   2. Validate that every entry's subagentType is registered.
 *   3. List existing result files and compute the resume plan.
 *   4. Pre-load task content for pending entries (failures here are
 *      converted to FailedResult records before any subagent runs).
 *   5. Dispatch pending entries under a concurrency semaphore. Each task
 *      retries independently inside `runSingleTaskWithRetries`; the call
 *      finishes when the slowest task (including its retries) is done.
 *   6. Write a SwarmExecutionSummary to summary.json.
 *
 * The executor never throws on per-task failures: those become FailedResult
 * files. It only throws on whole-run validation problems (manifest missing,
 * unknown subagent type) so the orchestrator gets a clear "this run cannot
 * proceed" signal.
 */

import { BaseMessage, HumanMessage, ReactAgent } from "langchain";
import { Runnable, type RunnableConfig } from "@langchain/core/runnables";
import type { BackendProtocolV2 } from "../backends/protocol.js";
import { filterStateForSubagent } from "../middleware/subagents.js";
import { readTextFile } from "./io.js";
import { resolveRunRelativePath } from "./layout.js";
import { readManifest } from "./manifest.js";
import {
  listResults,
  writeResult,
  writeSummary,
} from "./results-store.js";
import { computePending, type ResumePlan } from "./resume.js";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  MAX_CONCURRENCY,
  ManifestEntry,
  TASK_TIMEOUT_SECONDS,
  type CompletedResult,
  type FailedResult,
  type SwarmExecutionSummary,
  type TaskResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const DEFAULT_SUBAGENT = "general-purpose";

/** Content block types that carry no useful text for the orchestrator. */
const NON_TEXT_BLOCK_TYPES = new Set([
  "tool_use",
  "thinking",
  "redacted_thinking",
]);

/**
 * Limits the number of concurrent async operations against a shared resource.
 *
 * Preserved verbatim from the previous executor implementation. FIFO queue,
 * non-preemptive — exactly the behavior the dispatch loop relies on.
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

/**
 * Extract the user-visible text from a subagent's final response. Mirrors the
 * behavior of the previous implementation: prefer `structuredResponse` when
 * present, otherwise fall back to the last message's text content, filtering
 * out tool_use / thinking blocks that the orchestrator can't act on.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SwarmExecutionOptions {
  /** Map of subagent name → compiled agent graph. */
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;

  /** Resolved backend used for all I/O. */
  backend: BackendProtocolV2;

  /** Current parent agent state, filtered before being passed to subagents. */
  parentState: Record<string, unknown>;

  /** LangGraph RunnableConfig forwarded to subagent invocations. */
  config?: RunnableConfig;

  /** Maximum concurrent subagents. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;

  /** Attempts per task. Defaults to {@link DEFAULT_MAX_RETRIES}. */
  maxRetries?: number;

  /**
   * If true, re-dispatch tasks whose previous result file is `failed`. By
   * default failed tasks are skipped — the orchestrator must opt in to
   * retrying them.
   */
  retryFailed?: boolean;
}

/**
 * Execute every pending task in `runDir`'s manifest and persist their results.
 *
 * @throws Error if the manifest is missing or invalid, or if any entry refers
 *   to an unknown subagent type. Per-task failures never throw — they are
 *   recorded as failed result files instead.
 */
export async function executeSwarm(
  runDir: string,
  options: SwarmExecutionOptions,
): Promise<SwarmExecutionSummary> {
  const {
    subagentGraphs,
    backend,
    parentState,
    config,
    concurrency = DEFAULT_CONCURRENCY,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryFailed = false,
  } = options;

  const startedAt = new Date().toISOString();
  const effectiveConcurrency = Math.max(
    1,
    Math.min(concurrency, MAX_CONCURRENCY),
  );

  // 1. Load and validate the manifest. ManifestNotFoundError /
  //    ManifestParseError propagate to the caller.
  const manifest = await readManifest(backend, runDir);

  // 2. Validate subagent types up front. Throwing here means we never
  //    partially run; either the orchestrator fixes the manifest or it gets
  //    a clear error.
  validateSubagentTypes(manifest, subagentGraphs);

  // 3. Load existing results and compute what to run.
  const resultIndex = await listResults(backend, runDir);
  const plan = computePending(manifest, resultIndex, retryFailed);

  // 4. Pre-load task content. Files that fail to read get a failed result
  //    written immediately and are removed from the dispatch list.
  const dispatchable = await preloadTaskContent(
    backend,
    runDir,
    plan,
  );

  // 5. Dispatch pending tasks under the semaphore. Each task retries
  //    independently and writes its result file inline.
  const semaphore = createSemaphore(effectiveConcurrency);
  await Promise.all(
    dispatchable.map((entry) =>
      runWithSemaphore(semaphore, () =>
        runSingleTaskWithRetries({
          entry,
          content: dispatchable.contentFor(entry.id),
          subagentGraphs,
          parentState,
          config,
          maxRetries,
          backend,
          runDir,
        }),
      ),
    ),
  );

  // 6. Re-list results to build an authoritative count for the summary.
  const finalIndex = await listResults(backend, runDir);
  const summary: SwarmExecutionSummary = {
    runDir,
    total: manifest.length,
    completed: countByStatus(finalIndex, "completed"),
    failed: countByStatus(finalIndex, "failed"),
    skipped: plan.alreadyCompleted.length + plan.alreadyFailed.length,
    dispatched: dispatchable.length + dispatchable.preDispatchFailures,
    orphanedResultIds: plan.orphanedResultIds,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  // Summary is best-effort. The per-task result files are authoritative; if
  // we can't persist the summary we don't fail the run. The next swarm call
  // will rebuild it from the result files.
  try {
    await writeSummary(backend, runDir, summary);
  } catch (_err) {
    // Silently swallowed by design — see comment above.
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function validateSubagentTypes(
  manifest: ManifestEntry[],
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>,
): void {
  const unknown = manifest.find(
    (entry) => !((entry.subagentType ?? DEFAULT_SUBAGENT) in subagentGraphs),
  );
  if (!unknown) return;

  const type = unknown.subagentType ?? DEFAULT_SUBAGENT;
  const allowed = Object.keys(subagentGraphs)
    .map((k) => `"${k}"`)
    .join(", ");
  throw new Error(
    `Task "${unknown.id}" references unknown subagentType "${type}". ` +
      `Available: ${allowed}`,
  );
}

/**
 * Result of the pre-dispatch task-content load step.
 *
 * `length` and iteration give the executor the entries it should still
 * dispatch; `contentFor(id)` exposes the loaded prompt; `preDispatchFailures`
 * counts entries that became failed result files before the dispatch loop.
 */
interface DispatchableTasks extends Iterable<ManifestEntry> {
  length: number;
  preDispatchFailures: number;
  contentFor(id: string): string;
  map<T>(fn: (entry: ManifestEntry) => T): T[];
}

async function preloadTaskContent(
  backend: BackendProtocolV2,
  runDir: string,
  plan: ResumePlan,
): Promise<DispatchableTasks> {
  const entries: ManifestEntry[] = [];
  const contentMap = new Map<string, string>();
  let preDispatchFailures = 0;
  const startedAt = new Date().toISOString();

  for (const entry of plan.pending) {
    const path = resolveRunRelativePath(runDir, entry.descriptionPath);
    const result = await readTextFile(backend, path);
    if (result.kind === "ok") {
      entries.push(entry);
      contentMap.set(entry.id, result.content);
      continue;
    }

    // Could not read the task file. Record a failed result and skip.
    // We never invoked the subagent for these, but the schema requires
    // attempts >= 1; the error message makes the failure mode obvious.
    preDispatchFailures++;
    const failed: FailedResult = {
      id: entry.id,
      status: "failed",
      subagentType: entry.subagentType ?? DEFAULT_SUBAGENT,
      attempts: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      error:
        result.kind === "missing"
          ? `task file missing: ${path}`
          : `failed to read task file '${path}': ${result.error}`,
    };
    try {
      await writeResult(backend, runDir, failed);
    } catch (_err) {
      // If even the failure record can't be written, the next swarm call
      // will see the task as missing (no result file) and re-attempt it,
      // which is the correct recovery path.
    }
  }

  return {
    length: entries.length,
    preDispatchFailures,
    contentFor(id: string): string {
      const content = contentMap.get(id);
      if (content == null) {
        throw new Error(`internal: no preloaded content for task '${id}'`);
      }
      return content;
    },
    map<T>(fn: (entry: ManifestEntry) => T): T[] {
      return entries.map(fn);
    },
    [Symbol.iterator]: () => entries[Symbol.iterator](),
  };
}

async function runWithSemaphore<T>(
  semaphore: Semaphore,
  fn: () => Promise<T>,
): Promise<T> {
  await semaphore.acquire();
  try {
    return await fn();
  } finally {
    semaphore.release();
  }
}

interface RunSingleTaskOptions {
  entry: ManifestEntry;
  content: string;
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;
  parentState: Record<string, unknown>;
  config?: RunnableConfig;
  maxRetries: number;
  backend: BackendProtocolV2;
  runDir: string;
}

/**
 * Run a single task, retrying up to `maxRetries` times, then write its result
 * file. Never throws — internal failures (e.g., write errors) are themselves
 * captured as failed result writes via a best-effort log.
 */
async function runSingleTaskWithRetries(
  opts: RunSingleTaskOptions,
): Promise<void> {
  const {
    entry,
    content,
    subagentGraphs,
    parentState,
    config,
    maxRetries,
    backend,
    runDir,
  } = opts;

  const subagentType = entry.subagentType ?? DEFAULT_SUBAGENT;
  const subagent = subagentGraphs[subagentType];
  const startedAt = new Date().toISOString();

  let lastError = "";
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const subagentState = {
      ...filterStateForSubagent(parentState),
      messages: [new HumanMessage({ content })],
    };

    const outcome = await invokeWithTimeout(subagent, subagentState, config);
    if (outcome.ok) {
      const result: CompletedResult = {
        id: entry.id,
        status: "completed",
        subagentType,
        attempts: attempt,
        startedAt,
        finishedAt: new Date().toISOString(),
        result: extractResultText(outcome.value),
      };
      await persistResult(backend, runDir, result);
      return;
    }
    lastError = outcome.error;
  }

  const failure: FailedResult = {
    id: entry.id,
    status: "failed",
    subagentType,
    attempts: maxRetries,
    startedAt,
    finishedAt: new Date().toISOString(),
    error: lastError || `Task "${entry.id}" failed`,
  };
  await persistResult(backend, runDir, failure);
}

interface InvokeSuccess {
  ok: true;
  value: Record<string, unknown>;
}
interface InvokeFailure {
  ok: false;
  error: string;
}

async function invokeWithTimeout(
  subagent: ReactAgent<any> | Runnable,
  subagentState: Record<string, unknown>,
  config?: RunnableConfig,
): Promise<InvokeSuccess | InvokeFailure> {
  const timeoutMs = TASK_TIMEOUT_SECONDS * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const value = await Promise.race([
      subagent.invoke(subagentState, config) as Promise<Record<string, unknown>>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${TASK_TIMEOUT_SECONDS}s`)),
          timeoutMs,
        );
      }),
    ]);
    return { ok: true, value };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "subagent invocation failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist a result file. Failures here are exceptional — every task should
 * always end up with a result on disk — but we don't want a write error to
 * crash the entire run. The missing result will be picked up by the resume
 * planner on the next swarm call.
 */
async function persistResult(
  backend: BackendProtocolV2,
  runDir: string,
  result: TaskResult,
): Promise<void> {
  try {
    await writeResult(backend, runDir, result);
  } catch (_err) {
    // Silently swallowed by design — see function doc.
  }
}

function countByStatus(
  index: Map<string, TaskResult | "corrupt">,
  status: "completed" | "failed",
): number {
  let count = 0;
  for (const value of index.values()) {
    if (value === "corrupt") continue;
    if (value.status === status) count++;
  }
  return count;
}
