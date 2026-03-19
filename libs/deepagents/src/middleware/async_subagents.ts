import {
  Command,
  getCurrentTaskInput,
  ReducedValue,
  StateSchema,
} from "@langchain/langgraph";
import { Client, type DefaultValues, type Run } from "@langchain/langgraph-sdk";
import { createMiddleware, tool, ToolMessage, SystemMessage } from "langchain";
import { z } from "zod/v4";

/**
 * Specification for an async subagent running on a remote LangGraph server.
 *
 * Async subagents connect to LangGraph deployments via the LangGraph SDK.
 * They run as background tasks that the main agent can monitor and update.
 *
 * Authentication is handled via environment variables (`LANGGRAPH_API_KEY`,
 * `LANGSMITH_API_KEY`, or `LANGCHAIN_API_KEY`), which the LangGraph SDK
 * reads automatically.
 */
export interface AsyncSubAgent {
  /** Unique identifier for the async subagent. */
  name: string;

  /** What this subagent does. The main agent uses this to decide when to delegate. */
  description: string;

  /** The graph name or assistant ID on the remote server. */
  graphId: string;

  /** URL of the LangGraph server. Omit for local ASGI transport. */
  url?: string;

  /** Additional headers to include in requests to the remote server. */
  headers?: Record<string, string>;
}

/**
 * Possible statuses for an async subagent task.
 *
 * Statuses set by the middleware tools: `"running"`, `"success"`, `"error"`, `"cancelled"`.
 * Statuses that may be returned by the LangGraph Platform: `"timeout"`, `"interrupted"`.
 */
export type AsyncSubAgentStatus =
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "timeout"
  | "interrupted";

/**
 * A tracked async subagent task persisted in agent state.
 *
 * Each task maps to a single thread + run on a remote LangGraph server.
 * The `taskId` is the same as `threadId`, so it can be used to look up
 * the thread directly via the SDK.
 */
export interface AsyncSubAgentTask {
  /** Unique identifier for the task (same as thread id). */
  taskId: string;

  /** Name of the async subagent type that is running. */
  agentName: string;

  /** LangGraph thread ID for the remote run. */
  threadId: string;

  /** LangGraph run ID for the current execution on the thread. */
  runId: string;

  /** Current task status. */
  status: AsyncSubAgentStatus;

  /** ISO timestamp of when the task was launched. */
  createdAt: string;

  /** ISO timestamp of the most recent follow-up message sent to the subagent via the update tool. */
  updatedAt?: string;

  /** ISO timestamp of the most recent status poll via the check tool. */
  checkedAt?: string;
}

/**
 * Shape of the async subagent state channel.
 *
 * Used as the generic parameter for `getCurrentTaskInput()` so tools
 * get typed access to `asyncSubAgentTasks` without casting.
 */
interface AsyncSubAgentState {
  /** All tracked async subagent tasks, keyed by task ID. */
  asyncSubAgentTasks?: Record<string, AsyncSubAgentTask>;
}

/**
 * Result of checking an async subagent's run status.
 *
 * Returned by `buildCheckResult` and used by `buildCheckTool`
 * to construct the `Command` update.
 */
interface CheckResult {
  /** Current status of the run. */
  status: AsyncSubAgentStatus;

  /** The thread ID on the remote server. */
  threadId: string;

  /** The last message content from the subagent, if the run succeeded. */
  result?: string;

  /** Error description, if the run errored. */
  error?: string;
}

/**
 * Zod schema for {@link AsyncSubAgentTask}.
 *
 * Used by the {@link ReducedValue} in the state schema so that LangGraph
 * can validate and serialize task records stored in `asyncSubAgentTasks`.
 */
const AsyncSubAgentTaskSchema = z.object({
  taskId: z.string(),
  agentName: z.string(),
  threadId: z.string(),
  runId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  checkedAt: z.string().optional(),
});

/**
 * State schema for the async subagent middleware.
 *
 * Declares `asyncSubAgentTasks` as a reduced state channel so that individual
 * tool updates (launch, check, update, cancel, list) merge into the existing
 * tasks dict rather than replacing it wholesale.
 */
const AsyncSubAgentStateSchema = new StateSchema({
  asyncSubAgentTasks: new ReducedValue(
    z.record(z.string(), AsyncSubAgentTaskSchema).default(() => ({})),
    {
      inputSchema: z.record(z.string(), AsyncSubAgentTaskSchema).optional(),
      reducer: asyncSubAgentTasksReducer,
    },
  ),
});

