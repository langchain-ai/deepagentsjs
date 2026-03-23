/**
 * Middleware that consumes pending queued messages before each model call.
 *
 * When deployed on LangGraph Platform, users can send messages while the agent is
 * already running (double-texting). By default these are enqueued as separate
 * pending runs. This middleware runs as a `beforeModel` hook -- before each LLM
 * call it checks for pending runs on the current thread, extracts their input
 * messages, cancels the pending runs, and returns them as a state update so they
 * are persisted (checkpointed) before the model sees them.
 *
 * When running inside the LangGraph Platform server, the SDK client can use
 * in-process transport to talk to the server directly -- no HTTP round-trips
 * leave the process.
 *
 * @example
 * ```typescript
 * import { createDeepAgent } from "deepagents";
 * import { createQueueLookaheadMiddleware } from "deepagents";
 *
 * const agent = createDeepAgent({
 *   model: "claude-sonnet-4-6",
 *   middleware: [createQueueLookaheadMiddleware()],
 * });
 * ```
 *
 * @module
 */

import {
  createMiddleware,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { getConfig } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { Client, type Run } from "@langchain/langgraph-sdk";

type CancelAction = "interrupt" | "rollback";

// TODO(hntrl): fix the `Run` type in @langchain/langgraph-sdk to include
// `kwargs` when selected (or expose a generic `Run<Fields>` helper).
export type RunWithKwargs = Run & {
  kwargs?: {
    input?: {
      messages?: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

/**
 * Options for creating the queue lookahead middleware.
 */
export interface QueueLookaheadMiddlewareOptions {
  /**
   * A LangGraph SDK client. If not provided, one is created via
   * `new Client()` from `@langchain/langgraph-sdk`.
   */
  client?: InstanceType<typeof Client>;

  /**
   * How to cancel consumed pending runs.
   * @default "interrupt"
   */
  cancelAction?: CancelAction;
}

/**
 * Extract input messages from a pending run's kwargs.
 *
 * @param run - A run (with kwargs selected) returned by the LangGraph SDK.
 * @returns List of message dicts from the run's input, or empty array if none found.
 */
export function extractMessagesFromRun(
  run: RunWithKwargs,
): Array<Record<string, unknown>> {
  const kwargs = run.kwargs;
  if (!kwargs) return [];

  const runInput = kwargs.input;
  if (!runInput || typeof runInput !== "object") return [];

  const messages = runInput.messages;
  if (!Array.isArray(messages)) return [];

  return messages;
}

/**
 * Convert raw message dicts from pending runs into HumanMessage objects.
 *
 * Only includes messages with role "user" or "human". Other message types
 * from pending runs are dropped since injecting AI or system messages
 * mid-conversation would be confusing.
 *
 * @param rawMessages - List of message dicts (e.g., `{ role: "user", content: "..." }`).
 * @returns List of HumanMessage objects.
 */
export function convertToHumanMessages(
  rawMessages: Array<Record<string, unknown>>,
): HumanMessage[] {
  const result: HumanMessage[] = [];
  for (const msg of rawMessages) {
    const role = (msg.role as string) || "";
    const content = (msg.content as string) || "";
    if ((role === "user" || role === "human") && content) {
      result.push(new HumanMessage({ content }));
    }
  }
  return result;
}

/**
 * Extract thread_id from the current LangGraph config context.
 *
 * Uses `@langchain/langgraph`'s `getConfig()` to access the current
 * configurable context within a running graph.
 *
 * @returns The thread_id string, or undefined if not available.
 */
export function getThreadId(): string | undefined {
  try {
    const config = getConfig();
    const threadId = config?.configurable?.thread_id;
    if (threadId != null) {
      return String(threadId);
    }
  } catch {
    // getConfig() throws if not called within a graph context
  }
  return undefined;
}

/**
 * Create middleware that consumes pending queued messages before each model call.
 *
 * When the agent is deployed on LangGraph Platform with `multitask_strategy="enqueue"`,
 * user messages sent during an active run are queued as pending runs on the
 * thread. This middleware uses `beforeModel` to check for those pending runs
 * before each LLM invocation, extract the user messages, cancel the pending
 * runs, and return them as a state update. Because `beforeModel` writes to
 * state, the injected messages are checkpointed and survive crashes.
 *
 * @param options - Configuration options
 * @returns AgentMiddleware that drains pending queued messages
 *
 * @example
 * ```typescript
 * import { createAgent } from "langchain";
 * import { createQueueLookaheadMiddleware } from "deepagents";
 *
 * const agent = createAgent({
 *   model: "claude-sonnet-4-20250514",
 *   middleware: [createQueueLookaheadMiddleware()],
 * });
 * ```
 */
export function createQueueLookaheadMiddleware(
  options: QueueLookaheadMiddlewareOptions = {},
) {
  const { cancelAction = "interrupt" } = options;
  let resolvedClient: InstanceType<typeof Client> | undefined = options.client;

  /**
   * Lazily resolve the SDK client.
   */
  function getClient(): InstanceType<typeof Client> {
    if (!resolvedClient) {
      resolvedClient = new Client();
    }
    return resolvedClient;
  }

  /**
   * Fetch and cancel all pending runs, returning their user messages.
   */
  async function drainPending(threadId: string): Promise<HumanMessage[]> {
    const client = getClient();
    let pendingRuns: RunWithKwargs[];
    try {
      pendingRuns = (await client.runs.list(threadId, {
        status: "pending",
        select: ["run_id", "kwargs"],
      })) as RunWithKwargs[];
    } catch {
      // eslint-disable-next-line no-console
      console.warn("Failed to list pending runs");
      return [];
    }

    if (!pendingRuns || pendingRuns.length === 0) {
      return [];
    }

    const messages: HumanMessage[] = [];
    for (const run of pendingRuns) {
      const raw = extractMessagesFromRun(run);
      messages.push(...convertToHumanMessages(raw));

      try {
        await client.runs.cancel(threadId, run.run_id, false, cancelAction);
      } catch {
        // eslint-disable-next-line no-console
        console.warn(`Failed to cancel pending run ${run.run_id}`);
      }
    }

    return messages;
  }

  return createMiddleware({
    name: "QueueLookaheadMiddleware",

    async beforeModel() {
      const threadId = getThreadId();
      if (!threadId) {
        return undefined;
      }

      const pendingMessages = await drainPending(threadId);
      if (pendingMessages.length === 0) {
        return undefined;
      }

      return { messages: pendingMessages };
    },
  });
}
