/**
 * Completion notifier middleware for async subagents.
 *
 * **Experimental** — this middleware is experimental and may change in future releases.
 *
 * When an async subagent finishes (success or error), this middleware sends a
 * message back to the **supervisor's** thread so the supervisor wakes up and can
 * proactively relay results to the user — without the user having to poll via
 * `check_async_task`.
 *
 * ## Architecture
 *
 * The async subagent protocol is inherently fire-and-forget: the supervisor
 * launches a job via `start_async_task` and only learns about completion
 * when someone calls `check_async_task`. This middleware closes that gap.
 *
 * ```
 * Supervisor                    Subagent
 *     |                            |
 *     |--- start_async_task -----> |
 *     |<-- task_id (immediately) - |
 *     |                            |  (working...)
 *     |                            |  (done!)
 *     |                            |
 *     |<-- runs.create(            |
 *     |      supervisor_thread,    |
 *     |      "completed: ...")     |
 *     |                            |
 *     |  (wakes up, sees result)   |
 * ```
 *
 * The notifier calls `runs.create()` on the supervisor's thread, which
 * queues a new run. From the supervisor's perspective, it looks like a new
 * user message arrived — except the content is a structured notification
 * from the subagent.
 *
 * ## How parent context is propagated
 *
 * - `parentGraphId` is passed as a **constructor argument** to the middleware.
 *   This is the supervisor's graph ID (or assistant ID), which the subagent
 *   developer knows at configuration time.
 * - `url` is the URL of the LangGraph server where the supervisor is deployed.
 *   This is required since JS does not support in-process ASGI transport.
 * - `headers` are optional additional headers for authenticating with the
 *   supervisor's server.
 * - `parent_thread_id` is injected into the subagent's input state by the
 *   supervisor's `start_async_task` tool. It survives thread interrupts and
 *   updates because it lives in state, not config.
 * - If `parent_thread_id` is not present in state, the notifier silently no-ops.
 *
 * ## Usage
 *
 * ```typescript
 * import { createCompletionNotifierMiddleware } from "deepagents";
 *
 * const notifier = createCompletionNotifierMiddleware({
 *   parentGraphId: "supervisor",
 *   url: "https://my-deployment.langsmith.dev",
 * });
 *
 * const agent = createDeepAgent({
 *   model: "claude-sonnet-4-5-20250929",
 *   middleware: [notifier],
 * });
 * ```
 *
 * The middleware will read `parent_thread_id` from the agent's state at the
 * end of execution. This is injected automatically by the supervisor's
 * `start_async_task` tool when it creates the run.
 *
 * @module
 */

