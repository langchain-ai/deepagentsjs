import {
  Command,
  ReducedValue,
  StateSchema,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import {
  Client,
  type Interrupt,
  type Run,
  type Thread,
} from "@langchain/langgraph-sdk";
import {
  createMiddleware,
  tool,
  ToolMessage,
  SystemMessage,
  type BuiltInState,
  type ToolRuntime,
} from "langchain";
import {
  addNotificationMetadata,
  AIMessage,
  BaseMessage,
  coerceMessageLikeToMessage,
  getNotificationMetadata,
  HumanMessage,
  ToolMessage as CoreToolMessage,
  type ContentBlock,
} from "@langchain/core/messages";
import { getCurrentRunTree } from "langsmith/traceable";
import { z } from "zod/v4";
import type { AnySubAgent } from "../types.js";
import { NUM_CHARS_PER_TOKEN } from "./fs.js";
import { stripInFlightAIMessage } from "./subagents.js";
import { getEffectiveMessages } from "./summarization.js";

/**
 * Specification for an async subagent running on a remote [Agent Protocol](https://github.com/langchain-ai/agent-protocol)
 * server.
 *
 * Async subagents connect to any Agent Protocol-compliant server via the
 * LangGraph SDK. They run as background tasks that the main agent can
 * monitor and update.
 *
 * Compatible with LangGraph Platform (managed) and self-hosted servers.
 * Authentication for LangGraph Platform is handled automatically by the SDK
 * via environment variables (`LANGGRAPH_API_KEY`, `LANGSMITH_API_KEY`, or
 * `LANGCHAIN_API_KEY`). For self-hosted servers, pass custom auth via `headers`.
 *
 * Subagents on this deployment (no `url`) nest under the parent's trace when tracing is on.
 * Each task's thread has `parent_thread_id` metadata naming the parent's thread, so
 * an app can list a parent's subagent threads with the LangGraph SDK:
 * `client.threads.search({ metadata: { parent_thread_id } })`.
 */
// TODO(2027-01-31): revisit the `@experimental` tags on async subagent notifications, `notifyParent`, `updateStrategy`, fork mode and `"waiting"`.
export interface AsyncSubAgent {
  /** Unique identifier for the async subagent. */
  name: string;

  /** What this subagent does. The main agent uses this to decide when to delegate. */
  description: string;

  /** The graph name or assistant ID on the Agent Protocol server. */
  graphId: string;

  /**
   * URL of the Agent Protocol server. Omit for a subagent on the same Agent Server
   * deployment, which gives running graphs its address; elsewhere, defaults to the
   * LangGraph SDK's default endpoint.
   */
  url?: string;

  /** Additional headers to include in requests to the server (e.g. for custom auth). */
  headers?: Record<string, string>;

  /** URL the Agent Server calls whenever a run of this subagent finishes. */
  webhook?: string;

  /**
   * Whether this subagent may wake this agent when it finishes while this agent is idle. Defaults to `true`.
   *
   * Set it to `false` when the application delivers results itself, for example
   * through `webhook`. This agent still sees the subagent's updates while it runs.
   *
   * @experimental `notifyParent` may change along with how subagents wake their parent.
   */
  notifyParent?: boolean;

  /**
   * How `update_async_task` sends a follow-up while a run is active. Defaults to `"interrupt"`.
   *
   * - `"interrupt"`: stop the current run and start the follow-up.
   * - `"enqueue"`: queue the follow-up behind the current run. The task is `pending`
   *   until the follow-up starts. If the current run stops to ask its user for
   *   approval or input, the follow-up still starts, and that request is dropped.
   *
   * @experimental `updateStrategy` may change along with how queued follow-ups are tracked.
   */
  updateStrategy?: UpdateStrategy;

  /**
   * What the subagent starts with. Defaults to `"isolated"`.
   *
   * - `"isolated"`: only the delegated task description.
   * - `"fork"`: a snapshot of the parent's conversation at launch, followed by
   *   the task description, for background work.
   *
   * Fork mode copies conversation history, not the parent's model, prompt, tools
   * or middleware; match them on the remote agent for prompt-cache reuse.
   *
   * Media the parent offloaded with `offloadBinaryContent` is forked as references:
   * the subagent must be a deep agent, and shares the parent's backend to see it.
   *
   * @experimental `mode: "fork"` may change in a future release.
   */
  mode?: "isolated" | "fork";
}

/** How a follow-up runs while the subagent is busy, as {@link AsyncSubAgent.updateStrategy}. */
export type UpdateStrategy = "interrupt" | "enqueue";

/**
 * Possible statuses for an async subagent task.
 *
 * Statuses set by the middleware tools: `"running"`, `"success"`, `"error"`, `"cancelled"`.
 * Statuses that may be returned by the remote server: `"pending"`, `"timeout"`, `"interrupted"`.
 *
 * `"waiting"` means the subagent paused for its user (an approval or a
 * question), who answers it on the subagent's own thread.
 *
 * `"pending"` means the latest run hasn't started yet. After a queued follow-up,
 * an earlier run may still be working.
 *
 * @experimental `"waiting"` is experimental and subject to change.
 */
export type AsyncTaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "success"
  | "error"
  | "cancelled"
  | "timeout"
  | "interrupted";

/**
 * A tracked async subagent task persisted in agent state.
 *
 * Each task maps to a single thread + run on a remote Agent Protocol server.
 * The `taskId` is the same as `threadId`, so it can be used to look up
 * the thread directly via the SDK.
 */
export interface AsyncTask {
  /** Unique identifier for the task (same as thread id). */
  taskId: string;

  /** Name of the async subagent type that is running. */
  agentName: string;

  /** Thread ID on the remote server. */
  threadId: string;

  /** Run ID of the newest run this task knows of on its thread. A queued follow-up's run may not have started yet. */
  runId: string;

  /**
   * Earlier runs of this task, oldest first, from before a queued follow-up.
   *
   * Their notifications don't complete the task, and cancelling the task also
   * cancels any that are still active. Set only with `updateStrategy: "enqueue"`.
   */
  supersededRunIds?: string[];

  /** Current task status. */
  status: AsyncTaskStatus;

  /** ISO timestamp of when the task was launched. */
  createdAt: string;

  /** The prompt/description passed to the subagent when the task was launched. */
  description?: string;

  /** ISO timestamp of the most recent task update — set when the task status changes or a follow-up message is sent via the update tool. */
  updatedAt?: string;

  /** ISO timestamp of the most recent status poll via the check tool. */
  checkedAt?: string;
}

/**
 * Shape of the async subagent state channel.
 *
 * Used with {@link ToolRuntime} so tools get typed access to `asyncTasks`.
 *
 * Declared as a `type` (not `interface`) so `ToolRuntime<AsyncTaskState>` narrows
 * `runtime.state` correctly (see `@langchain/core` `ToolRuntime` conditional).
 */
type AsyncTaskState = Partial<Pick<BuiltInState, "messages">> & {
  /** All tracked async subagent tasks, keyed by task ID. */
  asyncTasks?: Record<string, AsyncTask>;
};

function toolCallIdFromRuntime(runtime: ToolRuntime<AsyncTaskState>): string {
  return runtime.toolCall?.id ?? runtime.toolCallId ?? "";
}

/**
 * Result of checking an async subagent's run status.
 *
 * Returned by `buildCheckResult` and used by `buildCheckTool`
 * to construct the `Command` update.
 */
interface CheckResult {
  /** Current status of the run. */
  status: AsyncTaskStatus;

  /** The thread ID on the remote server. */
  threadId: string;

  /** The subagent's answer as standard content blocks, if the run succeeded. */
  result?: ContentBlock.Standard[];

  /** Error description, if the run errored. */
  error?: string;

  /** What the subagent asked (`id` and `value` per interrupt), if it's waiting. */
  interrupts?: Array<{ id: string; value: unknown }>;

  /** Guidance for the model about a waiting subagent. */
  note?: string;
}

/**
 * Zod schema for {@link AsyncTask}.
 *
 * Used by the {@link ReducedValue} in the state schema so that LangGraph
 * can validate and serialize task records stored in `asyncTasks`.
 */
const AsyncTaskSchema = z.object({
  taskId: z.string(),
  agentName: z.string(),
  threadId: z.string(),
  runId: z.string(),
  supersededRunIds: z.array(z.string()).optional(),
  status: z.string(),
  createdAt: z.string(),
  description: z.string().optional(),
  updatedAt: z.string().optional(),
  checkedAt: z.string().optional(),
});

/**
 * State schema for the async subagent middleware.
 *
 * Declares `asyncTasks` as a reduced state channel so that individual
 * tool updates (launch, check, update, cancel, list) merge into the existing
 * tasks dict rather than replacing it wholesale.
 */
const AsyncTaskStateSchema = new StateSchema({
  asyncTasks: new ReducedValue(
    z.record(z.string(), AsyncTaskSchema).default(() => ({})),
    {
      inputSchema: z.record(z.string(), AsyncTaskSchema).optional(),
      reducer: asyncTasksReducer,
    },
  ),
});

/**
 * Reducer for the `asyncTasks` state channel.
 *
 * Merges task updates into the existing tasks dict using shallow spread.
 * This allows individual tools to update a single task without overwriting
 * the full map — only the keys present in `update` are replaced.
 *
 * @param existing - The current tasks dict from state (may be undefined on first write).
 * @param update - New or updated task entries to merge in.
 * @returns Merged tasks dict.
 */
export function asyncTasksReducer(
  existing?: Record<string, AsyncTask>,
  update?: Record<string, AsyncTask>,
): Record<string, AsyncTask> {
  return { ...(existing || {}), ...(update || {}) };
}

/**
 * Description template for the `start_async_task` tool.
 *
 * The `{available_agents}` placeholder is replaced at middleware creation
 * time with a formatted list of configured async subagent names and descriptions.
 */
const ASYNC_TASK_TOOL_DESCRIPTION = `Launch an async subagent on a remote server. The subagent runs in the background and returns a task ID immediately.

Available async agent types:
{available_agents}

## Usage notes:
1. This tool launches a background task and returns immediately with a task ID. Report the task ID to the user and stop — do NOT immediately check status.
2. You'll usually be told when a task finishes, fails or needs input, so don't check just to see if it's done; use \`check_async_task\` when the user asks or a notification says to.
3. Use \`update_async_task\` to send new instructions to a running task.
4. Multiple async subagents can run concurrently — launch several and let them run in the background.
5. The subagent runs on a remote server, so it has its own tools and capabilities.
6. A task with status \`waiting\` is waiting for a human (an approval or an answer). The user answers it directly; you can't answer or approve it for them. Keep working, and tell the user it's waiting if they ask.`;

/**
 * Names of the tools added by the async subagent middleware.
 *
 * Exported so `agent.ts` can include them in `BUILTIN_TOOL_NAMES` and
 * surface a `ConfigurationError` if a user-provided tool collides.
 */
export const ASYNC_TASK_TOOL_NAMES = [
  "start_async_task",
  "check_async_task",
  "update_async_task",
  "cancel_async_task",
  "list_async_tasks",
] as const;

/** Task statuses that never change, so live-status fetches can be skipped; `waiting` can still resume. */
export const TERMINAL_STATUSES = new Set<AsyncTaskStatus>([
  "cancelled",
  "success",
  "error",
  "timeout",
  "interrupted",
]);

/**
 * Look up a tracked task from state by its `taskId`.
 *
 * @param taskId - The task ID to look up (will be trimmed).
 * @param state - The current agent state containing `asyncTasks`.
 * @returns The tracked task on success, or an error string.
 */
function resolveTrackedTask(
  taskId: string,
  state: AsyncTaskState,
): AsyncTask | string {
  const tasks = state.asyncTasks ?? {};
  const tracked = tasks[taskId.trim()];
  if (!tracked) {
    return `No tracked task found for taskId: '${taskId}'`;
  }
  return tracked;
}

/** Guidance for a task whose latest run hasn't started. */
const PENDING_NOTE =
  "The latest run hasn't started yet. If it is a queued follow-up, an earlier run may still be working.";

/** Task status implied by the thread when the tracked run finished but the thread moved on. */
const THREAD_TO_TASK_STATUS: Record<string, AsyncTaskStatus> = {
  interrupted: "waiting",
  busy: "running",
  error: "error",
};

/**
 * Return a task's status from its latest run, reading the thread to spot pauses.
 *
 * A run that hits `interrupt()` ends as `success`; only its thread shows the pause.
 * A run cancelled on the server ends `interrupted`, which a task reports as `cancelled`.
 */
function taskStatus(run: Run, thread: Thread | null): AsyncTaskStatus {
  if (run.status === "interrupted") return "cancelled";
  if (run.status !== "success" || thread === null) {
    return run.status as AsyncTaskStatus;
  }
  return THREAD_TO_TASK_STATUS[thread.status] ?? "success";
}

/** Whether a newer run exists than the tracked one, e.g. after a resume from another client. */
function needsLatestRun(run: Run, thread: Thread | null): boolean {
  return (
    run.status === "success" &&
    thread !== null &&
    (thread.status === "busy" || thread.status === "error")
  );
}

/**
 * Fetch a task's latest run and, when that run finished, its thread (else `null`).
 *
 * Throws if the thread can't be read, since a paused run also ends as `success`.
 * A run replaced by another client's run hands over to the newest one, except for
 * a task the parent cancelled.
 */
async function observeTaskRun(
  client: Client,
  task: AsyncTask,
  signal?: AbortSignal,
): Promise<[Run, Thread | null]> {
  let run = await client.runs.get(task.threadId, task.runId, { signal });
  if (run.status === "interrupted" && task.status !== "cancelled") {
    const [latest] = await client.runs.list(task.threadId, {
      limit: 1,
      signal,
    });
    run = latest ?? run;
  }
  if (run.status !== "success") return [run, null];
  const thread = await client.threads.get(task.threadId, { signal });
  if (needsLatestRun(run, thread)) {
    const [latest] = await client.runs.list(task.threadId, {
      limit: 1,
      signal,
    });
    run = latest ?? run;
  }
  return [run, thread];
}

/** Flatten a thread's pending interrupts, including ones raised inside subgraphs. */
function pendingInterrupts(thread: Thread | null): Interrupt[] {
  if (!thread?.interrupts) return [];
  return Object.values(thread.interrupts).flat();
}

const WAITING_NOTE =
  "The subagent is waiting for a human. The user answers it directly; you can't answer or approve it. " +
  "Keep working; check again later for its result.";

/** The thread's messages, if its values hold any. */
function threadMessages(values: unknown): unknown[] {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return [];
  }
  const messages = (values as Record<string, unknown>).messages;
  return Array.isArray(messages) ? messages : [];
}

