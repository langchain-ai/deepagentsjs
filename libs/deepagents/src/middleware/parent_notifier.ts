import { getConfig, isGraphBubbleUp } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { createMiddleware } from "langchain";

import {
  currentRunId,
  failureText,
  finalContent,
  launchingAgent,
  notifyParent,
  taskEvent,
} from "./async_subagents.js";

/** Runs remembered as reported; bounded so long-lived processes don't grow without limit. */
const MAX_REPORTED_RUNS = 1000;

/** Whether this is the outermost graph of a task run, not a graph nested in it. */
function isTopLevelGraph(config: LangGraphRunnableConfig): boolean {
  const configurable = (config.configurable ?? {}) as Record<string, unknown>;
  return !String(configurable.checkpoint_ns ?? "").includes("|");
}

/** Whether `error` comes from the run being aborted rather than from the subagent failing. */
function wasAborted(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    getConfig()?.signal?.aborted === true ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

/**
 * Wake the agent that started this run with `start_async_task`, when the run ends.
 *
 * `createDeepAgent` attaches it to every deep agent. It does nothing unless the
 * run carries the parent reference, and skips nested runs.
 */
export function createParentNotifierMiddleware() {
  const reported = new Set<string>();

  /**
   * Notify once per run, for this graph's own run that an async subagent tool started.
   *
   * The run's context comes from its config: hooks only see the context fields
   * a middleware's `contextSchema` declares, and this one declares none.
   */
  async function report(
    status: "success" | "error",
    details: Parameters<typeof taskEvent>[3],
  ): Promise<void> {
    const config = getConfig();
    // Nested graphs (e.g. a deep agent as a sync subagent) inherit the parent reference; only the top-level graph reports.
    if (!launchingAgent(config) || !isTopLevelGraph(config)) return;
    const runKey = currentRunId(config);
    if (runKey === undefined || reported.has(runKey)) return;
    reported.add(runKey);
    if (reported.size > MAX_REPORTED_RUNS) {
      reported.delete(reported.values().next().value as string);
    }
    const metadata = (config.metadata ?? {}) as Record<string, unknown>;
    const configurable = (config.configurable ?? {}) as Record<string, unknown>;
    const name = String(
      metadata.subagent_name ??
        metadata.graph_id ??
        configurable.graph_id ??
        "subagent",
    );
    await notifyParent(
      config,
      taskEvent(config, name, status, details),
      config.context,
    );
  }

  return createMiddleware({
    name: "parentNotifierMiddleware",
    afterAgent: async (state) => {
      await report("success", { result: finalContent(state) });
    },
    wrapModelCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (e) {
        // Interrupts pause the run, and an aborted run (cancelled, replaced, timed out)
        // reaches the parent through its run status; neither is a failure.
        if (!isGraphBubbleUp(e) && !wasAborted(e, request.runtime.signal)) {
          await report("error", { error: failureText(e) });
        }
        throw e;
      }
    },
  });
}
