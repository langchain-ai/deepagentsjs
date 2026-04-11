/**
 * Swarm middleware: registers four tools that let the orchestrator agent set
 * up, run, and read results from a swarm of subagents.
 *
 * The middleware exposes:
 *
 *   - `swarm_init`        — create a fresh run directory + empty manifest.
 *   - `swarm_add_tasks`   — write a batch of task files and append to the manifest.
 *   - `swarm`             — execute the manifest's pending tasks in parallel.
 *   - `swarm_get_results` — read per-task results with optional pagination/filter.
 *
 * The system prompt is rendered conditionally: when the resolved backend
 * supports `execute`, orchestrators are also told they can build the run
 * directory directly via shell scripts. When it does not, they are told to
 * use the helper tools exclusively and warned about the practical context-
 * window ceiling.
 */

import { randomUUID } from "node:crypto";
import { Runnable } from "@langchain/core/runnables";
import { getCurrentTaskInput } from "@langchain/langgraph";
import {
  AgentMiddleware,
  context,
  createMiddleware,
  ReactAgent,
  SystemMessage,
  tool,
  type ToolRuntime,
} from "langchain";
import {
  type AnyBackendProtocol,
  type BackendFactory,
  isSandboxBackend,
  resolveBackend,
} from "../backends/protocol.js";
import { executeSwarm } from "../swarm/executor.js";
import {
  relativeTaskPath,
  resultPath,
  runDirFor,
  taskPath,
} from "../swarm/layout.js";
import {
  appendManifest,
  initializeManifest,
  isManifestNotFoundError,
  isManifestParseError,
  readManifest,
} from "../swarm/manifest.js";
import { listResults } from "../swarm/results-store.js";
import {
  DEFAULT_GET_RESULTS_LIMIT,
  MAX_ADD_TASKS_BATCH,
  MAX_GET_RESULTS_LIMIT,
  MAX_RESULT_INLINE_SIZE,
  type GetResultsEntry,
  type ManifestEntry,
  type SwarmGetResultsResponse,
  SwarmAddTasksInputSchema,
  SwarmGetResultsInputSchema,
  SwarmInitInputSchema,
  SwarmInputSchema,
  type TaskResult,
} from "../swarm/types.js";

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

/**
 * Backend-agnostic guidance shared by both prompt variants.
 *
 * Covers what swarm is, when to use it, what makes a good task description,
 * decomposition patterns, the resume contract, and the file layout the
 * orchestrator can rely on.
 */
export const SWARM_BASE_PROMPT = context`
  ## \`swarm\` (parallel subagent execution)

  Use \`swarm\` to fan out many independent tasks across multiple subagents and
  aggregate their results. Each task runs in its own subagent, in parallel,
  bounded by a concurrency cap.

  ### When to use swarm

  Use swarm when:
  - The input is too large to process in a single pass (a few hundred KB or more).
  - You have many items that each need individual analysis or transformation.
  - Work can be decomposed into independent, parallel subtasks.

  Use \`task\` instead when you have a small number of subtasks, when one
  subtask depends on the output of another, or when the work is exploratory.

  ### Run directory layout

  Every swarm run lives in its own self-contained directory:

  \`\`\`
  swarm_runs/<run-name>/
    manifest.jsonl       # one row per task: {id, descriptionPath, subagentType?}
    tasks/<id>.txt       # raw prompt content for each task — plain text, no escaping
    results/<id>.json    # one result file per dispatched task
    summary.json         # latest run summary
  \`\`\`

  Task files are plain text. Multiline content (log chunks, code, documents)
  goes in directly — no JSON escaping, no \`\\n\` gymnastics.

  ### Task description quality

  Each subagent receives **only** its task description — no other context.
  Make descriptions self-contained and prescriptive: state the data, the
  expected output schema, and the exact processing logic. The subagent should
  not need to explore or interpret.

  When results need to be aggregated (counting, classification, extraction),
  instruct each subagent to respond with structured JSON only — no prose, no
  tables — and include the exact schema in the description.

  ### Resume and re-run

  Calling \`swarm\` again on the same \`runDir\` is safe and idempotent:
  completed tasks are skipped, missing tasks are dispatched, and failed tasks
  are left alone. To explicitly retry failures pass \`retryFailed: true\`. To
  start fresh, create a new run directory via \`swarm_init\` — never reuse a
  directory across logically distinct runs.

  Do not call \`swarm\` repeatedly to verify or cross-check results. Treat the
  first run's outputs as authoritative.

  ### Decomposition patterns

  - **Flat fan-out**: split a dataset into equal chunks. Good for large files,
    classification, extraction.
  - **One-per-item**: one task per discrete unit (file, document, URL). Good
    for summarizing collections or processing independent inputs.
  - **Dimensional**: multiple tasks examine the same input from different
    angles. Good for code review, multi-criteria evaluation.
`;