/** A thread message's content as text, whatever shape the server sent it in. */
function messageText(message: unknown): string {
  if (BaseMessage.isInstance(message)) return message.text;
  const content =
    typeof message === "object" && message !== null && "content" in message
      ? (message as Record<string, unknown>).content
      : message;
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Build a check result from a task's latest run and its thread.
 *
 * @param run - The task's latest run.
 * @param threadId - The task's thread ID.
 * @param thread - The task's thread, when its run finished.
 */
function buildCheckResult(
  run: Run,
  threadId: string,
  thread: Thread | null,
): CheckResult {
  const status = taskStatus(run, thread);
  const checkResult: CheckResult = { status, threadId };

  if (status === "pending") {
    checkResult.note = PENDING_NOTE;
  } else if (status === "success") {
    checkResult.result = finalContent(thread?.values);
  } else if (status === "error") {
    checkResult.error = "The async subagent encountered an error.";
  } else if (status === "waiting") {
    checkResult.interrupts = pendingInterrupts(thread).map((item) => ({
      id: item.id ?? "",
      value: item.value,
    }));
    checkResult.note = WAITING_NOTE;
  }

  return checkResult;
}

/**
 * A check result as tool output: JSON, with a text-only answer's text in `result`.
 *
 * An answer with media follows the JSON as its own blocks, in order. Reasoning and
 * tool-call blocks are dropped; the text isn't cut.
 */
function checkOutput(result: CheckResult): string | ContentBlock[] {
  const blocks = result.result;
  if (!blocks) return JSON.stringify(result);
  const text = (block: ContentBlock.Standard) => String(block.text);
  if (!blocks.some((block) => MEDIA_BLOCK_TYPES.has(block.type))) {
    const answer = blocks.filter((block) => block.type === "text").map(text);
    return JSON.stringify({ ...result, result: answer.join("") });
  }
  const { result: _answer, ...status } = result;
  const answer: ContentBlock[] = blocks
    .filter(
      (block) => block.type === "text" || MEDIA_BLOCK_TYPES.has(block.type),
    )
    .map((block) =>
      block.type === "text" ? textBlock(text(block)) : { ...block },
    );
  return [textBlock(JSON.stringify(status)), ...answer];
}

/** Keep a task cancelled while paused as cancelled; its thread still shows the old pause. */
function keepCancelled(task: AsyncTask, result: CheckResult): CheckResult {
  if (task.status === "cancelled" && result.status === "waiting") {
    return { status: "cancelled", threadId: result.threadId };
  }
  return result;
}

/** `task` updated to what a check found. */
function observed(
  task: AsyncTask,
  status: AsyncTaskStatus,
  runId: string,
): AsyncTask {
  const now = new Date().toISOString();
  const changed = status !== task.status || runId !== task.runId;
  return {
    ...task,
    runId,
    status,
    updatedAt: changed ? now : task.updatedAt,
    checkedAt: now,
  };
}

/**
 * Filter tasks by cached status from agent state.
 *
 * Filtering uses the cached status, not live server status. Live statuses
 * are fetched after filtering by the calling tool.
 *
 * @param tasks - All tracked tasks from state.
 * @param statusFilter - If nullish or `'all'`, return all tasks.
 *   Otherwise return only tasks whose cached status matches.
 */
function filterTasks(
  tasks: Record<string, AsyncTask>,
  statusFilter?: string,
): AsyncTask[] {
  if (!statusFilter || statusFilter === "all") {
    return Object.values(tasks);
  }
  return Object.values(tasks).filter((task) => task.status === statusFilter);
}

/**
 * Fetch a task's current status and run ID.
 *
 * Returns the cached values for terminal tasks and on SDK errors.
 */
async function fetchLiveTaskStatus(
  clients: ClientCache,
  task: AsyncTask,
): Promise<[AsyncTaskStatus, string]> {
  if (TERMINAL_STATUSES.has(task.status)) {
    return [task.status, task.runId];
  }

  try {
    const [run, thread] = await observeTaskRun(
      clients.getClient(task.agentName),
      task,
    );
    return [taskStatus(run, thread), run.run_id];
  } catch {
    return [task.status, task.runId];
  }
}

/**
 * Format a single task as a display string for list output.
 */
function formatTaskEntry(task: AsyncTask, status: AsyncTaskStatus): string {
  return `- taskId: ${task.taskId} agent: ${task.agentName} status: ${status}`;
}

/**
 * Lazily-created, cached LangGraph SDK clients keyed by (url, headers).
 *
 * Agents that share the same URL and headers will reuse a single `Client`
 * instance, avoiding unnecessary connections.
 */
export class ClientCache {
  private agents: Record<string, AsyncSubAgent>;
  private clients = new Map<string, Client>();

  constructor(agents: Record<string, AsyncSubAgent>) {
    this.agents = agents;
  }

  /**
   * Build headers for a remote Agent Protocol server.
   *
   * Adds `x-auth-scheme: langsmith` by default unless already provided.
   * For self-hosted servers that don't require this header, it is typically
   * ignored. Override via the `headers` field on the AsyncSubAgent config.
   */
  private resolveHeaders(spec: AsyncSubAgent): Record<string, string> {
    const headers = { ...(spec.headers || {}) };
    if (!("x-auth-scheme" in headers)) {
      headers["x-auth-scheme"] = "langsmith";
    }
    return headers;
  }

  /**
   * Build a stable cache key from a spec's url and resolved headers.
   */
  private cacheKey(spec: AsyncSubAgent): string {
    const headers = this.resolveHeaders(spec);
    const headerStr = Object.entries(headers).sort().flat().join(":");
    return `${spec.url ?? ""}|${headerStr}`;
  }

  /**
   * Get or create a `Client` for the named agent.
   *
   * With `extraHeaders` (such as one launch's trace headers), returns a new, uncached client.
   */
  getClient(name: string, extraHeaders: Record<string, string> = {}): Client {
    const spec = this.agents[name];
    if (Object.keys(extraHeaders).length > 0) {
      return new Client({
        apiUrl: spec.url,
        defaultHeaders: { ...this.resolveHeaders(spec), ...extraHeaders },
      });
    }
    const key = this.cacheKey(spec);

    const existing = this.clients.get(key);
    if (existing) return existing;

    const headers = this.resolveHeaders(spec);
    const client = new Client({
      apiUrl: spec.url,
      defaultHeaders: headers,
    });
    this.clients.set(key, client);

    return client;
  }
}

/**
 * Baggage metadata key (JSON `true`) marking trace headers as a parent to nest under.
 *
 * Receivers that adopt the trace check for it, so keep the name stable.
 */
const NEST_UNDER_PARENT = "ls_nest_under_parent";

/**
 * Build LangSmith headers pointing at the current span, or `{}` when tracing is off.
 *
 * Only sent to subagents on this deployment (no `url`). The baggage carries the
 * project and `NEST_UNDER_PARENT`, not the caller's run metadata. Any `baggage`
 * in the spec's headers is kept.
 */
export function traceHeaders(spec: AsyncSubAgent): Record<string, string> {
  if (spec.url) return {};
  const runTree = getCurrentRunTree(true);
  // LangChain keeps an untraced placeholder run tree in context when tracing is off.
  if (!runTree?.tracingEnabled || !runTree.trace_id || !runTree.dotted_order) {
    return {};
  }
  const baggage = Object.entries(spec.headers ?? {})
    .filter(([key, value]) => key.toLowerCase() === "baggage" && value)
    .map(([, value]) => value);
  baggage.push(
    `langsmith-metadata=${encodeURIComponent(JSON.stringify({ [NEST_UNDER_PARENT]: true }))}`,
  );
  if (runTree.project_name) {
    baggage.push(
      `langsmith-project=${encodeURIComponent(runTree.project_name)}`,
    );
  }
  return {
    "langsmith-trace": runTree.dotted_order,
    baggage: baggage.join(","),
  };
}

/**
 * `configurable` key carrying the launching agent's reference to an async subagent's run.
 *
 * Apps read it directly, and Python deep agents use the same key, so keep the key and shape stable.
 */
const PARENT_KEY = "deepagents_parent";

/** What an async subagent's run knows about the agent that launched it. */
interface ParentReference {
  /** The parent's thread, where notifications for the parent go. */
  thread_id?: string;
  /** The parent's assistant, which handles runs queued on its thread. */
  assistant_id?: string;
}

/** Describe the running agent so the async subagent it launches can find it. */
function parentReference(
  config: LangGraphRunnableConfig | undefined,
): ParentReference {
  const reference: ParentReference = {};
  const configurable = (config?.configurable ?? {}) as Record<string, unknown>;
  const metadata = (config?.metadata ?? {}) as Record<string, unknown>;
  if (configurable.thread_id) {
    reference.thread_id = String(configurable.thread_id);
  }
  const assistantId = metadata.assistant_id || configurable.assistant_id;
  if (assistantId) reference.assistant_id = String(assistantId);
  return reference;
}

/**
 * The parent reference sent to `spec`'s runs.
 *
 * A subagent on another server (`url`) or with `notifyParent: false` gets only the
 * parent's thread: the assistant is for waking the parent, which it can't do.
 */
function referenceFor(
  spec: AsyncSubAgent,
  config: LangGraphRunnableConfig | undefined,
): ParentReference {
  const { thread_id, assistant_id } = parentReference(config);
  const wakesParent = !spec.url && spec.notifyParent !== false;
  return {
    ...(thread_id && { thread_id }),
    ...(wakesParent && assistant_id && { assistant_id }),
  };
}

/**
 * Metadata for a task's thread, so apps can find a parent's subagent threads with `threads.search`.
 *
 * It names the subagent as the parent knows it, and for subagents on this deployment
 * keeps the parent's assistant, so other runs on the thread (such as the user
 * answering the subagent) can still notify the parent.
 */
function threadMetadata(
  spec: AsyncSubAgent,
  config: LangGraphRunnableConfig | undefined,
): Record<string, string> {
  const reference = referenceFor(spec, config);
  const metadata: Record<string, string> = { subagent_name: spec.name };
  if (reference.thread_id) metadata.parent_thread_id = reference.thread_id;
  if (reference.assistant_id) {
    metadata.parent_assistant_id = reference.assistant_id;
  }
  return metadata;
}

const ASYNC_FORK_TASK_PREAMBLE =
  "[The messages above are prior conversation inherited from the parent agent. " +
  "You are the background subagent it has already invoked. Use the established " +
  "context to complete the task below, not to repeat the prior delegation. " +
  "You have your own tools and runtime; the parent's resources may not be available.]\n\n";

/** A message as portable input for another run, without parent-local eviction tags. */
function serializeForkMessage(message: BaseMessage): Record<string, unknown> {
  // Eviction tags point to parent-local files the child can't read.
  const { lc_evicted_to: _evicted, ...additionalKwargs } =
    message.additional_kwargs ?? {};
  const serialized: Record<string, unknown> = {
    type: message.type,
    content: message.content,
    additional_kwargs: additionalKwargs,
  };
  if (message.id) serialized.id = message.id;
  if (message.name) serialized.name = message.name;
  if (AIMessage.isInstance(message)) serialized.tool_calls = message.tool_calls;
  if (CoreToolMessage.isInstance(message)) {
    serialized.tool_call_id = message.tool_call_id;
    serialized.status = message.status;
  }
  return serialized;
}

/**
 * The task's input messages: the parent's effective conversation for forks, or only the task.
 *
 * A fork keeps references to the parent's offloaded media; a subagent sharing the
 * parent's backend loads them, and any other sees that the content is unavailable.
 */
function startTaskMessages(
  spec: AsyncSubAgent,
  state: Record<string, unknown>,
  description: string,
): Record<string, unknown>[] {
  if (spec.mode !== "fork") return [{ role: "user", content: description }];
  const history = stripInFlightAIMessage(
    (state.messages as BaseMessage[] | undefined) ?? [],
  );
  return [
    ...getEffectiveMessages(history, state),
    new HumanMessage({ content: ASYNC_FORK_TASK_PREAMBLE + description }),
  ].map(serializeForkMessage);
}

/** Describe a subagent's context inheritance without promising shared tools. */
function describeAsyncSubAgent(spec: AsyncSubAgent): string {
  const suffix =
    spec.mode === "fork"
      ? " (inherits your conversation at launch; uses its own system prompt and tools)"
      : "";
  return `- ${spec.name}: ${spec.description}${suffix}`;
}

/**
 * The `runs.create` options that link a run to this agent and set the subagent's webhook.
 *
 * A subagent on this deployment runs with this agent's context. The Agent Server
 * takes `context` or `configurable`, not both, so the parent reference then goes
 * through the thread's metadata.
 */
function runOptions(
  spec: AsyncSubAgent,
  runtime: { config?: LangGraphRunnableConfig; context?: unknown },
): {
  config?: { configurable: Record<string, unknown> };
  context?: Record<string, unknown>;
  webhook?: string;
} {
  const webhook = spec.webhook ? { webhook: spec.webhook } : {};
  const context = spec.url ? undefined : forwardedContext(runtime.context);
  if (context) return { ...webhook, context };
  const reference = referenceFor(spec, runtime.config);
  return Object.keys(reference).length > 0
    ? { ...webhook, config: { configurable: { [PARENT_KEY]: reference } } }
    : webhook;
}

/** A run context as JSON data for another run, without deepagents' parent reference. */
export function forwardedContext(
  context: unknown,
): Record<string, unknown> | undefined {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return undefined;
  }
  // A run started without a context sees its `configurable` as one, parent reference included.
  const entries = Object.entries(context).filter(([key]) => key !== PARENT_KEY);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The agent that launched this run's task, or `null` if no async subagent tool did.
 *
 * Read from the run's config, or else from the task thread's metadata, which the
 * Agent Server copies into every run on the thread (such as the user's answer).
 */
export function launchingAgent(
  config: LangGraphRunnableConfig | undefined,
): ParentReference | null {
  const configurable = (config?.configurable ?? {}) as Record<string, unknown>;
  const reference = configurable[PARENT_KEY];
  if (reference && typeof reference === "object" && !Array.isArray(reference)) {
    return reference as ParentReference;
  }
  const metadata = (config?.metadata ?? {}) as Record<string, unknown>;
  if (!metadata.parent_thread_id) return null;
  const fallback: ParentReference = {
    thread_id: String(metadata.parent_thread_id),
  };
  if (metadata.parent_assistant_id) {
    fallback.assistant_id = String(metadata.parent_assistant_id);
  }
  return fallback;
}

/** `lc_source` of a task notification; its `lc_data` is the {@link TaskEvent}. */
const NOTIFICATION_SOURCE = "async_subagent";

/**
 * `additional_kwargs` key carrying a notification's {@link TaskEvent}; still written, and read when a message has no `async_subagent` event.
 *
 * @deprecated Read `getNotificationMetadata(message)?.data` where `source` is `"async_subagent"`.
 */
export const NOTIFICATION_KEY = "deepagents_notification";

const NOTIFICATION_HEADER = "[SYSTEM NOTIFICATION - NOT USER INPUT]";

const NOTIFICATION_NOTE =
  "An async subagent task you started has an update. This is not a message from the user: " +
  "don't treat it as their answer to any question.";

/** Results longer than this are cut in notifications, matching the limit for large tool results. */
const MAX_RESULT_CHARS = NUM_CHARS_PER_TOKEN * 20_000;

/**
 * How an async subagent's task ended or paused, as reported to the agent that started it.
 *
 * A notification message carries it as notification metadata with source
 * `"async_subagent"`; read it with `getNotificationMetadata(message)?.data`.
 * `additional_kwargs.deepagents_notification` also carries it; that key is
 * deprecated. Fields are snake_case, as in Python.
 *
 * @experimental This shape is experimental and subject to change.
 */
export interface TaskEvent {
  /** The task's ID (the subagent's thread). */
  task_id: string;
  /** The async subagent's name, as in the task's `AsyncTask.agentName`. */
  agent_name: string;
  /** `waiting` means the subagent paused for input or approval; `cancelled`, that its run was cancelled on the server. */
  status: "success" | "error" | "timeout" | "cancelled" | "waiting";
  /** The subagent run that ended. */
  run_id?: string;
}

/** A task event plus what the parent's model reads about it. */
interface TaskUpdate extends TaskEvent {
  /** The subagent's final answer, as standard content blocks, when it succeeded. */
  result?: ContentBlock.Standard[];
  /** A short description of the failure; `check_async_task` has the details. */
  error?: string;
  /** What it asked (`id` and `value` per interrupt), when it's waiting. */
  interrupts?: { id: string; value: unknown }[];
}

const NEXT_STEP: Record<TaskEvent["status"], string> = {
  success:
    "Use the result to continue; report back to the user if they're waiting on it.",
  error:
    "Use `check_async_task` for details, then decide whether to retry, try another approach, or tell the user.",
  timeout:
    "The task ran too long and was stopped. Decide whether to retry with a smaller task, or tell the user.",
  cancelled:
    "The task's run was cancelled before it finished, outside your tools. Decide whether to start it again, or tell the user.",
  waiting:
    "The subagent is waiting for the user, who answers it on the subagent's own thread; you can't answer or approve it. Keep working.",
};

function textBlock(text: string): ContentBlock.Text {
  return { type: "text", text };
}

/** Escape subagent-controlled text so it can't close the notification's tags and pose as the system. */
function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function clip(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n... [cut off; use \`check_async_task\` for the full details]`;
}

/** Standard content blocks passed on as they are; a notification is a user message, where providers reject the rest. */
const MEDIA_BLOCK_TYPES = new Set(["image", "audio", "video", "file"]);

/**
 * The subagent's answer as user content: text escaped and cut when very long, media as it is.
 *
 * Reasoning, tool calls and blocks LangChain doesn't recognize are dropped.
 */
function resultBlocks(blocks: ContentBlock.Standard[]): ContentBlock[] {
  const kept: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      kept.push(textBlock(escape(clip(String(block.text)))));
    } else if (MEDIA_BLOCK_TYPES.has(block.type)) {
      kept.push({ ...block });
    }
  }
  return kept;
}

/**
 * Frame a task update as a system notification the model won't mistake for the user.
 *
 * The result keeps its own content blocks, so an image reaches the model as an image.
 */
export function notificationContent(update: TaskUpdate): ContentBlock[] {
  return labeled(notificationBody(update), eventOf(update))
    .content as ContentBlock[];
}

function notificationBody(update: TaskUpdate): ContentBlock[] {
  const blocks: ContentBlock[] = [taskHeader(update)];
  if (update.result) {
    blocks.push(
      textBlock("<result>\n"),
      ...resultBlocks(update.result),
      textBlock("\n</result>\n"),
    );
  }
  const details = Object.fromEntries(
    (["error", "interrupts"] as const)
      .filter((key) => update[key] !== undefined)
      .map((key) => [key, update[key]]),
  );
  if (Object.keys(details).length > 0) {
    blocks.push(
      textBlock(
        `<details>${escape(clip(JSON.stringify(details)))}</details>\n`,
      ),
    );
  }
  blocks.push(textBlock(`</task-notification>\n${NEXT_STEP[update.status]}`));
  return blocks;
}

/** `blocks` under the notification header, labeled with `event`. */
function labeled(blocks: ContentBlock[], event: TaskEvent): HumanMessage {
  const header = textBlock(`${NOTIFICATION_HEADER}\n${NOTIFICATION_NOTE}\n`);
  return addNotificationMetadata(
    new HumanMessage({ content: [header, ...blocks] }),
    { source: NOTIFICATION_SOURCE, data: { ...event } },
  );
}

function taskHeader(event: TaskEvent): ContentBlock.Text {
  return textBlock(
    `<task-notification>\n<task-id>${escape(event.task_id)}</task-id>\n<agent-name>${escape(event.agent_name)}</agent-name>\n` +
      `<status>${escape(event.status)}</status>\n`,
  );
}

/**
 * Reframe an earlier run's notification so the model doesn't think the queued follow-up finished.
 *
 * Only the closing next step changes; the earlier run's result and details stay.
 */
function supersededNotificationContent(
  message: BaseMessage,
  event: TaskEvent,
): ContentBlock[] {
  const content = message.content;
  const closing = Array.isArray(content) ? content.at(-1) : undefined;
  const body =
    closing?.type === "text" &&
    String(closing.text).startsWith("</task-notification>")
      ? (content as ContentBlock[]).slice(0, -1)
      : (labeled([taskHeader(event)], event).content as ContentBlock[]);
  return [
    ...body,
    textBlock(
      "</task-notification>\n" +
        "This update is from an earlier run of this task, before your latest follow-up. " +
        "It is not the result of the follow-up. Use `check_async_task` to get the current status of the task.",
    ),
  ];
}

/** Describe a failure without its message, which can carry internals into the parent's conversation. */
export function failureText(error: unknown): string {
  // `name`, not the class: LangChain wraps middleware errors but keeps the original's name.
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : typeof error;
  return `The subagent failed (${name}).`;
}

/** The ID of the run this config belongs to, when the Agent Server set it. */
export function currentRunId(
  config: LangGraphRunnableConfig | undefined,
): string | undefined {
  const metadata = (config?.metadata ?? {}) as Record<string, unknown>;
  const configurable = (config?.configurable ?? {}) as Record<string, unknown>;
  const runId = metadata.run_id ?? configurable.run_id;
  return runId ? String(runId) : undefined;
}

/** Build a task update; `details` are the status's `result`, `error` or `interrupts`. */
function taskUpdate(
  event: TaskEvent,
  details: Partial<TaskUpdate> = {},
): TaskUpdate {
  const update: TaskUpdate = {
    task_id: event.task_id,
    agent_name: event.agent_name,
    status: event.status,
    ...details,
  };
  if (event.run_id) update.run_id = event.run_id;
  return update;
}

/** Describe how this run's task ended. */
export function taskEvent(
  config: LangGraphRunnableConfig | undefined,
  agentName: string,
  status: "success" | "error" | "waiting",
  details: Partial<TaskUpdate> = {},
): TaskUpdate {
  const configurable = (config?.configurable ?? {}) as Record<string, unknown>;
  return taskUpdate(
    {
      task_id: String(configurable.thread_id ?? ""),
      agent_name: agentName,
      status,
      run_id: currentRunId(config),
    },
    details,
  );
}

/** The subagent's last message as standard content blocks, the task's result; it may hold images. */
export function finalContent(values: unknown): ContentBlock.Standard[] {
  const messages = threadMessages(values);
  if (messages.length === 0) {
    return [{ type: "text", text: "(completed with no output messages)" }];
  }
  const last = messages[messages.length - 1];
  try {
    return coerceMessageLikeToMessage(
      last as Parameters<typeof coerceMessageLikeToMessage>[0],
    ).contentBlocks;
  } catch {
    // Another Agent Protocol server may send a shape LangChain can't read; keep its text.
    return [{ type: "text", text: messageText(last) }];
  }
}

/** The task event a notification message carries, or `null` for any other message. */
function notificationEvent(message: BaseMessage | undefined): TaskEvent | null {
  if (message === undefined) return null;
  const metadata = getNotificationMetadata(message);
  const event =
    (metadata?.source === NOTIFICATION_SOURCE ? metadata.data : undefined) ??
    message.additional_kwargs?.[NOTIFICATION_KEY];
  return event && typeof event === "object" && !Array.isArray(event)
    ? (event as TaskEvent)
    : null;
}

/** The {@link TaskEvent} fields of a task update. */
function eventOf(update: TaskUpdate): TaskEvent {
  const event: TaskEvent = {
    task_id: update.task_id,
    agent_name: update.agent_name,
    status: update.status,
  };
  if (update.run_id) event.run_id = update.run_id;
  return event;
}

/** A task update as the message the parent's model sees, labeled with its {@link TaskEvent}. */
function notificationMessage(update: TaskUpdate): {
  role: "user";
  content: ContentBlock[];
  additional_kwargs: Record<string, unknown>;
} {
  const event = eventOf(update);
  const message = labeled(notificationBody(update), event);
  return {
    role: "user",
    content: message.content as ContentBlock[],
    additional_kwargs: {
      ...message.additional_kwargs,
      [NOTIFICATION_KEY]: event,
    },
  };
}

/** Parent thread statuses a notification run can start on: neither running nor waiting for a human. */
const DELIVERABLE_THREAD_STATUSES = new Set(["idle", "error"]);

/**
 * Start a notification run on the parent's thread only while it's idle (or its last run failed).
 *
 * A run on a thread waiting for a human would cancel that approval. Never throws.
 */
async function awakeParent(
  parentThreadId: string,
  assistantId: string,
  update: TaskUpdate,
  context?: Record<string, unknown>,
): Promise<void> {
  // The parent runs on this deployment, so use the address the Agent Server gave this run.
  const client = new Client();
  try {
    const thread = await client.threads.get(parentThreadId);
    if (!DELIVERABLE_THREAD_STATUSES.has(thread.status)) return;
    await client.runs.create(parentThreadId, assistantId, {
      input: { messages: [notificationMessage(update)] },
      multitaskStrategy: "reject",
      ...(context ? { context } : {}),
    });
  } catch {
    // Best effort: a parent that's gone, busy or unreachable finds out when it next checks its tasks.
  }
}

/**
 * Wake the parent if it's idle, with this run's context; otherwise it finds out
 * on its own. Never throws.
 */
export async function notifyParent(
  config: LangGraphRunnableConfig | undefined,
  update: TaskUpdate,
  context?: unknown,
): Promise<void> {
  const parent = launchingAgent(config);
  if (parent?.thread_id && parent.assistant_id) {
    await awakeParent(
      parent.thread_id,
      parent.assistant_id,
      update,
      forwardedContext(context),
    );
  }
}

/**
 * Extract the callback thread ID from the tool runtime.
 *
 * The thread ID is included in the subagent's input state so the subagent
 * can notify the parent when it completes (via
 * `CompletionCallbackMiddleware`).
 *
 * @returns Object with `callbackThreadId` if available. Empty object otherwise.
 */
export function extractCallbackContext(
  runtime: ToolRuntime<AsyncTaskState>,
): Record<string, string> {
  const configurable = runtime.config?.configurable as
    | Record<string, unknown>
    | undefined;
  const threadId = configurable?.thread_id;
  if (typeof threadId === "string" && threadId) {
    return { callbackThreadId: threadId };
  }
  return {};
}

/**
 * Build the `start_async_task` tool.
 *
 * Creates a thread on the remote server, starts a run, and returns a
 * `Command` that persists the new task in state.
 */
export function buildStartTool(
  agentMap: Record<string, AsyncSubAgent>,
  clients: ClientCache,
  toolDescription: string,
) {
  return tool(
    async (
      input,
      runtime: ToolRuntime<AsyncTaskState>,
    ): Promise<Command | string> => {
      if (!(input.agentName in agentMap)) {
        const allowed = Object.keys(agentMap)
          .map((k) => `\`${k}\``)
          .join(", ");
        return `Unknown async subagent type \`${input.agentName}\`. Available types: ${allowed}`;
      }

      const spec = agentMap[input.agentName];
      const callbackContext = extractCallbackContext(runtime);
      try {
        const client = clients.getClient(input.agentName);
        const thread = await client.threads.create({
          metadata: threadMetadata(spec, runtime.config),
        });
        const run = await clients
          .getClient(input.agentName, traceHeaders(spec))
          .runs.create(thread.thread_id, spec.graphId, {
            input: {
              messages: startTaskMessages(
                spec,
                runtime.state as Record<string, unknown>,
                input.description,
              ),
              ...callbackContext,
            },
            ...runOptions(spec, runtime),
          });

        const taskId = thread.thread_id;
        const task: AsyncTask = {
          taskId,
          agentName: input.agentName,
          threadId: taskId,
          runId: run.run_id,
          status: "running",
          createdAt: new Date().toISOString(),
          description: input.description,
        };

        return new Command({
          update: {
            messages: [
              new ToolMessage({
                content: `Launched async subagent. taskId: ${taskId}`,
                tool_call_id: toolCallIdFromRuntime(runtime),
              }),
            ],
            asyncTasks: { [taskId]: task },
          },
        });
      } catch (e) {
        return `Failed to launch async subagent '${input.agentName}': ${e}`;
      }
    },
    {
      name: "start_async_task",
      description: toolDescription,
      schema: z.object({
        description: z
          .string()
          .describe(
            "A detailed description of the task for the async subagent to perform.",
          ),
        agentName: z
          .string()
          .describe(
            "The type of async subagent to use. Must be one of the available types listed in the tool description.",
          ),
      }),
    },
  );
}

/**
 * Build the `check_async_task` tool.
 *
 * Fetches the current run status from the remote server and, if the run
 * succeeded, retrieves the thread state to extract the result.
 */
export function buildCheckTool(clients: ClientCache) {
  return tool(
    async (
      input,
      runtime: ToolRuntime<AsyncTaskState>,
    ): Promise<Command | string> => {
      const task = resolveTrackedTask(input.taskId, runtime.state);
      if (typeof task === "string") return task;

      let run: Run;
      let thread: Thread | null;
      try {
        [run, thread] = await observeTaskRun(
          clients.getClient(task.agentName),
          task,
        );
      } catch (e) {
        return `Failed to get run status: ${e}`;
      }

      const result = keepCancelled(
        task,
        buildCheckResult(run, task.threadId, thread),
      );
      const updatedTask = observed(task, result.status, run.run_id);

      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: checkOutput(result),
              tool_call_id: toolCallIdFromRuntime(runtime),
            }),
          ],
          asyncTasks: { [task.taskId]: updatedTask },
        },
      });
    },
    {
      name: "check_async_task",
      description:
        "Check the status of an async subagent task. Returns the current status and, if complete, the result. If the status is `waiting`, it also returns what the subagent is asking the user. Statuses shown earlier in the conversation are always stale, so call this to get the current status rather than reporting a status from a previous tool result.",
      schema: z.object({
        taskId: z
          .string()
          .describe(
            "The exact taskId string returned by start_async_task. Pass it verbatim.",
          ),
      }),
    },
  );
}

