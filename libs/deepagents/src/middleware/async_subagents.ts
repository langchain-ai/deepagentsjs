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
 * Specification for an async SubAgent running on a remote LangGraph server.
 *
 * Async SubAgents connect to LangGraph deployments via the LangGraph SDK.
 * They run as background jobs that the main agent can monitor and update.
 *
 * Authentication is handled via environment variables (`LANGGRAPH_API_KEY`,
 * `LANGSMITH_API_KEY`, or `LANGCHAIN_API_KEY`), which the LangGraph SDK
 * reads automatically.
 */
export interface AsyncSubAgent {
  /** Unique identifier for the async SubAgent. */
  name: string;

  /** What this SubAgent does. The main agent uses this to decide when to delegate. */
  description: string;

  /** The graph name or assistant ID on the remote server. */
  graphId: string;

  /** URL of the LangGraph server. Omit for local ASGI transport. */
  url?: string;

  /** Additional headers to include in requests to the remote server. */
  headers?: Record<string, string>;
}

/**
 * Possible statuses for an async SubAgent job.
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
 * A tracked async SubAgent job persisted in agent state.
 *
 * Each job maps to a single thread + run on a remote LangGraph server.
 * The `jobId` is the same as `threadId`, so it can be used to look up
 * the thread directly via the SDK.
 */
export interface AsyncSubAgentJob {
  /** Unique identifier for the job (same as thread id). */
  jobId: string;

  /** Name of the async SubAgent type that is running. */
  agentName: string;

  /** LangGraph thread ID for the remote run. */
  threadId: string;

  /** LangGraph run ID for the current execution on the thread. */
  runId: string;

  /** Current job status. */
  status: AsyncSubAgentStatus;
}

/**
 * Shape of the async SubAgent state channel.
 *
 * Used as the generic parameter for `getCurrentTaskInput()` so tools
 * get typed access to `asyncSubAgentJobs` without casting.
 */
interface AsyncSubAgentState {
  /** All tracked async SubAgent jobs, keyed by job ID. */
  asyncSubAgentJobs?: Record<string, AsyncSubAgentJob>;
}

/**
 * Result of checking an async SubAgent's run status.
 *
 * Returned by `buildCheckResult` and used by `buildCheckTool`
 * to construct the `Command` update.
 */
interface CheckResult {
  /** Current status of the run. */
  status: AsyncSubAgentStatus;

  /** The thread ID on the remote server. */
  threadId: string;

  /** The last message content from the SubAgent, if the run succeeded. */
  result?: string;

  /** Error description, if the run errored. */
  error?: string;
}

/**
 * Zod schema for {@link AsyncSubAgentJob}.
 *
 * Used by the {@link ReducedValue} in the state schema so that LangGraph
 * can validate and serialize job records stored in `asyncSubAgentJobs`.
 */
const AsyncSubAgentJobSchema = z.object({
  jobId: z.string(),
  agentName: z.string(),
  threadId: z.string(),
  runId: z.string(),
  status: z.string(),
});

/**
 * State schema for the async SubAgent middleware.
 *
 * Declares `asyncSubAgentJobs` as a reduced state channel so that individual
 * tool updates (launch, check, update, cancel, list) merge into the existing
 * jobs dict rather than replacing it wholesale.
 */
const AsyncSubAgentStateSchema = new StateSchema({
  asyncSubAgentJobs: new ReducedValue(
    z.record(z.string(), AsyncSubAgentJobSchema).default(() => ({})),
    {
      inputSchema: z.record(z.string(), AsyncSubAgentJobSchema).optional(),
      reducer: asyncSubAgentJobsReducer,
    },
  ),
});

/**
 * Reducer for the `asyncSubAgentJobs` state channel.
 *
 * Merges job updates into the existing jobs dict using shallow spread.
 * This allows individual tools to update a single job without overwriting
 * the full map — only the keys present in `update` are replaced.
 *
 * @param existing - The current jobs dict from state (may be undefined on first write).
 * @param update - New or updated job entries to merge in.
 * @returns Merged jobs dict.
 */