/**
 * Reducer for the `asyncSubAgentTasks` state channel.
 *
 * Merges task updates into the existing tasks dict using shallow spread.
 * This allows individual tools to update a single task without overwriting
 * the full map — only the keys present in `update` are replaced.
 *
 * @param existing - The current tasks dict from state (may be undefined on first write).
 * @param update - New or updated task entries to merge in.
 * @returns Merged tasks dict.
 */
export function asyncSubAgentTasksReducer(
  existing?: Record<string, AsyncSubAgentTask>,
  update?: Record<string, AsyncSubAgentTask>,
): Record<string, AsyncSubAgentTask> {
  return { ...(existing || {}), ...(update || {}) };
}

/**
 * Description template for the `launch_async_subagent` tool.
 *
 * The `{available_agents}` placeholder is replaced at middleware creation
 * time with a formatted list of configured async subagent names and descriptions.
 */
const ASYNC_TASK_TOOL_DESCRIPTION = `Launch an async subagent on a remote LangGraph server. The subagent runs in the background and returns a task ID immediately.

Available async agent types:
{available_agents}

## Usage notes:
1. This tool launches a background task and returns immediately with a task ID. Report the task ID to the user and stop — do NOT immediately check status.
2. Use \`check_async_subagent_task\` only when the user asks for a status update or result.
3. Use \`update_async_subagent_task\` to send new instructions to a running task.
4. Multiple async subagents can run concurrently — launch several and let them run in the background.
5. The subagent runs on a remote LangGraph server, so it has its own tools and capabilities.`;

/**
 * Default system prompt appended to the main agent's system message when
 * async subagent middleware is active.
 *
 * Provides the agent with instructions on how to use the five async subagent
 * tools (launch, check, update, cancel, list) including workflow ordering,
 * critical rules about polling behavior, and guidance on when to use async
 * subagents vs. synchronous delegation.
 */
export const ASYNC_TASK_SYSTEM_PROMPT = `## Async subagents (remote LangGraph servers)

You have access to async subagent tools that launch background tasks on remote LangGraph servers.

### Tools:
- \`launch_async_subagent_task\`: Start a new background task. Returns a task ID immediately.
- \`check_async_subagent_task\`: Check the status of a running task. Returns status and result if complete.
- \`update_async_subagent_task\`: Send an update or new instructions to a running task.
- \`cancel_async_subagent_task\`: Cancel a running task that is no longer needed.
- \`list_async_subagent_tasks\`: List all tracked tasks with live statuses. Use this to check all tasks at once.

### Workflow:
1. **Launch** — Use \`launch_async_subagent_task\` to start a task. Report the task ID to the user and stop.
   Do NOT immediately check the status — the task runs in the background while you and the user continue other work.
2. **Check (on request)** — Only use \`check_async_subagent_task\` when the user explicitly asks for a status update or
   result. If the status is "running", report that and stop — do not poll in a loop.
3. **Update** (optional) — Use \`update_async_subagent_task\` to send new instructions to a running task. This interrupts
   the current run and starts a fresh one on the same thread. The task_id stays the same.
4. **Cancel** (optional) — Use \`cancel_async_subagent_task\` to stop a task that is no longer needed.
5. **Collect** — When \`check_async_subagent_task\` returns status "success", the result is included in the response.
6. **List** — Use \`list_async_subagent_tasks\` to see live statuses for all tasks at once, or to recall task IDs after context compaction.

### Critical rules:
- After launching, ALWAYS return control to the user immediately. Never auto-check after launching.
- Never poll \`check_async_subagent_task\` in a loop. Check once per user request, then stop.
- If a check returns "running", tell the user and wait for them to ask again.
- Task statuses in conversation history are ALWAYS stale — a task that was "running" may now be done.
  NEVER report a status from a previous tool result. ALWAYS call a tool to get the current status:
  use \`list_async_subagent_tasks\` when the user asks about multiple tasks or "all tasks",
  use \`check_async_subagent_task\` when the user asks about a specific task.
- Always show the full task_id — never truncate or abbreviate it.

### When to use async subagents:
- Long-running tasks that would block the main agent
- Tasks that benefit from running on specialized remote deployments
- When you want to run multiple tasks concurrently and collect results later`;

/**
 * Task statuses that will never change.
 *
 * When listing tasks, live-status fetches are skipped for tasks whose
 * cached status is in this set, since they are guaranteed to be final.
 */