/** Confirm an update: queued behind an active run, or started, noting when it dropped a waiting human request. */
function updateMessage(tracked: AsyncTask, strategy: UpdateStrategy): string {
  if (
    strategy === "enqueue" &&
    (tracked.status === "running" || tracked.status === "pending")
  ) {
    return `Queued follow-up to async subagent without interrupting its current run. taskId: ${tracked.taskId}`;
  }
  const msg = `Updated async subagent. taskId: ${tracked.taskId}`;
  return tracked.status === "waiting"
    ? `${msg}. It was waiting for a human; that request was dropped.`
    : msg;
}

/**
 * Refuse every queued follow-up to a task after the first in one model turn.
 *
 * Parallel calls read the same state, so the task would lose track of all but one.
 */
function parallelUpdateError(
  taskId: string,
  runtime: ToolRuntime<AsyncTaskState>,
): string | null {
  const messages = runtime.state.messages ?? [];
  const turn = messages.findLast((m) => AIMessage.isInstance(m));
  const ids = (turn?.tool_calls ?? [])
    .filter(
      (call) =>
        call.name === "update_async_task" &&
        String(call.args.taskId ?? "").trim() === taskId,
    )
    .map((call) => call.id);
  if (!ids.slice(1).includes(toolCallIdFromRuntime(runtime))) return null;
  return (
    `Not sent: an earlier \`update_async_task\` call in this turn already queues a follow-up for task ${taskId}. ` +
    "Send this follow-up in a later turn, or combine the two into one message."
  );
}