/**
 * Extra guidance shown when the backend supports `execute`.
 *
 * Tells the orchestrator it has two ways to build a run directory:
 *
 *   1. Use the helper tools (`swarm_init` + `swarm_add_tasks`) — recommended
 *      when each task description is composed by the orchestrator itself.
 *   2. Use a generation script via `execute` to populate the run directory
 *      directly — required for source-embedded content (chunks of an existing
 *      file) and large fan-outs (more than ~100 tasks).
 */
export const SWARM_WITH_EXECUTE_PROMPT = context`
  ### Setting up a run

  You have two equally valid ways to build a run directory.

  **Helper tools (recommended for LLM-composed tasks)**:

  1. \`swarm_init\` → returns the new \`runDir\`.
  2. \`swarm_add_tasks({ runDir, tasks: [...] })\` → writes \`tasks/<id>.txt\`
     and appends manifest rows. Batch up to ${MAX_ADD_TASKS_BATCH} tasks per
     call.
  3. \`swarm({ runDir })\` → dispatches and runs.
  4. \`swarm_get_results({ runDir })\` → read all results back.

  Use this path when you are composing each task's prompt yourself and there
  are at most a few dozen tasks.

  **Generation script via \`execute\` (use for source-embedded or large runs)**:

  When the task content is drawn from existing data (log chunks, file slices,
  document excerpts) you should write a script via \`execute\` that creates
  the run directory layout directly. This avoids two things: (a) re-encoding
  large content through the LLM token stream, where small drift can corrupt
  the data, and (b) the per-tool-call overhead of doing many add_tasks calls.

  Script outline:

  \`\`\`bash
  RUN=swarm_runs/my-run
  mkdir -p "$RUN/tasks"
  : > "$RUN/manifest.jsonl"
  for i in 0001 0002 0003 ...; do
    write the chunk text into "$RUN/tasks/$i.txt"
    append {"id":"$i","descriptionPath":"tasks/$i.txt"} to "$RUN/manifest.jsonl"
  done
  \`\`\`

  Then call \`swarm({ runDir: "swarm_runs/my-run" })\`. The executor reads the
  manifest, validates it, dispatches the tasks, and writes \`results/<id>.json\`
  for each one. The file layout is part of the contract — your script can
  rely on it.

  ### Aggregation

  For small result sets (up to a few hundred), call \`swarm_get_results\`
  directly. For very large result sets, use \`execute\` to read the
  \`results/*.json\` files and aggregate via your scripting language of
  choice. Both work; pick whichever fits the size of the data.
`;

/**
 * Extra guidance shown when the backend has no `execute` tool.
 *
 * On state/store backends or any other deployment without a sandboxed
 * runtime, the orchestrator must use the helper tools end to end. We document
 * the practical size ceiling so the orchestrator picks workloads that fit.
 */
export const SWARM_WITHOUT_EXECUTE_PROMPT = context`
  ### Setting up a run

  Without an \`execute\` tool you must build the run via the helper tools:

  1. \`swarm_init\` → returns the new \`runDir\`.
  2. \`swarm_add_tasks({ runDir, tasks: [...] })\` → batched. Up to
     ${MAX_ADD_TASKS_BATCH} tasks per call. You may call it multiple times to
     build a larger run.
  3. \`swarm({ runDir })\` → dispatches and runs.
  4. \`swarm_get_results({ runDir })\` → reads results back.

  ### Practical size limits

  Without \`execute\`, every task description is composed in your context, and
  every result is read back into your context. Plan accordingly:

  - **Tasks per run**: roughly up to 100 is comfortable; beyond that the
    setup and aggregation steps start to consume meaningful context.
  - **Per-task content**: keep each prompt small enough that 50–100 of them
    fit in one tool-call argument.
  - **Result aggregation**: use \`swarm_get_results\` with \`offset\` /
    \`limit\` for pagination if the full result set is too large to read at
    once. Walk the pages until \`hasMore\` is false.

  If your workload is genuinely larger than this, consider whether it should
  run on a backend that includes \`execute\` instead.
`;

// ---------------------------------------------------------------------------
// Tool name registry
// ---------------------------------------------------------------------------