export const TERMINAL_STATUSES = new Set<AsyncSubAgentStatus>([
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
 * @param state - The current agent state containing `asyncSubAgentTasks`.
 * @returns The tracked task on success, or an error string.
 */
function resolveTrackedTask(
  taskId: string,
  state: AsyncSubAgentState,
): AsyncSubAgentTask | string {
  const tasks = state.asyncSubAgentTasks ?? {};
  const tracked = tasks[taskId.trim()];
  if (!tracked) {
    return `No tracked task found for taskId: '${taskId}'`;
  }
  return tracked;
}

/**
 * Build a check result from a run's current status and thread state values.
 *
 * For successful runs, extracts the last message's content from the remote
 * thread's state values. For errored runs, includes a generic error message.
 *
 * @param run - The run object from the SDK.
 * @param threadId - The thread ID for the run.
 * @param threadValues - The `values` from `ThreadState` (the remote subagent's state).
 */
function buildCheckResult(
  run: Run,
  threadId: string,
  threadValues: DefaultValues,
): CheckResult {
  const checkResult: CheckResult = {
    status: run.status as AsyncSubAgentStatus,
    threadId,
  };

  if (run.status === "success") {
    const values = Array.isArray(threadValues) ? {} : threadValues;
    const messages = (values?.messages ?? []) as unknown[];
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      const rawContent =
        typeof last === "object" && last !== null && "content" in last
          ? (last as Record<string, unknown>).content
          : last;
      checkResult.result =
        typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(rawContent);
    } else {
      checkResult.result = "Completed with no output messages.";
    }
  } else if (run.status === "error") {
    checkResult.error = "The async subagent encountered an error.";
  }

  return checkResult;
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
  tasks: Record<string, AsyncSubAgentTask>,
  statusFilter?: string,
): AsyncSubAgentTask[] {
  if (!statusFilter || statusFilter === "all") {
    return Object.values(tasks);
  }
  return Object.values(tasks).filter((task) => task.status === statusFilter);
}

/**
 * Fetch the current run status from the server.
 *
 * Returns the cached status immediately for terminal tasks (avoiding
 * unnecessary API calls). Falls back to the cached status on SDK errors.
 */
async function fetchLiveTaskStatus(
  clients: ClientCache,
  task: AsyncSubAgentTask,
): Promise<AsyncSubAgentStatus> {
  if (TERMINAL_STATUSES.has(task.status)) {
    return task.status;
  }

  try {
    const client = clients.getClient(task.agentName);
    const run = await client.runs.get(task.threadId, task.runId);
    return run.status as AsyncSubAgentStatus;
  } catch {
    return task.status;
  }
}

/**
 * Format a single task as a display string for list output.
 */
function formatTaskEntry(
  task: AsyncSubAgentTask,
  status: AsyncSubAgentStatus,
): string {
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
   * Build headers for a remote LangGraph server, adding the default
   * `x-auth-scheme: langsmith` header if not already present.
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
   */
  getClient(name: string): Client {
    const spec = this.agents[name];
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
 * Build the `launch_async_subagent_task` tool.
 *
 * Creates a thread on the remote server, starts a run, and returns a
 * `Command` that persists the new task in state.
 */
export function buildLaunchTool(
  agentMap: Record<string, AsyncSubAgent>,
  clients: ClientCache,
  toolDescription: string,
) {
  return tool(
    async (input, config): Promise<Command | string> => {
      if (!(input.agentName in agentMap)) {
        const allowed = Object.keys(agentMap)
          .map((k) => `\`${k}\``)
          .join(", ");
        return `Unknown async subagent type \`${input.agentName}\`. Available types: ${allowed}`;
      }

      const spec = agentMap[input.agentName];
      try {
        const client = clients.getClient(input.agentName);
        const thread = await client.threads.create();
        const run = await client.runs.create(thread.thread_id, spec.graphId, {
          input: { messages: [{ role: "user", content: input.description }] },
        });

        const taskId = thread.thread_id;
        const task: AsyncSubAgentTask = {
          taskId,
          agentName: input.agentName,
          threadId: taskId,
          runId: run.run_id,
          status: "running",
          createdAt: new Date().toISOString(),
        };

        return new Command({
          update: {
            messages: [
              new ToolMessage({
                content: `Launched async subagent. taskId: ${taskId}`,
                tool_call_id: config.toolCall?.id ?? "",
              }),
            ],
            asyncSubAgentTasks: { [taskId]: task },
          },
        });
      } catch (e) {
        return `Failed to launch async subagent '${input.agentName}': ${e}`;
      }
    },
    {
      name: "launch_async_subagent_task",
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
 * Build the `check_async_subagent_task` tool.
 *
 * Fetches the current run status from the remote server and, if the run
 * succeeded, retrieves the thread state to extract the result.
 */
export function buildCheckTool(clients: ClientCache) {
  return tool(
    async (input, config): Promise<Command | string> => {
      const state = getCurrentTaskInput<AsyncSubAgentState>();
      const task = resolveTrackedTask(input.taskId, state);
      if (typeof task === "string") return task;

      const client = clients.getClient(task.agentName);
      let run: Run;
      try {
        run = await client.runs.get(task.threadId, task.runId);
      } catch (e) {
        return `Failed to get run status: ${e}`;
      }

      let threadValues: DefaultValues = {};
      if (run.status === "success") {
        try {
          const threadState = await client.threads.getState(task.threadId);
          threadValues = (threadState.values as DefaultValues) || {};
        } catch {
          // Thread state fetch failed — still report success, just without the output
        }
      }

      const result = buildCheckResult(run, task.threadId, threadValues);
      const updatedTask: AsyncSubAgentTask = {
        taskId: task.taskId,
        agentName: task.agentName,
        threadId: task.threadId,
        runId: task.runId,
        status: result.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        checkedAt: new Date().toISOString(),
      };

      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: JSON.stringify(result),
              tool_call_id: config.toolCall?.id ?? "",
            }),
          ],
          asyncSubAgentTasks: { [task.taskId]: updatedTask },
        },
      });
    },
    {
      name: "check_async_subagent_task",
      description:
        "Check the status of an async subagent task. Returns the current status and, if complete, the result.",
      schema: z.object({
        taskId: z
          .string()
          .describe(
            "The exact taskId string returned by launch_async_subagent_task. Pass it verbatim.",
          ),
      }),
    },
  );
}