export function asyncSubAgentJobsReducer(
  existing?: Record<string, AsyncSubAgentJob>,
  update?: Record<string, AsyncSubAgentJob>,
): Record<string, AsyncSubAgentJob> {
  return { ...(existing || {}), ...(update || {}) };
}

/**
 * Description template for the `launch_async_subagent` tool.
 *
 * The `{available_agents}` placeholder is replaced at middleware creation
 * time with a formatted list of configured async SubAgent names and descriptions.
 */
const ASYNC_TASK_TOOL_DESCRIPTION = `Launch an async SubAgent on a remote LangGraph server. The SubAgent runs in the background and returns a job ID immediately.

Available async agent types:
{available_agents}

## Usage notes:
1. This tool launches a background job and returns immediately with a job ID. Report the job ID to the user and stop — do NOT immediately check status.
2. Use \`check_async_subagent\` only when the user asks for a status update or result.
3. Use \`update_async_subagent\` to send new instructions to a running job.
4. Multiple async SubAgents can run concurrently — launch several and let them run in the background.
5. The SubAgent runs on a remote LangGraph server, so it has its own tools and capabilities.`;

/**
 * Default system prompt appended to the main agent's system message when
 * async SubAgent middleware is active.
 *
 * Provides the agent with instructions on how to use the five async SubAgent
 * tools (launch, check, update, cancel, list) including workflow ordering,
 * critical rules about polling behavior, and guidance on when to use async
 * SubAgents vs. synchronous delegation.
 */
export const ASYNC_TASK_SYSTEM_PROMPT = `## Async SubAgents (remote LangGraph servers)

You have access to async SubAgent tools that launch background jobs on remote LangGraph servers.

### Tools:
- \`launch_async_subagent\`: Start a new background job. Returns a job ID immediately.
- \`check_async_subagent\`: Check the status of a running job. Returns status and result if complete.
- \`update_async_subagent\`: Send an update or new instructions to a running job.
- \`cancel_async_subagent\`: Cancel a running job that is no longer needed.
- \`list_async_subagent_jobs\`: List all tracked jobs with live statuses. Use this to check all jobs at once.

### Workflow:
1. **Launch** — Use \`launch_async_subagent\` to start a job. Report the job ID to the user and stop.
   Do NOT immediately check the status — the job runs in the background while you and the user continue other work.
2. **Check (on request)** — Only use \`check_async_subagent\` when the user explicitly asks for a status update or
   result. If the status is "running", report that and stop — do not poll in a loop.
3. **Update** (optional) — Use \`update_async_subagent\` to send new instructions to a running job. This interrupts
   the current run and starts a fresh one on the same thread. The job_id stays the same.
4. **Cancel** (optional) — Use \`cancel_async_subagent\` to stop a job that is no longer needed.
5. **Collect** — When \`check_async_subagent\` returns status "success", the result is included in the response.
6. **List** — Use \`list_async_subagent_jobs\` to see live statuses for all jobs at once, or to recall job IDs after context compaction.

### Critical rules:
- After launching, ALWAYS return control to the user immediately. Never auto-check after launching.
- Never poll \`check_async_subagent\` in a loop. Check once per user request, then stop.
- If a check returns "running", tell the user and wait for them to ask again.
- Job statuses in conversation history are ALWAYS stale — a job that was "running" may now be done.
  NEVER report a status from a previous tool result. ALWAYS call a tool to get the current status:
  use \`list_async_subagent_jobs\` when the user asks about multiple jobs or "all jobs",
  use \`check_async_subagent\` when the user asks about a specific job.
- Always show the full job_id — never truncate or abbreviate it.

### When to use async SubAgents:
- Long-running tasks that would block the main agent
- Tasks that benefit from running on specialized remote deployments
- When you want to run multiple tasks concurrently and collect results later`;

/**
 * Job statuses that will never change.
 *
 * When listing jobs, live-status fetches are skipped for jobs whose
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
 * Look up a tracked job from state by its `jobId`.
 *
 * @param jobId - The job ID to look up (will be trimmed).
 * @param state - The current agent state containing `asyncSubAgentJobs`.
 * @returns The tracked job on success, or an error string.
 */