/**
 * The runs a queued follow-up leaves behind it.
 *
 * The list grows while the task is unfinished, and otherwise restarts with the tracked run.
 */
function supersededAfterUpdate(tracked: AsyncTask): string[] {
  const earlier = UNFINISHED_STATUSES.has(tracked.status)
    ? (tracked.supersededRunIds ?? [])
    : [];
  return [...earlier, tracked.runId];
}

/** The tracked task after a follow-up created `run`, which may still be queued. */
function updatedTask(
  tracked: AsyncTask,
  run: Run,
  strategy: UpdateStrategy,
  message: string,
): AsyncTask {
  const task: AsyncTask = {
    ...tracked,
    runId: run.run_id,
    status: "running",
    description: message,
    updatedAt: new Date().toISOString(),
  };
  if (strategy === "enqueue") {
    task.status = run.status as AsyncTaskStatus;
    task.supersededRunIds = supersededAfterUpdate(tracked);
  }
  return task;
}

const UPDATE_TOOL_DESCRIPTION =
  "send updated instructions to an async subagent. Interrupts the current run and starts a new one on the same thread so the subagent sees the full conversation history plus your new message. The taskId remains the same.";

/** The update tool's description, naming the subagents whose follow-ups queue instead. */
function updateToolDescription(
  agentMap: Record<string, AsyncSubAgent>,
): string {
  const queued = Object.values(agentMap)
    .filter((spec) => spec.updateStrategy === "enqueue")
    .map((spec) => `\`${spec.name}\``);
  if (queued.length === 0) return UPDATE_TOOL_DESCRIPTION;
  return (
    `${UPDATE_TOOL_DESCRIPTION}\n\nException: for ${queued.join(", ")}, follow-ups queue behind the current run without interrupting it. ` +
    "A pending status means the latest follow-up is queued and earlier work may still be running. " +
    "If the current run stops to ask the user something, the queued follow-up still starts and that request is dropped. " +
    "Send one follow-up per task per turn; combine several into one message."
  );
}