/**
 * Build the `update_async_subagent_task` tool.
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
    async (input, config): Promise<Command | string> => {
      const state = getCurrentTaskInput<AsyncSubAgentState>();
      const tracked = resolveTrackedTask(input.taskId, state);
      if (typeof tracked === "string") return tracked;

      const spec = agentMap[tracked.agentName];
      try {
        const client = clients.getClient(tracked.agentName);
        const run = await client.runs.create(tracked.threadId, spec.graphId, {
          input: {
            messages: [{ role: "user", content: input.message }],
          },
          multitaskStrategy: "interrupt",
        });

        const task: AsyncSubAgentTask = {
          taskId: tracked.taskId,
          agentName: tracked.agentName,
          threadId: tracked.threadId,
          runId: run.run_id,
          status: "running",
          createdAt: tracked.createdAt,
          updatedAt: new Date().toISOString(),
          checkedAt: tracked.checkedAt,
        };

        return new Command({
          update: {
            messages: [
              new ToolMessage({
                content: `Updated async subagent. taskId: ${tracked.taskId}`,
                tool_call_id: config.toolCall?.id ?? "",
              }),
            ],
            asyncSubAgentTasks: { [tracked.taskId]: task },
          },
        });
      } catch (e) {
        return `Failed to update async subagent: ${e}`;
      }
    },
    {
      name: "update_async_subagent_task",
      description:
        "send updated instructions to an async subagent. Interrupts the current run and starts a new one on the same thread so the subagent sees the full conversation history plus your new message. The taskId remains the same.",
      schema: z.object({
        taskId: z
          .string()
          .describe(
            "The exact taskId string returned by launch_async_subagent_task. Pass it verbatim.",
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
 * Build the `cancel_async_subagent_task` tool.
 *
 * Cancels the current run on the remote server and updates the task's
 * cached status to `"cancelled"`.
 */