function resolveTrackedJob(
  jobId: string,
  state: AsyncSubAgentState,
): AsyncSubAgentJob | string {
  const jobs = state.asyncSubAgentJobs ?? {};
  const tracked = jobs[jobId.trim()];
  if (!tracked) {
    return `No tracked job found for jobId: '${jobId}'`;
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
 * @param threadValues - The `values` from `ThreadState` (the remote SubAgent's state).
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
      checkResult.result =
        typeof last === "object" && last !== null && "content" in last
          ? String((last as Record<string, unknown>).content)
          : String(last);
    } else {
      checkResult.result = "Completed with no output messages.";
    }
  } else if (run.status === "error") {
    checkResult.error = "The async SubAgent encountered an error.";
  }

  return checkResult;
}

/**
 * Filter jobs by cached status from agent state.
 *
 * Filtering uses the cached status, not live server status. Live statuses
 * are fetched after filtering by the calling tool.
 *
 * @param jobs - All tracked jobs from state.
 * @param statusFilter - If nullish or `'all'`, return all jobs.
 *   Otherwise return only jobs whose cached status matches.
 */
function filterJobs(
  jobs: Record<string, AsyncSubAgentJob>,
  statusFilter?: string,
): AsyncSubAgentJob[] {
  if (!statusFilter || statusFilter === "all") {
    return Object.values(jobs);
  }
  return Object.values(jobs).filter((job) => job.status === statusFilter);
}

/**
 * Fetch the current run status from the server.
 *
 * Returns the cached status immediately for terminal jobs (avoiding
 * unnecessary API calls). Falls back to the cached status on SDK errors.
 */
async function fetchLiveJobStatus(
  clients: ClientCache,
  job: AsyncSubAgentJob,
): Promise<AsyncSubAgentStatus> {
  if (TERMINAL_STATUSES.has(job.status)) {
    return job.status;
  }

  try {
    const client = clients.getClient(job.agentName);
    const run = await client.runs.get(job.threadId, job.runId);
    return run.status as AsyncSubAgentStatus;
  } catch {
    return job.status;
  }
}

/**
 * Format a single job as a display string for list output.
 */
function formatJobEntry(
  job: AsyncSubAgentJob,
  status: AsyncSubAgentStatus,
): string {
  return `- jobId: ${job.jobId} agent: ${job.agentName} status: ${status}`;
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
 * Build the `launch_async_subagent` tool.
 *
 * Creates a thread on the remote server, starts a run, and returns a
 * `Command` that persists the new job in state.
 */
export function buildLaunchTool(
  agentMap: Record<string, AsyncSubAgent>,
  clients: ClientCache,
  toolDescription: string,
) {
  return tool(
    async (
      input: { description: string; agentName: string },
      config,
    ): Promise<Command | string> => {
      if (!(input.agentName in agentMap)) {
        const allowed = Object.keys(agentMap)
          .map((k) => `\`${k}\``)
          .join(", ");
        return `Unknown async SubAgent type \`${input.agentName}\`. Available types: ${allowed}`;
      }

      const spec = agentMap[input.agentName];
      try {
        const client = clients.getClient(input.agentName);
        const thread = await client.threads.create();
        const run = await client.runs.create(thread.thread_id, spec.graphId, {
          input: { messages: [{ role: "user", content: input.description }] },
        });

        const jobId = thread.thread_id;
        const job: AsyncSubAgentJob = {
          jobId,
          agentName: input.agentName,
          threadId: jobId,
          runId: run.run_id,
          status: "running",
        };

        return new Command({
          update: {
            messages: [
              new ToolMessage({
                content: `Launched async SubAgent. jobId: ${jobId}`,
                tool_call_id: config.toolCall?.id ?? "",
              }),
            ],
            asyncSubAgentJobs: { [jobId]: job },
          },
        });
      } catch (e) {
        return `Failed to launch async SubAgent '${input.agentName}': ${e}`;
      }
    },
    {
      name: "launch_async_subagent",
      description: toolDescription,
      schema: z.object({
        description: z
          .string()
          .describe(
            "A detailed description of the task for the async SubAgent to perform.",
          ),
        agentName: z
          .string()
          .describe(
            "The type of async SubAgent to use. Must be one of the available types listed in the tool description.",
          ),
      }),
    },
  );
}

/**
 * Build the `check_async_subagent` tool.
 *
 * Fetches the current run status from the remote server and, if the run
 * succeeded, retrieves the thread state to extract the result.
 */
export function buildCheckTool(clients: ClientCache) {
  return tool(
    async (input: { jobId: string }, config): Promise<Command | string> => {
      const state = getCurrentTaskInput<AsyncSubAgentState>();
      const job = resolveTrackedJob(input.jobId, state);
      if (typeof job === "string") return job;

      const client = clients.getClient(job.agentName);
      let run: Run;
      try {
        run = await client.runs.get(job.threadId, job.runId);
      } catch (e) {
        return `Failed to get run status: ${e}`;
      }

      let threadValues: DefaultValues = {};
      if (run.status === "success") {
        try {
          const threadState = await client.threads.getState(job.threadId);
          threadValues = (threadState.values as DefaultValues) || {};
        } catch {
          // Thread state fetch failed — still report success, just without the output
        }
      }

      const result = buildCheckResult(run, job.threadId, threadValues);
      const updatedJob: AsyncSubAgentJob = {
        jobId: job.jobId,
        agentName: job.agentName,
        threadId: job.threadId,
        runId: job.runId,
        status: result.status,
      };

      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: JSON.stringify(result),
              tool_call_id: config.toolCall?.id ?? "",
            }),
          ],
          asyncSubAgentJobs: { [job.jobId]: updatedJob },
        },
      });
    },
    {
      name: "check_async_subagent",
      description:
        "Check the status of an async SubAgent job. Returns the current status and, if complete, the result.",
      schema: z.object({
        jobId: z
          .string()
          .describe(
            "The exact jobId string returned by launch_async_subagent. Pass it verbatim.",
          ),
      }),
    },
  );
}

