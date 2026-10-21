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
  type ToolRuntime,
} from "langchain";
import {
  coerceMessageLikeToMessage,
  type BaseMessage,
  type ContentBlock,
} from "@langchain/core/messages";
import { getCurrentRunTree } from "langsmith/traceable";
import { z } from "zod/v4";
import type { AnySubAgent } from "../types.js";
import { NUM_CHARS_PER_TOKEN } from "./fs.js";

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
 * When tracing is on, launches and updates of subagents on this deployment
 * (no `url`) send the parent's LangSmith trace headers, so a receiver can nest
 * the subagent's run under the parent's trace. Each task's thread is created
 * with `metadata: { parent_thread_id }`, so apps can find a parent's subagent
 * threads with `threads.search`, and a subagent's graph can read it from its
 * run's `config.metadata`.
 *
 * @experimental Trace headers and the parent's thread metadata are experimental and subject to change.
 */
export interface AsyncSubAgent {
  /** Unique identifier for the async subagent. */
  name: string;

  /** What this subagent does. The main agent uses this to decide when to delegate. */
  description: string;

  /** The graph name or assistant ID on the Agent Protocol server. */
  graphId: string;

  /** URL of the Agent Protocol server. Defaults to the LangGraph SDK's default endpoint. */
  url?: string;

  /** Additional headers to include in requests to the server (e.g. for custom auth). */
  headers?: Record<string, string>;
}