/**
 * Build the `update_async_task` tool.
 *
 * Sends a follow-up message to an async subagent by creating a new run on the
 * same thread. The subagent sees the full conversation history plus the new
 * message. The `taskId` remains the same. The subagent's `updateStrategy`
 * decides whether the new run interrupts the current run or queues behind it.
 */
export function buildUpdateTool(
  agentMap: Record<string, AsyncSubAgent>,
  clients: ClientCache,
) {
  return tool(
    async (
      input,
      runtime: ToolRuntime<AsyncTaskState>,
    ): Promise<Command | string> => {
      const tracked = resolveTrackedTask(input.taskId, runtime.state);
      if (typeof tracked === "string") return tracked;

      const spec = agentMap[tracked.agentName];
      const strategy = spec.updateStrategy ?? "interrupt";
      const refused =
        strategy === "enqueue" && parallelUpdateError(tracked.taskId, runtime);
      if (refused) return refused;
      try {
        const client = clients.getClient(tracked.agentName, traceHeaders(spec));
        const run = await client.runs.create(tracked.threadId, spec.graphId, {
          input: {
            messages: [{ role: "user", content: input.message }],
          },
          multitaskStrategy: strategy,
          ...runOptions(spec, runtime),
        });

        return new Command({
          update: {
            messages: [
              new ToolMessage({
                content: updateMessage(tracked, strategy),
                tool_call_id: toolCallIdFromRuntime(runtime),
              }),
            ],
            asyncTasks: {
              [tracked.taskId]: updatedTask(
                tracked,
                run,
                strategy,
                input.message,
              ),
            },
          },
        });
      } catch (e) {
        return `Failed to update async subagent: ${e}`;
      }
    },
    {
      name: "update_async_task",
      description: updateToolDescription(agentMap),
      schema: z.object({
        taskId: z
          .string()
          .describe(
            "The exact taskId string returned by start_async_task. Pass it verbatim.",
          ),
        message: z
          .string()
          .describe(
            "Follow-up instructions or context to send to the subagent",
          ),
      }),
    },
  );
}