/**
 * Build the `update_async_subagent` tool.
 *
 * Sends a follow-up message to a running async SubAgent by creating a new
 * run on the same thread with `multitaskStrategy: "interrupt"`. The SubAgent
 * sees the full conversation history plus the new message. The `jobId`
 * remains the same; only the internal `runId` is updated.
 */
export function buildUpdateTool(
  agentMap: Record<string, AsyncSubAgent>,
  clients: ClientCache,
) {
  return tool(
    async (
      input: { jobId: string; message: string },
      config,
    ): Promise<Command | string> => {
      const state = getCurrentTaskInput<AsyncSubAgentState>();
      const tracked = resolveTrackedJob(input.jobId, state);
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

        const job: AsyncSubAgentJob = {
          jobId: tracked.jobId,
          agentName: tracked.agentName,
          threadId: tracked.threadId,
          runId: run.run_id,
          status: "running",
        };

        return new Command({
          update: {
            messages: [
              new ToolMessage({
                content: `Updated async SubAgent. jobId: ${tracked.jobId}`,
                tool_call_id: config.toolCall?.id ?? "",
              }),
            ],
            asyncSubAgentJobs: { [tracked.jobId]: job },
          },
        });
      } catch (e) {
        return `Failed to update async SubAgent: ${e}`;
      }
    },
    {
      name: "update_async_subagent",
      description:
        "send updated instructions to an async SubAgent. Interrupts the current run and starts a new one on the same thread so the SubAgent sees the full conversation history plus your new message. The jobId remains the same.",
      schema: z.object({
        jobId: z
          .string()
          .describe(
            "The exact jobId string returned by launch_async_subagent. Pass it verbatim.",
          ),
        message: z
          .string()
          .describe(
            "Follow-up instructions or context to send to the SubAgent",
          ),
      }),
    },
  );
}

/**
 * Build the `cancel_async_subagent` tool.
 *
 * Cancels the current run on the remote server and updates the job's
 * cached status to `"cancelled"`.
 */
