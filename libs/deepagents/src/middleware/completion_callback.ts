/**
 * Callback middleware for async subagents.
 *
 * @experimental - this middleware is experimental and may change in future releases.
 *
 * This middleware sends a notification to a callback thread when a subagent
 * completes successfully or raises an error. The callback agent can then
 * process that notification instead of relying only on polling via
 * `check_async_task`.
 *
 * ## Architecture
 *
 * A parent agent launches a subagent with `start_async_task` and can later
 * inspect task state with `check_async_task`. This middleware adds an optional
 * completion signal by creating a run on the callback thread when the subagent
 * finishes.
 *
 * ```
 * Parent                        Subagent
 *     |                            |
 *     |--- start_async_task -----> |
 *     |<-- task_id (immediately) - |
 *     |                            |  (working...)
 *     |                            |  (done!)
 *     |                            |
 *     |<-- runs.create(            |
 *     |      callback_thread,      |
 *     |      "completed: ...")     |
 *     |                            |
 *     |  (processes result)        |
 * ```
 *
 * The middleware calls `runs.create()` on the callback thread. From the
 * callback agent's perspective, this appears as a new user message containing
 * structured output from the subagent.
 *
 * ## Callback context
 *
 * - `callbackGraphId` identifies the callback graph or assistant. It is
 *   provided when the middleware is constructed.
 * - `url` and `headers` optionally configure a remote callback destination.
 *   Omit `url` for same-deployment ASGI transport.
 * - `callback_thread_id` is stored in the subagent state by the parent's
 *   `start_async_task` tool. Because it is stored in state rather than config,
 *   it survives thread updates and interrupts.
 * - If `callback_thread_id` is not present in state, the middleware does
 *   nothing.
 *
 * ## Usage
 *
 * ```typescript
 * import { createCompletionCallbackMiddleware } from "deepagents";
 *
 * // Same deployment (callback agent and subagent share a server):
 * const notifier = createCompletionCallbackMiddleware({
 *   callbackGraphId: "supervisor",
 * });
 *
 * // Remote deployment (callback destination on a different server):
 * const notifier = createCompletionCallbackMiddleware({
 *   callbackGraphId: "supervisor",
 *   url: "https://my-deployment.langsmith.dev",
 * });
 *
 * const agent = createDeepAgent({
 *   model,
 *   middleware: [notifier],
 * });
 * ```
 *
 * The middleware reads `callbackThreadId` from the agent state at the end of
 * execution. This value is injected by the parent's `start_async_task` tool
 * when it creates the run.
 *
 * @module
 */

import * as z from "zod";
import {
  createMiddleware,
  /**
   * required for type inference
   */
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { Client } from "@langchain/langgraph-sdk";
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

/** Maximum characters to include from the last message in notifications. */
const MAX_MESSAGE_LENGTH = 500;

/** Suffix appended when truncating long messages. */
const TRUNCATION_SUFFIX = "... [full result truncated]";

/** State key for the callback thread ID. */
const CALLBACK_THREAD_ID_KEY = "callbackThreadId" as const;

/**
 * State extension for subagents that use completion callbacks.
 *
 * @experimental - this state schema is experimental and may change in future releases.
 *
 * `callbackThreadId` is written by the parent's `start_async_task` tool
 * and read by `CompletionCallbackMiddleware` when sending callback
 * notifications.
 */
const CompletionCallbackStateSchema = z.object({
  /** The callback thread ID. Used to address the notification. */
  [CALLBACK_THREAD_ID_KEY]: z.string().optional(),
});

/**
 * Options for creating the completion callback middleware.
 */
export interface CompletionCallbackOptions {
  /**
   * Callback graph or assistant identifier. Used as the `assistant_id`
   * argument in `runs.create()`.
   */
  callbackGraphId: string;

  /**
   * URL of the callback LangGraph server. Omit to use same-deployment
   * ASGI transport.
   */
  url?: string;

  /**
   * Additional headers to include in requests to the callback server.
   */
  headers?: Record<string, string>;
}

/**
 * Build headers for the callback LangGraph server.
 *
 * Ensures `x-auth-scheme: langsmith` is present unless explicitly overridden.
 */
export function resolveHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const resolved: Record<string, string> = { ...headers };
  if (!("x-auth-scheme" in resolved)) {
    resolved["x-auth-scheme"] = "langsmith";
  }
  return resolved;
}

/**
 * Send a notification run to the callback thread.
 *
 * @param callbackGraphId - The callback graph ID used as `assistant_id`
 *   in the `runs.create` call.
 * @param callbackThreadId - The callback thread ID.
 * @param message - The message content to send.
 * @param options - Optional url and headers for the callback server.
 */