/**
 * Cancel earlier runs that are still pending or running, newest first.
 *
 * Newest first, so a queued run doesn't start when the run ahead of it is cancelled.
 * A run that can't be read or cancelled is skipped.
 */
async function cancelEarlierRuns(
  client: Client,
  task: AsyncTask,
): Promise<void> {
  for (const runId of [...(task.supersededRunIds ?? [])].reverse()) {
    try {
      const run = await client.runs.get(task.threadId, runId);
      if (run.status === "running" || run.status === "pending") {
        await client.runs.cancel(task.threadId, runId);
      }
    } catch (e) {
      // oxlint-disable-next-line no-console
      console.warn(
        `Failed to cancel earlier run ${runId} of task ${task.taskId}:`,
        e,
      );
    }
  }
}

/**
 * Build the `cancel_async_task` tool.
 *
 * Cancels the current run on the remote server and updates the task's
 * cached status to `"cancelled"`.
 */
export function buildCancelTool(clients: ClientCache) {
  return tool(
    async (
      input,
      runtime: ToolRuntime<AsyncTaskState>,
    ): Promise<Command | string> => {
      const tracked = resolveTrackedTask(input.taskId, runtime.state);
      if (typeof tracked === "string") return tracked;

      // A paused subagent has no active run to cancel; marking the task is enough.
      if (tracked.status !== "waiting") {
        try {
          const client = clients.getClient(tracked.agentName);
          await client.runs.cancel(tracked.threadId, tracked.runId);
          await cancelEarlierRuns(client, tracked);
        } catch (e) {
          return `Failed to cancel run: ${e}`;
        }
      }

      const updated: AsyncTask = {
        ...tracked,
        status: "cancelled",
        updatedAt: new Date().toISOString(),
      };

      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: `Cancelled async subagent task: ${tracked.taskId}`,
              tool_call_id: toolCallIdFromRuntime(runtime),
            }),
          ],
          asyncTasks: { [tracked.taskId]: updated },
        },
      });
    },
    {
      name: "cancel_async_task",
      description:
        "Cancel a running, pending, or waiting async subagent task. Use this to stop a task that is no longer needed.",
      schema: z.object({
        taskId: z
          .string()
          .describe(
            "The exact taskId string returned by start_async_task. Pass it verbatim.",
          ),
      }),
    },
  );
}