export function buildCancelTool(clients: ClientCache) {
  return tool(
    async (input: { jobId: string }, config): Promise<Command | string> => {
      const state = getCurrentTaskInput<AsyncSubAgentState>();
      const tracked = resolveTrackedJob(input.jobId, state);
      if (typeof tracked === "string") return tracked;

      const client = clients.getClient(tracked.agentName);
      try {
        await client.runs.cancel(tracked.threadId, tracked.runId);
      } catch (e) {
        return `Failed to cancel run: ${e}`;
      }

      const updated: AsyncSubAgentJob = {
        jobId: tracked.jobId,
        agentName: tracked.agentName,
        threadId: tracked.threadId,
        runId: tracked.runId,
        status: "cancelled",
      };

      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: `Cancelled async SubAgent job: ${tracked.jobId}`,
              tool_call_id: config.toolCall?.id ?? "",
            }),
          ],
          asyncSubAgentJobs: { [tracked.jobId]: updated },
        },
      });
    },
    {
      name: "cancel_async_subagent",
      description:
        "Cancel a running async SubAgent job. Use this to stop a job that is no longer needed.",
      schema: z.object({
        jobId: z
          .string()
          .describe(
            "The exact jobId string returned by launch_async_subagent. Pass it verbatim.",
          ),
      }),
    },
  );
}

/**
 * Build the `list_async_subagent_jobs` tool.
 *
 * Lists all tracked jobs with their live statuses fetched in parallel.
 * Supports optional filtering by cached status.
 */
export function buildListTool(clients: ClientCache) {
  return tool(
    async (
      input: { statusFilter?: string },
      config,
    ): Promise<Command | string> => {
      const state = getCurrentTaskInput<AsyncSubAgentState>();
      const jobs = state.asyncSubAgentJobs ?? {};
      const filtered = filterJobs(jobs, input.statusFilter);

      if (filtered.length === 0) {
        return "No async SubAgent jobs tracked";
      }

      const statuses = await Promise.all(
        filtered.map((job) => fetchLiveJobStatus(clients, job)),
      );

      const updatedJobs: Record<string, AsyncSubAgentJob> = {};
      const entries: string[] = [];
      for (let idx = 0; idx < filtered.length; idx++) {
        const job = filtered[idx];
        const status = statuses[idx];

        const jobEntry = formatJobEntry(job, status);
        entries.push(jobEntry);

        updatedJobs[job.jobId] = {
          jobId: job.jobId,
          agentName: job.agentName,
          threadId: job.threadId,
          runId: job.runId,
          status,
        };
      }

      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: `${entries.length} tracked job(s):\n${entries.join("\n")}`,
              tool_call_id: config.toolCall?.id ?? "",
            }),
          ],
          asyncSubAgentJobs: updatedJobs,
        },
      });
    },
    {
      name: "list_async_subagent_jobs",
      description:
        "List tracked async SubAgent jobs with their current live statuses. Be default shows all jobs. Use `statusFilter` to narrow by status (e.g., 'running', 'success', 'error', 'cancelled'). Use `check_async_subagent` to get the full result of a specific completed job.",
      schema: z.object({
        statusFilter: z
          .string()
          .nullish()
          .describe(
            "Filter jobs by status. One of: 'running', 'success', 'error', 'cancelled', 'all'. Defaults to 'all'.",
          ),
      }),
    },
  );
}

/**
 * Options for creating async SubAgent middleware.
 */
export interface AsyncSubAgentMiddlewareOptions {
  /** List of async SubAgent specifications. Must have at least one. */
  asyncSubAgents: AsyncSubAgent[];
  /** System prompt override. Set to `null` to disable. Defaults to {@link ASYNC_TASK_SYSTEM_PROMPT}. */
  systemPrompt?: string;
}

/**
 * Create middleware that adds async SubAgent tools to an agent.
 *
 * Provides five tools for launching, checking, updating, cancelling, and
 * listing background jobs on remote LangGraph deployments. Job state is
 * persisted in the `asyncSubAgentJobs` state channel so it survives
 * context compaction.
 *
 * @throws {Error} If no async SubAgents are provided or names are duplicated.
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
    throw new Error("At least one async SubAgent must be specified");
  }

  const names = asyncSubAgents.map((a) => a.name);
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate async SubAgent names: ${[...new Set(duplicates)].join(", ")}`,
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
    ? `${systemPrompt}\n\nAvailable async SubAgent types:\n${agentsDescription}`
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