/**
 * Possible statuses for an async subagent task.
 *
 * Statuses set by the middleware tools: `"running"`, `"success"`, `"error"`, `"cancelled"`.
 * Statuses that may be returned by the remote server: `"pending"`, `"timeout"`, `"interrupted"`.
 *
 * `"waiting"` means the subagent paused for its user (an approval or a
 * question), who answers it on the subagent's own thread.
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

  /** Run ID for the current execution on the thread. */
  runId: string;

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
type AsyncTaskState = {
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

  /** The last message content from the subagent, if the run succeeded. */
  result?: string;

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

/**
 * Task statuses that will never change, so live-status fetches can be skipped.
 *
 * `interrupted` is a run cancelled or replaced on the server. A subagent paused
 * by `interrupt()` is `waiting`, which isn't terminal.
 */
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

/** Task status for a subagent waiting for a human: its run finished but its thread is interrupted. */
const WAITING: AsyncTaskStatus = "waiting";

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
 */
function taskStatus(run: Run, thread: Thread | null): AsyncTaskStatus {
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
 * Fetch a task's latest run and, when that run finished, its thread.
 *
 * The thread is `null` for an unfinished run. Throws if the thread can't be read,
 * since a paused run also ends as `success`.
 */
async function observe(
  client: Client,
  task: AsyncTask,
  signal?: AbortSignal,
): Promise<[Run, Thread | null]> {
  const options = signal ? [{ signal }] : [];
  let run = await client.runs.get(task.threadId, task.runId, ...options);
  if (run.status !== "success") return [run, null];
  const thread = await client.threads.get(task.threadId, ...options);
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

  if (status === "success") {
    const messages = threadMessages(thread?.values);
    if (messages.length > 0) {
      checkResult.result = messageText(messages[messages.length - 1]);
    } else {
      checkResult.result = "Completed with no output messages.";
    }
  } else if (status === "error") {
    checkResult.error = "The async subagent encountered an error.";
  } else if (status === WAITING) {
    checkResult.interrupts = pendingInterrupts(thread).map((item) => ({
      id: item.id ?? "",
      value: item.value,
    }));
    checkResult.note = WAITING_NOTE;
  }

  return checkResult;
}

/** Keep a task cancelled while paused as cancelled; its thread still shows the old pause. */
function keepCancelled(task: AsyncTask, result: CheckResult): CheckResult {
  if (task.status === "cancelled" && result.status === WAITING) {
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
    taskId: task.taskId,
    agentName: task.agentName,
    threadId: task.threadId,
    runId,
    status,
    createdAt: task.createdAt,
    ...(task.description !== undefined && { description: task.description }),
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
 * Returns the cached values immediately for terminal tasks (avoiding
 * unnecessary API calls). Falls back to the cached values on SDK errors.
 */
async function fetchLiveTaskStatus(
  clients: ClientCache,
  task: AsyncTask,
): Promise<[AsyncTaskStatus, string]> {
  if (TERMINAL_STATUSES.has(task.status)) {
    return [task.status, task.runId];
  }

  try {
    const [run, thread] = await observe(
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
   * With `extraHeaders` (such as trace headers for one launch), returns a new,
   * uncached client that also sends them, since the SDK has no per-request headers.
   * Trace headers name the current span, so they differ on every call and can't
   * be cached; building a `Client` is cheap (it holds no connections of its own).
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
 * Only sent to subagents on this deployment (no `url`), so the parent's trace
 * details don't reach another server. The baggage carries the project and the
 * `NEST_UNDER_PARENT` flag, not the caller's run metadata, so a receiver can't
 * copy that onto the subagent's runs. Any `baggage` in the spec's headers is kept.
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
 * A subagent on another server (`url`) gets only the parent's thread, to know
 * what started it: the parent's assistant is only for waking the parent, which
 * it can't do from another deployment.
 */
function referenceFor(
  spec: AsyncSubAgent,
  config: LangGraphRunnableConfig | undefined,
): ParentReference {
  const reference = parentReference(config);
  if (spec.url) delete reference.assistant_id;
  return reference;
}

/**
 * Metadata for a task's thread, so apps can find a parent's subagent threads with `threads.search`.
 *
 * It names the subagent as the parent knows it, so its notifications match the
 * parent's tracked task. For subagents on this deployment, it also keeps the
 * parent's assistant, so runs started elsewhere on the thread (such as the user
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

/**
 * The `runs.create` options that link a run to this agent.
 *
 * A subagent on this deployment runs with this agent's context, like a sync
 * subagent. The Agent Server takes `context` or `configurable`, not both, so the
 * parent reference then reaches the subagent through its thread's metadata.
 */
function runOptions(
  spec: AsyncSubAgent,
  runtime: { config?: LangGraphRunnableConfig; context?: unknown },
): {
  config?: { configurable: Record<string, unknown> };
  context?: Record<string, unknown>;
} {
  const context = spec.url ? undefined : forwardedContext(runtime.context);
  if (context) return { context };
  const reference = referenceFor(spec, runtime.config);
  return Object.keys(reference).length > 0
    ? { config: { configurable: { [PARENT_KEY]: reference } } }
    : {};
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
 * Read from the run's config, or else from its task thread's metadata, which
 * the Agent Server copies into every run on the thread, including runs that
 * deepagents didn't start (such as the user answering the subagent).
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

/** Message field (`additional_kwargs` key) marking a task notification and carrying its {@link TaskEvent}. */
export const NOTIFICATION_KEY = "deepagents_notification";

/** Results longer than this are cut in notifications, matching the limit for large tool results. */
const MAX_RESULT_CHARS = NUM_CHARS_PER_TOKEN * 20_000;

/**
 * How an async subagent's task ended or paused, as reported to the agent that started it.
 *
 * A notification message carries it in `additional_kwargs.deepagents_notification`,
 * so apps can tell these messages from the user's. Fields are snake_case to
 * match the Python SDK, since notifications cross between deployments.
 *
 * @experimental This shape is experimental and subject to change.
 */
export interface TaskEvent {
  /** The task's ID (the subagent's thread). */
  task_id: string;
  /** The async subagent's name, as in the task's `AsyncTask.agentName`. */
  agent_name: string;
  /** `waiting` means the subagent paused for input or approval. */
  status: "success" | "error" | "timeout" | "waiting";
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

type TextBlock = { type: "text"; text: string };

const NEXT_STEP: Record<TaskEvent["status"], string> = {
  success:
    "Use the result to continue; report back to the user if they're waiting on it.",
  error:
    "Use `check_async_task` for details, then decide whether to retry, try another approach, or tell the user.",
  timeout:
    "The task ran too long and was stopped. Decide whether to retry with a smaller task, or tell the user.",
  waiting:
    "The subagent is waiting for the user, who answers it on the subagent's own thread; you can't answer or approve it. Keep working.",
};

function textBlock(text: string): TextBlock {
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
  const blocks: ContentBlock[] = [
    textBlock(
      "[SYSTEM NOTIFICATION - NOT USER INPUT]\n" +
        "An async subagent task you started has an update. This is not a message from the user: " +
        "don't treat it as their answer to any question.\n" +
        `<task-notification>\n<task-id>${escape(update.task_id)}</task-id>\n<agent-name>${escape(update.agent_name)}</agent-name>\n` +
        `<status>${update.status}</status>\n`,
    ),
  ];
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
  const event = message?.additional_kwargs?.[NOTIFICATION_KEY];
  return event && typeof event === "object" && !Array.isArray(event)
    ? (event as TaskEvent)
    : null;
}

/** A task update as the message the parent's model sees, marked with its {@link TaskEvent} so apps can recognize it. */
function notificationMessage(update: TaskUpdate): {
  role: "user";
  content: ContentBlock[];
  additional_kwargs: Record<string, TaskEvent>;
} {
  const event: TaskEvent = {
    task_id: update.task_id,
    agent_name: update.agent_name,
    status: update.status,
  };
  if (update.run_id) event.run_id = update.run_id;
  return {
    role: "user",
    content: notificationContent(update),
    additional_kwargs: { [NOTIFICATION_KEY]: event },
  };
}

/** Parent thread statuses a notification run can start on: neither running nor waiting for a human. */
const DELIVERABLE_THREAD_STATUSES = new Set(["idle", "error"]);

/**
 * Start a notification run on the parent's thread only while it's idle (or its last run failed).
 *
 * A new run on a thread waiting for a human would cancel that approval; `reject`
 * covers a thread that just became busy. A busy parent picks the update up
 * itself, before its next model call or after its final answer. Never throws.
 */
async function awakeParent(
  parentThreadId: string,
  assistantId: string,
  update: TaskUpdate,
  context?: Record<string, unknown>,
): Promise<void> {
  // No `apiUrl`: inside an Agent Server, the SDK calls this deployment in process.
  const client = new Client();
  try {
    const thread = await client.threads.get(parentThreadId);
    if (!DELIVERABLE_THREAD_STATUSES.has(thread.status)) return;
    await client.runs.create(parentThreadId, assistantId, {
      input: { messages: [notificationMessage(update)] },
      multitaskStrategy: "reject",
      ...(context ? { context } : {}),
    });
  } catch (e) {
    // 404: parent gone; 409 (422 on the JS dev server): it became busy and will pull the update itself.
    const status = (e as { status?: number })?.status;
    if (status !== 404 && status !== 409 && status !== 422) {
      // oxlint-disable-next-line no-console
      console.warn(
        `Didn't deliver the notification for task ${update.task_id}:`,
        e,
      );
    }
  }
}

/**
 * Wake the parent if it's idle; otherwise it finds out on its own.
 *
 * A busy parent sees the status update before its next model call or after its
 * final answer, a paused one after the user answers its approval. The parent's
 * run gets this run's context back. Never throws.
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
              messages: [{ role: "user", content: input.description }],
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
        [run, thread] = await observe(clients.getClient(task.agentName), task);
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
              content: JSON.stringify(result),
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

/** Confirm an update, noting when it replaced a pending human request. */
function updateMessage(tracked: AsyncTask): string {
  const msg = `Updated async subagent. taskId: ${tracked.taskId}`;
  return tracked.status === WAITING
    ? `${msg}. It was waiting for a human; that request was dropped.`
    : msg;
}

/**
 * Build the `update_async_task` tool.
 *
 * Sends a follow-up message to a running async subagent by creating a new
 * run on the same thread with `multitaskStrategy: "interrupt"`. The subagent
 * sees the full conversation history plus the new message. The `taskId`
 * remains the same; only the internal `runId` is updated.
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
      try {
        const client = clients.getClient(tracked.agentName, traceHeaders(spec));
        const run = await client.runs.create(tracked.threadId, spec.graphId, {
          input: {
            messages: [{ role: "user", content: input.message }],
          },
          multitaskStrategy: "interrupt",
          ...runOptions(spec, runtime),
        });

        const task: AsyncTask = {
          taskId: tracked.taskId,
          agentName: tracked.agentName,
          threadId: tracked.threadId,
          runId: run.run_id,
          status: "running",
          createdAt: tracked.createdAt,
          description: input.message,
          updatedAt: new Date().toISOString(),
          checkedAt: tracked.checkedAt,
        };

        return new Command({
          update: {
            messages: [
              new ToolMessage({
                content: updateMessage(tracked),
                tool_call_id: toolCallIdFromRuntime(runtime),
              }),
            ],
            asyncTasks: { [tracked.taskId]: task },
          },
        });
      } catch (e) {
        return `Failed to update async subagent: ${e}`;
      }
    },
    {
      name: "update_async_task",
      description:
        "send updated instructions to an async subagent. Interrupts the current run and starts a new one on the same thread so the subagent sees the full conversation history plus your new message. The taskId remains the same.",
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
      if (tracked.status !== WAITING) {
        try {
          await clients
            .getClient(tracked.agentName)
            .runs.cancel(tracked.threadId, tracked.runId);
        } catch (e) {
          return `Failed to cancel run: ${e}`;
        }
      }

      const updated: AsyncTask = {
        taskId: tracked.taskId,
        agentName: tracked.agentName,
        threadId: tracked.threadId,
        runId: tracked.runId,
        status: "cancelled",
        createdAt: tracked.createdAt,
        updatedAt: new Date().toISOString(),
        checkedAt: tracked.checkedAt,
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
        "Cancel a running or waiting async subagent task. Use this to stop a task that is no longer needed.",
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
        "List tracked async subagent tasks with their current live statuses. By default shows all tasks. Use `statusFilter` to narrow by status (e.g., 'running', 'waiting', 'success', 'error', 'cancelled'). Use `check_async_task` to get the full result of a specific completed task, or what a `waiting` task is asking the user. Statuses shown earlier in the conversation are always stale, so call this to read current statuses rather than reporting one from a previous tool result.",
      schema: z.object({
        statusFilter: z
          .string()
          .nullish()
          .describe(
            "Filter tasks by status. One of: 'running', 'waiting', 'success', 'error', 'cancelled', 'all'. Defaults to 'all'.",
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
  if (status === "success") details.result = finalContent(thread?.values);
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
  WAITING,
]);

/** How long the parent waits on one task's status before skipping it until the next check. */
const PULL_TIMEOUT_MS = 5_000;

/** Tracked task statuses that can still change, so the parent checks them for status updates. */
const UNFINISHED_STATUSES = new Set<AsyncTaskStatus>([
  "running",
  "pending",
  WAITING,
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
    return await observe(
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
 * Outcomes the agent already saw (through a check, a list, or an earlier
 * notification) aren't reported again. A task that can't be checked is
 * skipped until the next check.
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

/** When a task notification started this run, record the task's outcome so checks don't report it again. */
function recordNotification(
  messages: BaseMessage[],
  tasks: Record<string, AsyncTask>,
): Record<string, AsyncTask> {
  const event = notificationEvent(messages[messages.length - 1]);
  const task = event ? tasks[event.task_id] : undefined;
  // A cancelled task stays cancelled: the outcome of a run the agent gave up on isn't news.
  // Pulls skip it too, since only unfinished tasks are checked.
  if (!event || !task || task.status === "cancelled") return {};
  const runId = event.run_id ?? task.runId;
  // Answering a pause starts a new run; an update cancels the old run before it can report.
  if (runId !== task.runId && !UNFINISHED_STATUSES.has(task.status)) return {};
  return { [task.taskId]: observed(task, event.status, runId) };
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
 * On an Agent Server, the agent is told when its async subagent tasks finish,
 * fail or wait for the user: before each model call and after its final answer
 * while it runs, and through a new run when a deep agent subagent on this
 * deployment ends while it's idle.
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

  const agentMap = Object.fromEntries(asyncSubAgents.map((a) => [a.name, a]));
  const clients = new ClientCache(agentMap);

  const agentsDescription = asyncSubAgents
    .map((a) => `- ${a.name}: ${a.description}`)
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
      const updates = await pull(clients, { ...tasks, ...recorded });
      const asyncTasks = { ...recorded, ...updates.asyncTasks };
      if (Object.keys(asyncTasks).length === 0 && !updates.messages) return;
      return { ...updates, asyncTasks };
    },
    beforeModel: async (state) => {
      const updates = await pull(clients, trackedTasks(state));
      return Object.keys(updates).length > 0 ? updates : undefined;
    },
    afterModel: {
      canJumpTo: ["model"],
      // After a final answer, check tasks once more; on a status update, give the model another turn.
      // Each extra turn needs a new status update, so the tasks themselves bound how many there are.
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