/**
 * Build the `list_async_tasks` tool.
 *
 * Lists all tracked tasks with their live statuses fetched in parallel.
 * Supports optional filtering by cached status.
 */
export function buildListTool(clients: ClientCache) {
  return tool(
    async (
      input,
      runtime: ToolRuntime<AsyncTaskState>,
    ): Promise<Command | string> => {
      const tasks = runtime.state.asyncTasks ?? {};
      const filtered = filterTasks(tasks, input.statusFilter ?? undefined);

      if (filtered.length === 0) {
        return "No async subagent tasks tracked";
      }

      const live = await Promise.all(
        filtered.map((task) => fetchLiveTaskStatus(clients, task)),
      );

      const updatedTasks: Record<string, AsyncTask> = {};
      const entries: string[] = [];
      for (let idx = 0; idx < filtered.length; idx++) {
        const task = filtered[idx];
        const [status, runId] = live[idx];
        entries.push(formatTaskEntry(task, status));
        updatedTasks[task.taskId] = observed(task, status, runId);
      }

      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: `${entries.length} tracked task(s):\n${entries.join("\n")}`,
              tool_call_id: toolCallIdFromRuntime(runtime),
            }),
          ],
          asyncTasks: updatedTasks,
        },
      });
    },
    {
      name: "list_async_tasks",
      description:
        "List tracked async subagent tasks with their current live statuses. By default shows all tasks. Use `statusFilter` to narrow by status (e.g., 'running', 'pending', 'waiting', 'success', 'error', 'cancelled'). Use `check_async_task` to get the full result of a specific completed task, or what a `waiting` task is asking the user. Statuses shown earlier in the conversation are always stale, so call this to read current statuses rather than reporting one from a previous tool result.",
      schema: z.object({
        statusFilter: z
          .string()
          .nullish()
          .describe(
            "Filter tasks by status. One of: 'running', 'pending', 'waiting', 'success', 'error', 'cancelled', 'all'. Defaults to 'all'.",
          ),
      }),
    },
  );
}

/** The notification for a task outcome a check found, or `null` for outcomes not worth waking for. */
function checkEvent(
  task: AsyncTask,
  run: Run,
  thread: Thread | null,
  status: AsyncTaskStatus,
): TaskUpdate | null {
  if (!NOTIFIED_STATUSES.has(status)) return null;
  const result = buildCheckResult(run, task.threadId, thread);
  const details: Partial<TaskUpdate> = {};
  if (result.interrupts) details.interrupts = result.interrupts;
  if (status === "success") details.result = result.result;
  if (status === "error") details.error = "The subagent failed.";
  return taskUpdate(
    {
      task_id: task.taskId,
      agent_name: task.agentName,
      status: status as TaskEvent["status"],
      run_id: run.run_id ?? task.runId,
    },
    details,
  );
}

/** Task outcomes that notify the parent. */
const NOTIFIED_STATUSES = new Set<AsyncTaskStatus>([
  "success",
  "error",
  "timeout",
  "cancelled",
  "waiting",
]);

/** How long the parent waits on one task's status before skipping it until the next check. */
const PULL_TIMEOUT_MS = 5_000;

/** Tracked task statuses that can still change, so the parent checks them for status updates. */
const UNFINISHED_STATUSES = new Set<AsyncTaskStatus>([
  "running",
  "pending",
  "waiting",
]);

/** State update from a pull: changed task records and a notification per new outcome. */
type PullUpdate = {
  asyncTasks?: Record<string, AsyncTask>;
  messages?: BaseMessage[];
};

/** Observe a task, or `null` when it can't be checked in time; it's checked again next time. */
async function observeTask(
  clients: ClientCache,
  task: AsyncTask,
): Promise<[Run, Thread | null] | null> {
  try {
    return await observeTaskRun(
      clients.getClient(task.agentName),
      task,
      AbortSignal.timeout(PULL_TIMEOUT_MS),
    );
  } catch (e) {
    // oxlint-disable-next-line no-console
    console.warn(`Failed to check task ${task.taskId}:`, e);
    return null;
  }
}

/**
 * Check unfinished tasks; return their updated records and a notification per new outcome.
 *
 * Outcomes the agent already saw aren't reported again; a task that can't be
 * checked is skipped until the next check.
 */