export function buildCancelTool(clients: ClientCache) {
  return tool(
    async (input, config): Promise<Command | string> => {
      const state = getCurrentTaskInput<AsyncSubAgentState>();
      const tracked = resolveTrackedTask(input.taskId, state);
      if (typeof tracked === "string") return tracked;

      const client = clients.getClient(tracked.agentName);
      try {
        await client.runs.cancel(tracked.threadId, tracked.runId);
      } catch (e) {
        return `Failed to cancel run: ${e}`;
      }

      const updated: AsyncSubAgentTask = {
        taskId: tracked.taskId,
        agentName: tracked.agentName,
        threadId: tracked.threadId,
        runId: tracked.runId,
        status: "cancelled",
        createdAt: tracked.createdAt,
        updatedAt: tracked.updatedAt,
        checkedAt: tracked.checkedAt,
      };

      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: `Cancelled async subagent task: ${tracked.taskId}`,
              tool_call_id: config.toolCall?.id ?? "",
            }),
          ],
          asyncSubAgentTasks: { [tracked.taskId]: updated },
        },
      });
    },
    {
      name: "cancel_async_subagent_task",
      description:
        "Cancel a running async subagent task. Use this to stop a task that is no longer needed.",
      schema: z.object({
        taskId: z
          .string()
          .describe(
            "The exact taskId string returned by launch_async_subagent_task. Pass it verbatim.",
          ),
      }),
    },
  );
}

/**
 * Build the `list_async_subagent_tasks` tool.
 *
 * Lists all tracked tasks with their live statuses fetched in parallel.
 * Supports optional filtering by cached status.
 */
export function buildListTool(clients: ClientCache) {
  return tool(
    async (input, config): Promise<Command | string> => {
      const state = getCurrentTaskInput<AsyncSubAgentState>();
      const tasks = state.asyncSubAgentTasks ?? {};
      const filtered = filterTasks(tasks, input.statusFilter ?? undefined);

      if (filtered.length === 0) {
        return "No async subagent tasks tracked";
      }

      const statuses = await Promise.all(
        filtered.map((task) => fetchLiveTaskStatus(clients, task)),
      );

      const updatedTasks: Record<string, AsyncSubAgentTask> = {};
      const entries: string[] = [];
      for (let idx = 0; idx < filtered.length; idx++) {
        const task = filtered[idx];
        const status = statuses[idx];

        const taskEntry = formatTaskEntry(task, status);
        entries.push(taskEntry);

        updatedTasks[task.taskId] = {
          taskId: task.taskId,
          agentName: task.agentName,
          threadId: task.threadId,
          runId: task.runId,
          status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          checkedAt: task.checkedAt,
        };
      }

      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: `${entries.length} tracked task(s):\n${entries.join("\n")}`,
              tool_call_id: config.toolCall?.id ?? "",
            }),
          ],
          asyncSubAgentTasks: updatedTasks,
        },
      });
    },
    {
      name: "list_async_subagent_tasks",
      description:
        "List tracked async subagent tasks with their current live statuses. Be default shows all tasks. Use `statusFilter` to narrow by status (e.g., 'running', 'success', 'error', 'cancelled'). Use `check_async_subagent_task` to get the full result of a specific completed task.",
      schema: z.object({
        statusFilter: z
          .string()
          .nullish()
          .describe(
            "Filter tasks by status. One of: 'running', 'success', 'error', 'cancelled', 'all'. Defaults to 'all'.",
          ),
      }),
    },
  );
}

/**
 * Options for creating async subagent middleware.
 */
export interface AsyncSubAgentMiddlewareOptions {
  /** List of async subagent specifications. Must have at least one. */
  asyncSubAgents: AsyncSubAgent[];
  /** System prompt override. Set to `null` to disable. Defaults to {@link ASYNC_TASK_SYSTEM_PROMPT}. */
  systemPrompt?: string;
}

/**
 * Create middleware that adds async subagent tools to an agent.
 *
 * Provides five tools for launching, checking, updating, cancelling, and
 * listing background tasks on remote LangGraph deployments. Task state is
 * persisted in the `asyncSubAgentTasks` state channel so it survives
 * context compaction.
 *
 * @throws {Error} If no async subagents are provided or names are duplicated.
 *
 * @example
 * ```ts
 * const middleware = createAsyncSubAgentMiddleware({
 *   asyncSubAgents: [{
 *     name: "researcher",
 *     description: "Research agent for deep analysis",
 *     url: "https://my-deployment.langsmith.dev",
 *     graphId: "research_agent",
 *   }],
 * });
 * ```
 */
export function createAsyncSubAgentMiddleware(
  options: AsyncSubAgentMiddlewareOptions,
) {
  const { asyncSubAgents, systemPrompt = ASYNC_TASK_SYSTEM_PROMPT } = options;

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
    buildLaunchTool(agentMap, clients, launchDescription),
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
    stateSchema: AsyncSubAgentStateSchema,
    tools,
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