import { z } from "zod/v4";
import {
  createMiddleware,
  /**
   * required for type inference
   */
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { Client } from "@langchain/langgraph-sdk";
import type { BaseMessage } from "@langchain/core/messages";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** State key where the supervisor's launch tool stores the parent thread ID. */
const PARENT_THREAD_ID_KEY = "parent_thread_id";

/** Maximum characters to include from the last message in notifications. */
const MAX_SUMMARY_LENGTH = 500;

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

/**
 * State extension for subagents that use the completion notifier.
 *
 * These fields are injected by the supervisor's `start_async_task`
 * tool and read by the completion notifier middleware to send notifications
 * back to the supervisor's thread.
 */
const CompletionNotifierStateSchema = z.object({
  /** The supervisor's thread ID. Used to address the notification. */
  parent_thread_id: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for creating the completion notifier middleware.
 */
export interface CompletionNotifierOptions {
  /**
   * The supervisor's graph ID (or assistant ID). Used as the `assistant_id`
   * parameter when calling `runs.create()` to send notifications back to the
   * supervisor.
   */
  parentGraphId: string;

  /**
   * URL of the supervisor's LangGraph server (e.g.,
   * `"https://my-deployment.langsmith.dev"`).
   *
   * Required — JS does not support in-process ASGI transport like Python.
   */
  url: string;

  /**
   * Additional headers to include in requests to the supervisor's server.
   */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build headers for the supervisor's LangGraph server.
 *
 * Ensures `x-auth-scheme: langsmith` is present unless explicitly overridden.
 */
function resolveHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const resolved: Record<string, string> = { ...headers };
  if (!("x-auth-scheme" in resolved)) {
    resolved["x-auth-scheme"] = "langsmith";
  }
  return resolved;
}

/**
 * Send a notification run to the parent supervisor's thread.
 */
export async function notifyParent(
  parentThreadId: string,
  parentGraphId: string,
  notification: string,
  options: {
    url: string;
    headers?: Record<string, string>;
  },
): Promise<void> {
  try {
    const client = new Client({
      apiUrl: options.url,
      apiKey: null,
      defaultHeaders: resolveHeaders(options.headers),
    });
    await client.runs.create(parentThreadId, parentGraphId, {
      input: {
        messages: [{ role: "user", content: notification }],
      },
    });
  } catch (e) {
    // Swallow errors — the notification is best-effort.
    // Log a warning so operators can debug connectivity issues.
    // eslint-disable-next-line no-console
    console.warn(
      `[CompletionNotifierMiddleware] Failed to notify parent thread ${parentThreadId}:`,
      e,
    );
  }
}

/**
 * Extract a summary from the subagent's final message.
 *
 * Returns at most 500 characters from the last message's content.
 */
export function extractLastMessage(state: Record<string, unknown>): string {
  const messages = state.messages as BaseMessage[] | undefined;
  if (!messages || messages.length === 0) {
    return "(no output)";
  }

  const last = messages[messages.length - 1];

  // BaseMessage or dict-like message with .content
  if (last && typeof last === "object" && "content" in last) {
    const content = (last as BaseMessage | Record<string, unknown>).content;
    if (typeof content === "string") {
      return content.slice(0, MAX_SUMMARY_LENGTH);
    }
    // Handle array content blocks (e.g., multi-modal messages)
    return JSON.stringify(content).slice(0, MAX_SUMMARY_LENGTH);
  }

  return String(last).slice(0, MAX_SUMMARY_LENGTH);
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create a completion notifier middleware for async subagents.
 *
 * **Experimental** — this middleware is experimental and may change.
 *
 * This middleware is added to the **subagent's** middleware stack (not the
 * supervisor's). When the subagent finishes, it sends a message to the
 * supervisor's thread via `runs.create()`, waking the supervisor so it can
 * proactively relay results.
 *
 * The supervisor's `parent_thread_id` is read from the subagent's own state
 * (injected by the supervisor's `start_async_task` tool at launch time).
 * The `parentGraphId` is provided as a constructor argument since it's static
 * configuration known at deployment time.
 *
 * If `parent_thread_id` is not present in state (e.g., the subagent was
 * launched manually without a supervisor), the middleware silently does
 * nothing.
 *
 * @param options - Configuration options.
 * @returns An `AgentMiddleware` instance.
 *
 * @example
 * ```typescript
 * import { createCompletionNotifierMiddleware } from "deepagents";
 *
 * const notifier = createCompletionNotifierMiddleware({
 *   parentGraphId: "supervisor",
 *   url: "https://my-deployment.langsmith.dev",
 * });
 *
 * const agent = createDeepAgent({
 *   model: "claude-sonnet-4-5-20250929",
 *   middleware: [notifier],
 * });
 * ```
 */
export function createCompletionNotifierMiddleware(
  options: CompletionNotifierOptions,
) {
  const { parentGraphId, url, headers } = options;

  // Guard against duplicate notifications within a single run.
  let notified = false;

  /**
   * Check whether we should send a notification.
   */
  function shouldNotify(state: Record<string, unknown>): boolean {
    if (notified) return false;
    return Boolean(state[PARENT_THREAD_ID_KEY]);
  }

  /**
   * Send a notification to the parent if conditions are met.
   */
  async function sendNotification(
    state: Record<string, unknown>,
    message: string,
  ): Promise<void> {
    if (!shouldNotify(state)) return;
    notified = true;
    await notifyParent(
      state[PARENT_THREAD_ID_KEY] as string,
      parentGraphId,
      message,
      { url, headers },
    );
  }

  /**
   * Read the subagent's own thread_id from runtime config.
   *
   * The subagent's `thread_id` is the same as the `task_id` from the
   * supervisor's perspective.
   */
  function getTaskId(
    runtime: { configurable?: { thread_id?: string } } | undefined,
  ): string | undefined {
    return runtime?.configurable?.thread_id;
  }

  /**
   * Build a notification string with task_id prefix.
   */
  function formatNotification(
    body: string,
    runtime: { configurable?: { thread_id?: string } } | undefined,
  ): string {
    const taskId = getTaskId(runtime);
    const prefix = taskId ? `[task_id=${taskId}]` : "";
    return `${prefix}${body}`;
  }

  return createMiddleware({
    name: "CompletionNotifierMiddleware",
    stateSchema: CompletionNotifierStateSchema,

    /**
     * After-agent hook: fires when the subagent completes successfully.
     *
     * Extracts the last message as a summary and sends it to the supervisor.
     */
    async afterAgent(state, runtime) {
      const summary = extractLastMessage(state);
      const notification = formatNotification(
        `Completed. Result: ${summary}`,
        runtime,
      );
      await sendNotification(state, notification);
      return undefined;
    },

    /**
     * Wrap model calls to catch errors and notify the supervisor.
     *
     * If a model call raises an exception, the error is reported to the
     * supervisor before re-raising so the supervisor can inform the user.
     */
    async wrapModelCall(request, handler) {
      try {
        return await handler(request);
      } catch (e) {
        const notification = formatNotification(
          // eslint-disable-next-line no-instanceof/no-instanceof
          `Error: ${e instanceof Error ? e.message : String(e)}`,
          request.runtime,
        );
        await sendNotification(request.state, notification);
        throw e;
      }
    },
  });
}