export async function notifyParent(
  callbackGraphId: string,
  callbackThreadId: string,
  message: string,
  options?: {
    url?: string;
    headers?: Record<string, string>;
  },
): Promise<void> {
  try {
    const client = new Client({
      apiUrl: options?.url ?? undefined,
      apiKey: null,
      defaultHeaders: resolveHeaders(options?.headers),
    });
    await client.runs.create(callbackThreadId, callbackGraphId, {
      input: {
        messages: [{ role: "user", content: message }],
      },
    });
  } catch (e) {
    // Swallow errors — the notification is best-effort.
    // Log a warning so operators can debug connectivity issues.
    // oxlint-disable-next-line no-console
    console.warn(
      `[CompletionCallbackMiddleware] Failed to notify callback thread ${callbackThreadId}:`,
      e,
    );
  }
}

/**
 * Extract a summary from the subagent's final message.
 *
 * Returns at most 500 characters from the last message's content.
 * Throws if no messages exist or if the last message is not an AIMessage.
 *
 * @param state - The agent state dict.
 * @param taskId - Optional task ID to include in truncation hint.
 */
export function extractLastMessage(
  state: Record<string, unknown>,
  taskId?: string,
): string {
  const messages = state.messages as BaseMessage[] | undefined;
  if (!messages || messages.length === 0) {
    throw new Error(
      `Expected at least one message in state ${JSON.stringify(state)}`,
    );
  }

  const last = messages[messages.length - 1];

  if (!AIMessage.isInstance(last)) {
    throw new TypeError(
      `Expected an AIMessage, got ${typeof last === "object" && last !== null ? (last.constructor?.name ?? typeof last) : typeof last} instead`,
    );
  }

  let textContent = last.text;
  if (textContent.length > MAX_MESSAGE_LENGTH) {
    textContent = textContent.slice(0, MAX_MESSAGE_LENGTH) + TRUNCATION_SUFFIX;
    if (taskId) {
      textContent += ` Result truncated. Use \`check_async_task(task_id='${taskId}')\` to retrieve the full result if needed.`;
    }
  }

  return textContent;
}

/**
 * Create a completion callback middleware for async subagents.
 *
 * **Experimental** — this middleware is experimental and may change.
 *
 * This middleware is added to a subagent's middleware stack. On success or
 * model-call error, it sends a notification to the configured callback
 * thread by calling `runs.create()`.
 *
 * The callback destination is configured with `callbackGraphId` and
 * optional `url` and `headers`. The target thread is read from
 * `callbackThreadId` in the subagent state.
 *
 * If `callbackThreadId` is not present in state, the middleware does
 * nothing.
 *
 * @param options - Configuration options.
 * @returns An `AgentMiddleware` instance.
 *
 * @example
 * ```typescript
 * import { createCompletionCallbackMiddleware } from "deepagents";
 *
 * const notifier = createCompletionCallbackMiddleware({
 *   callbackGraphId: "supervisor",
 * });
 *
 * const agent = createDeepAgent({
 *   model: "claude-sonnet-4-5-20250929",
 *   middleware: [notifier],
 * });
 * ```
 */
export function createCompletionCallbackMiddleware(
  options: CompletionCallbackOptions,
) {
  const { callbackGraphId, url, headers } = options;

  /**
   * Send a notification to the callback destination.
   */
  async function sendNotification(
    callbackThreadId: string,
    message: string,
  ): Promise<void> {
    await notifyParent(callbackGraphId, callbackThreadId, message, {
      url,
      headers,
    });
  }

  /**
   * Read the subagent's own thread_id from runtime config.
   *
   * The subagent's `thread_id` is the same as the `task_id` from the
   * parent's perspective.
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
    name: "CompletionCallbackMiddleware",
    stateSchema: CompletionCallbackStateSchema,

    /**
     * After-agent hook: fires when the subagent completes successfully.
     *
     * Extracts the last message as a summary and sends it to the callback
     * thread.
     */
    async afterAgent(state, runtime) {
      const callbackThreadId = state[CALLBACK_THREAD_ID_KEY] as string;
      // If callbackThreadId is not present, this will be undefined/falsy.
      // Python raises KeyError here; we match that behavior.
      if (callbackThreadId == null) {
        throw new Error(
          `Missing required state key '${CALLBACK_THREAD_ID_KEY}'`,
        );
      }
      const taskId = getTaskId(runtime);
      const summary = extractLastMessage(
        state,
        typeof taskId === "string" ? taskId : undefined,
      );
      const notification = formatNotification(
        `Completed. Result: ${summary}`,
        runtime,
      );
      await sendNotification(callbackThreadId, notification);
      return undefined;
    },

    /**
     * Wrap model calls to catch errors and notify the callback thread.
     *
     * If a model call raises an exception, a generic error message is
     * reported to the callback thread before re-raising. The actual error
     * details are not leaked to the callback agent.
     */
    async wrapModelCall(request, handler) {
      try {
        return await handler(request);
      } catch (e) {
        const callbackThreadId = request.state[
          CALLBACK_THREAD_ID_KEY
        ] as string;
        if (typeof callbackThreadId === "string") {
          const notification = formatNotification(
            "The agent encountered an error while calling the model.",
            request.runtime,
          );
          await sendNotification(callbackThreadId, notification);
        }
        throw e;
      }
    },
  });
}