async function pull(
  clients: ClientCache,
  tasks: Record<string, AsyncTask>,
): Promise<PullUpdate> {
  const unfinished = Object.values(tasks).filter((task) =>
    UNFINISHED_STATUSES.has(task.status),
  );
  const found = await Promise.all(
    unfinished.map((task) => observeTask(clients, task)),
  );
  const records: Record<string, AsyncTask> = {};
  const messages: BaseMessage[] = [];
  unfinished.forEach((task, idx) => {
    if (found[idx] === null) return;
    const [run, thread] = found[idx];
    const status = taskStatus(run, thread);
    if (status === task.status && run.run_id === task.runId) return;
    records[task.taskId] = observed(task, status, run.run_id);
    const event =
      status !== task.status ? checkEvent(task, run, thread, status) : null;
    if (event) {
      messages.push(coerceMessageLikeToMessage(notificationMessage(event)));
    }
  });
  const update: PullUpdate = {};
  if (Object.keys(records).length > 0) update.asyncTasks = records;
  if (messages.length > 0) update.messages = messages;
  return update;
}

/**
 * When a task notification started this run, record the task's outcome so checks don't report it again.
 *
 * A notification from an earlier run that a queued follow-up replaced is rewritten
 * instead, so the model doesn't take it as the task's outcome.
 */
function recordNotification(
  messages: BaseMessage[],
  tasks: Record<string, AsyncTask>,
): PullUpdate {
  const last = messages[messages.length - 1];
  const event = notificationEvent(last);
  const task = event ? tasks[event.task_id] : undefined;
  // A cancelled task stays cancelled: the outcome of a run the agent gave up on isn't news.
  if (!event || !task || task.status === "cancelled") return {};
  const runId = event.run_id ?? task.runId;
  if (task.supersededRunIds?.includes(runId)) {
    // The copy keeps the message ID and `additional_kwargs`.
    const content = supersededNotificationContent(last, event);
    return {
      messages: [
        new HumanMessage({
          id: last.id,
          content,
          additional_kwargs: last.additional_kwargs,
        }),
      ],
    };
  }
  // Answering a pause starts a new run, so a new run ID counts while the task is unfinished.
  if (runId !== task.runId && !UNFINISHED_STATUSES.has(task.status)) return {};
  return {
    asyncTasks: { [task.taskId]: observed(task, event.status, runId) },
  };
}

/** The tasks tracked in state; the state schema stores `status` as a plain string. */
function trackedTasks(state: {
  asyncTasks?: Record<string, unknown>;
}): Record<string, AsyncTask> {
  return (state.asyncTasks ?? {}) as Record<string, AsyncTask>;
}

/** Whether the last message is a final answer: an AI message with no tool calls. */
function isFinalAnswer(messages: BaseMessage[]): boolean {
  const last = messages[messages.length - 1] as
    | (BaseMessage & { tool_calls?: unknown[] })
    | undefined;
  return last !== undefined && !last.tool_calls?.length;
}

/**
 * Options for creating async subagent middleware.
 */
export interface AsyncSubAgentMiddlewareOptions {
  /** List of async subagent specifications. Must have at least one. */
  asyncSubAgents: AsyncSubAgent[];
  /** Optional system prompt override. Tool schemas provide the built-in guidance. */
  systemPrompt?: string | null;
}

/**
 * Create middleware that adds async subagent tools to an agent.
 *
 * Provides five tools for launching, checking, updating, cancelling, and
 * listing background tasks on remote Agent Protocol servers. Task state is
 * persisted in the `asyncTasks` state channel so it survives
 * context compaction.
 *
 * Works with any Agent Protocol-compliant server — LangGraph Platform (managed)
 * or self-hosted (e.g. a Hono/Express server implementing the Agent Protocol spec).
 *
 * On an Agent Server, the agent is told when its tasks finish, fail or wait for
 * the user: by checking while it runs, and through a new run when it's idle.
 *
 * @experimental Task notifications are experimental and subject to change.
 *
 * @throws {Error} If no async subagents are provided or names are duplicated.
 *
 * @example
 * ```ts
 * const middleware = createAsyncSubAgentMiddleware({
 *   asyncSubAgents: [{
 *     name: "researcher",
 *     description: "Research agent for deep analysis",
 *     url: "https://my-agent-protocol-server.example.com",
 *     graphId: "research_agent",
 *   }],
 * });
 * ```
 */

/**
 * Type guard to distinguish async SubAgents from sync SubAgents/CompiledSubAgents.
 *
 * Uses the presence of the `graphId` field as the runtime discriminant —
 * `AsyncSubAgent` requires it, while `SubAgent` and `CompiledSubAgent` do not have it.
 */
export function isAsyncSubAgent(
  subAgent: AnySubAgent,
): subAgent is AsyncSubAgent {
  return "graphId" in subAgent;
}

export function createAsyncSubAgentMiddleware(
  options: AsyncSubAgentMiddlewareOptions,
) {
  const { asyncSubAgents, systemPrompt = null } = options;

  if (!asyncSubAgents || asyncSubAgents.length === 0) {
    throw new Error("At least one async subagent must be specified");
  }

  const names = asyncSubAgents.map((a) => a.name);
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate async subagent names: ${[...new Set(duplicates)].join(", ")}`,
    );
  }

  for (const spec of asyncSubAgents) {
    const strategy = spec.updateStrategy ?? "interrupt";
    if (strategy !== "interrupt" && strategy !== "enqueue") {
      throw new Error(
        `AsyncSubAgent '${spec.name}' has invalid updateStrategy '${strategy}'; expected 'interrupt' or 'enqueue'`,
      );
    }
    const mode = spec.mode ?? "isolated";
    if (mode !== "isolated" && mode !== "fork") {
      throw new Error(
        `AsyncSubAgent '${spec.name}' has invalid mode '${mode}'; expected 'isolated' or 'fork'`,
      );
    }
  }

  const agentMap = Object.fromEntries(asyncSubAgents.map((a) => [a.name, a]));
  const clients = new ClientCache(agentMap);

  const agentsDescription = asyncSubAgents
    .map(describeAsyncSubAgent)
    .join("\n");
  const launchDescription = ASYNC_TASK_TOOL_DESCRIPTION.replace(
    "{available_agents}",
    agentsDescription,
  );

  const tools = [
    buildStartTool(agentMap, clients, launchDescription),
    buildCheckTool(clients),
    buildUpdateTool(agentMap, clients),
    buildCancelTool(clients),
    buildListTool(clients),
  ];

  const fullSystemPrompt = systemPrompt
    ? `${systemPrompt}\n\nAvailable async subagent types:\n${agentsDescription}`
    : null;

  return createMiddleware({
    name: "asyncSubAgentMiddleware",
    stateSchema: AsyncTaskStateSchema,
    tools,
    beforeAgent: async (state) => {
      const messages = (state.messages ?? []) as BaseMessage[];
      const tasks = trackedTasks(state);
      const recorded = recordNotification(messages, tasks);
      const updates = await pull(clients, { ...tasks, ...recorded.asyncTasks });
      const asyncTasks = { ...recorded.asyncTasks, ...updates.asyncTasks };
      const notes = [...(recorded.messages ?? []), ...(updates.messages ?? [])];
      if (Object.keys(asyncTasks).length === 0 && notes.length === 0) return;
      return {
        asyncTasks,
        ...(notes.length > 0 && { messages: notes }),
      };
    },
    beforeModel: async (state) => {
      const updates = await pull(clients, trackedTasks(state));
      return Object.keys(updates).length > 0 ? updates : undefined;
    },
    afterModel: {
      canJumpTo: ["model"],
      // After a final answer, check tasks once more; a status update gives the model another turn.
      hook: async (state) => {
        const messages = (state.messages ?? []) as BaseMessage[];
        if (!isFinalAnswer(messages)) return;
        const updates = await pull(clients, trackedTasks(state));
        if (!updates.messages) {
          return Object.keys(updates).length > 0 ? updates : undefined;
        }
        return { ...updates, jumpTo: "model" as const };
      },
    },
    wrapModelCall: async (request, handler) => {
      if (fullSystemPrompt !== null) {
        return handler({
          ...request,
          systemMessage: request.systemMessage.concat(
            new SystemMessage({ content: fullSystemPrompt }),
          ),
        });
      }
      return handler(request);
    },
  });
}