/**
 * All tool names registered by the swarm middleware. Used by createDeepAgent
 * to detect collisions with user-supplied tools at construction time.
 */
export const SWARM_TOOL_NAMES = [
  "swarm",
  "swarm_init",
  "swarm_add_tasks",
  "swarm_get_results",
] as const;

// ---------------------------------------------------------------------------
// Shared option types
// ---------------------------------------------------------------------------

interface CreateBackendBoundToolOptions {
  backend: AnyBackendProtocol | BackendFactory;
}

interface CreateSwarmRunToolOptions extends CreateBackendBoundToolOptions {
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;
}

export interface SwarmMiddlewareOptions {
  /** Map of subagent name → compiled agent graph. */
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;
  /** Backend (or factory) used for all I/O. */
  backend: AnyBackendProtocol | BackendFactory;
}

// Helper for stable JSON tool responses.
function jsonResponse(payload: unknown): string {
  return JSON.stringify(payload);
}

function errorResponse(message: string): string {
  return JSON.stringify({ error: message });
}

// ---------------------------------------------------------------------------
// swarm_init
// ---------------------------------------------------------------------------

export function createSwarmInitTool(options: CreateBackendBoundToolOptions) {
  const { backend } = options;

  return tool(
    async (input, runtime: ToolRuntime) => {
      const resolvedBackend = await resolveBackend(backend, runtime);
      const name = input.name ?? generateRunName();
      const runDir = runDirFor(name);

      // Collision detection: an existing manifest means the run already
      // exists. We use readManifest rather than ls so the check is uniform
      // across backends regardless of their directory semantics.
      try {
        await readManifest(resolvedBackend, runDir);
        return errorResponse(
          `run '${name}' already exists at '${runDir}'. Choose a different name or call swarm with the existing runDir to resume it.`,
        );
      } catch (err) {
        if (!isManifestNotFoundError(err)) {
          // Manifest exists but is corrupted — surface that as a collision
          // so the orchestrator doesn't accidentally clobber it.
          if (isManifestParseError(err)) {
            return errorResponse(
              `run '${name}' already exists but its manifest is invalid: ${err.message}`,
            );
          }
          return errorResponse(
            `failed to check for existing run '${name}': ${(err as Error).message}`,
          );
        }
      }

      try {
        await initializeManifest(resolvedBackend, runDir);
      } catch (err: any) {
        return errorResponse(err?.message ?? "failed to initialize run");
      }

      return jsonResponse({ runDir });
    },
    {
      name: "swarm_init",
      description: `Create a new swarm run directory and an empty manifest.

Returns \`{ runDir }\` — pass this to \`swarm_add_tasks\` and \`swarm\`. If
\`name\` is omitted a random suffix is generated. Errors if a run with that
name already exists.`,
      schema: SwarmInitInputSchema,
    },
  );
}

