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
    currentConfig()?.signal?.aborted === true ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

/** The current config, or `undefined` outside a graph run. */
function currentConfig(): LangGraphRunnableConfig | undefined {
  try {
    return getConfig();
  } catch {
    return undefined;
  }
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
    const config = currentConfig();
    // Graphs nested in this run (e.g. a sync subagent that's a deep agent) inherit its config,
    // parent reference included; only the top-level graph reports, so the parent gets this agent's answer.
    if (!config || !launchingAgent(config) || !isTopLevelGraph(config)) return;
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
        // Interrupts pause the run rather than fail it. A cancelled, replaced or
        // timed-out run aborts its signal; that isn't the subagent failing, and the
        // parent learns about it from the run's status instead.
        if (!isGraphBubbleUp(e) && !wasAborted(e, request.runtime.signal)) {
          await report("error", { error: failureText(e) });
        }
        throw e;
      }
    },
  });
}