function generateRunName(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

// ---------------------------------------------------------------------------
// swarm_add_tasks
// ---------------------------------------------------------------------------

export function createSwarmAddTasksTool(
  options: CreateBackendBoundToolOptions,
) {
  const { backend } = options;

  return tool(
    async (input, runtime: ToolRuntime) => {
      const resolvedBackend = await resolveBackend(backend, runtime);
      const { runDir, tasks } = input;

      // 1. Run must already exist; this also surfaces parse errors early.
      let existing: ManifestEntry[];
      try {
        existing = await readManifest(resolvedBackend, runDir);
      } catch (err) {
        if (isManifestNotFoundError(err)) {
          return errorResponse(
            `run '${runDir}' is not initialized. Call swarm_init first.`,
          );
        }
        return errorResponse((err as Error).message);
      }

      // 2. Reject duplicate ids inside the batch.
      const batchIds = new Set<string>();
      for (const task of tasks) {
        if (batchIds.has(task.id)) {
          return errorResponse(
            `duplicate id '${task.id}' in batch — every task must have a unique id`,
          );
        }
        batchIds.add(task.id);
      }

      // 3. Reject ids that already exist in the manifest.
      const existingIds = new Set(existing.map((e) => e.id));
      for (const task of tasks) {
        if (existingIds.has(task.id)) {
          return errorResponse(
            `id '${task.id}' already exists in run '${runDir}'`,
          );
        }
      }

      // 4. Write task files first. If any write fails, abort BEFORE
      // touching the manifest, so the run directory can never reference a
      // missing task file.
      const writtenIds: string[] = [];
      for (const task of tasks) {
        const path = taskPath(runDir, task.id);
        const writeResult = await resolvedBackend.write(path, task.content);
        if (writeResult.error) {
          return errorResponse(
            `failed to write task file for '${task.id}' at '${path}': ${writeResult.error}. ` +
              `${writtenIds.length} task files were written before this failure but the manifest was not updated; you can safely retry the call.`,
          );
        }
        writtenIds.push(task.id);
      }

      // 5. Append manifest entries last.
      const newEntries: ManifestEntry[] = tasks.map((task) => ({
        id: task.id,
        descriptionPath: relativeTaskPath(task.id),
        ...(task.subagentType ? { subagentType: task.subagentType } : {}),
      }));
      try {
        await appendManifest(resolvedBackend, runDir, newEntries);
      } catch (err: any) {
        return errorResponse(
          `task files were written but the manifest update failed: ${err?.message ?? err}. ` +
            `Retry the call to recover; task file writes are idempotent.`,
        );
      }

      return jsonResponse({
        runDir,
        added: tasks.length,
        ids: tasks.map((t) => t.id),
      });
    },
    {
      name: "swarm_add_tasks",
      description: `Append a batch of tasks to a swarm run.

Each task is written to \`<runDir>/tasks/<id>.txt\` (plain text — no escaping)
and added to the manifest. Up to ${MAX_ADD_TASKS_BATCH} tasks per call; call
multiple times for larger runs. Ids must be unique within the batch and
across the existing manifest.`,
      schema: SwarmAddTasksInputSchema,
    },
  );
}

// ---------------------------------------------------------------------------
// swarm (executor tool)
// ---------------------------------------------------------------------------

export function createSwarmTool(options: CreateSwarmRunToolOptions) {
  const { subagentGraphs, backend } = options;

  return tool(
    async (input, runtime: ToolRuntime) => {
      const resolvedBackend = await resolveBackend(backend, runtime);
      const parentState = getCurrentTaskInput<Record<string, unknown>>();

      try {
        const summary = await executeSwarm(input.runDir, {
          subagentGraphs,
          backend: resolvedBackend,
          parentState,
          config: runtime,
          concurrency: input.concurrency,
          maxRetries: input.maxRetries,
          retryFailed: input.retryFailed,
        });
        return jsonResponse(summary);
      } catch (err) {
        if (isManifestNotFoundError(err)) {
          return errorResponse(
            `run does not exist: '${input.runDir}'. Call swarm_init first.`,
          );
        }
        if (isManifestParseError(err)) {
          return errorResponse((err as Error).message);
        }
        return errorResponse((err as Error)?.message ?? "swarm execution failed");
      }
    },
    {
      name: "swarm",
      description: `Run all pending tasks in a swarm run directory.

Reads \`<runDir>/manifest.jsonl\`, dispatches every pending task to its
subagent (in parallel, bounded by \`concurrency\`), retries each task up to
\`maxRetries\` times, and writes a \`results/<id>.json\` file per task.

Re-running on the same runDir is safe: completed tasks are skipped, missing
tasks are dispatched, and failed tasks are left alone unless \`retryFailed\`
is true. To start fresh, create a new run via \`swarm_init\`.

Available subagent types: ${Object.keys(subagentGraphs).join(", ")}`,
      schema: SwarmInputSchema,
    },
  );
}

// ---------------------------------------------------------------------------
// swarm_get_results
// ---------------------------------------------------------------------------

const TRUNCATION_TEMPLATE = (path: string) =>
  `\n\n[...truncated, read ${path} for full content]`;

export function createSwarmGetResultsTool(
  options: CreateBackendBoundToolOptions,
) {
  const { backend } = options;

  return tool(
    async (input, runtime: ToolRuntime) => {
      const resolvedBackend = await resolveBackend(backend, runtime);
      const {
        runDir,
        offset = 0,
        limit = DEFAULT_GET_RESULTS_LIMIT,
        ids,
        statusFilter = "all",
      } = input;

      let manifest: ManifestEntry[];
      try {
        manifest = await readManifest(resolvedBackend, runDir);
      } catch (err) {
        if (isManifestNotFoundError(err)) {
          return errorResponse(`run does not exist: '${runDir}'`);
        }
        return errorResponse((err as Error).message);
      }

      // Determine which manifest entries we care about.
      let targets: ManifestEntry[];
      const missingIds: string[] = [];
      if (ids && ids.length > 0) {
        const requested = new Set(ids);
        const knownIds = new Set(manifest.map((e) => e.id));
        for (const id of ids) {
          if (!knownIds.has(id)) missingIds.push(id);
        }
        targets = manifest.filter((e) => requested.has(e.id));
      } else {
        targets = manifest;
      }

      const resultIndex = await listResults(resolvedBackend, runDir);

      // Build the full filtered list, then paginate.
      const all: GetResultsEntry[] = [];
      for (const entry of targets) {
        const stored = resultIndex.get(entry.id);
        if (stored == null) {
          if (matchesStatusFilter("pending", statusFilter)) {
            all.push({
              id: entry.id,
              status: "pending",
              ...(entry.subagentType
                ? { subagentType: entry.subagentType }
                : {}),
            });
          }
          continue;
        }

        if (stored === "corrupt") {
          if (matchesStatusFilter("failed", statusFilter)) {
            const synthetic: TaskResult = {
              id: entry.id,
              status: "failed",
              subagentType: entry.subagentType ?? "general-purpose",
              attempts: 1,
              startedAt: "1970-01-01T00:00:00.000Z",
              finishedAt: "1970-01-01T00:00:00.000Z",
              error: "result file unparseable",
            };
            all.push(synthetic);
          }
          continue;
        }

        if (matchesStatusFilter(stored.status, statusFilter)) {
          all.push(stored);
        }
      }

      const total = all.length;
      const page = all
        .slice(offset, offset + limit)
        .map((entry) => truncateLargeResults(entry, runDir));

      const response: SwarmGetResultsResponse = {
        results: page,
        total,
        offset,
        pageSize: page.length,
        hasMore: offset + limit < total,
        missingIds,
      };
      return jsonResponse(response);
    },
    {
      name: "swarm_get_results",
      description: `Read per-task results from a swarm run.

Returns a structured response with \`results\`, \`total\`, \`offset\`,
\`pageSize\`, \`hasMore\`, and \`missingIds\`. Each entry is either a full
TaskResult or, for tasks with no result file yet, a placeholder
\`{ id, status: "pending" }\`.

Pagination: walk the pages until \`hasMore\` is false. \`pageSize\` may be
smaller than \`limit\` when a status filter hides some entries — always check
\`hasMore\`, not the array length, to decide whether to keep paging.

Result content is truncated to ${MAX_RESULT_INLINE_SIZE} bytes per entry to
keep responses below the context window. The full content is always available
on disk at \`<runDir>/results/<id>.json\`. Default page size:
${DEFAULT_GET_RESULTS_LIMIT}, max: ${MAX_GET_RESULTS_LIMIT}.`,
      schema: SwarmGetResultsInputSchema,
    },
  );
}

function matchesStatusFilter(
  status: "completed" | "failed" | "pending",
  filter: "completed" | "failed" | "pending" | "all",
): boolean {
  return filter === "all" || filter === status;
}

function truncateLargeResults(
  entry: GetResultsEntry,
  runDir: string,
): GetResultsEntry {
  if (entry.status !== "completed") return entry;
  if (entry.result.length <= MAX_RESULT_INLINE_SIZE) return entry;
  const path = resultPath(runDir, entry.id);
  return {
    ...entry,
    result:
      entry.result.slice(0, MAX_RESULT_INLINE_SIZE) + TRUNCATION_TEMPLATE(path),
  };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create the swarm middleware. Binds the four tools and injects the
 * appropriate system prompt based on whether the backend supports `execute`.
 */
export function createSwarmMiddleware(
  options: SwarmMiddlewareOptions,
): AgentMiddleware {
  const { subagentGraphs, backend } = options;

  const initTool = createSwarmInitTool({ backend });
  const addTasksTool = createSwarmAddTasksTool({ backend });
  const swarmTool = createSwarmTool({ subagentGraphs, backend });
  const getResultsTool = createSwarmGetResultsTool({ backend });

  return createMiddleware({
    name: "swarmMiddleware",
    tools: [initTool, addTasksTool, swarmTool, getResultsTool],
    wrapModelCall: async (request, handler) => {
      const resolvedBackend = await resolveBackend(backend, {
        ...request.runtime,
        state: request.state,
      });
      const supportsExecution = isSandboxBackend(resolvedBackend);
      const swarmPrompt = supportsExecution
        ? `${SWARM_BASE_PROMPT}\n\n${SWARM_WITH_EXECUTE_PROMPT}`
        : `${SWARM_BASE_PROMPT}\n\n${SWARM_WITHOUT_EXECUTE_PROMPT}`;

      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(
          new SystemMessage({ content: swarmPrompt }),
        ),
      });
    },
  });
}

