import type { ReactAgent } from "langchain";
import type { Runnable } from "@langchain/core/runnables";

type SubagentGraphs = Record<string, ReactAgent<any> | Runnable>;
type SubagentGraphInjector = (graphs: SubagentGraphs) => void;

const SUBAGENT_GRAPHS_KEY = Symbol.for("deepagents.subagent.graphs");
const SUBAGENT_GRAPH_INJECTOR_KEY = Symbol.for(
  "deepagents.subagent.graphInjector",
);

/**
 * Attach compiled subagent graphs to a middleware object.
 * Called by `createSubAgentMiddleware` so the graphs can be shared
 * with other consumers (e.g., the QuickJS REPL) without recompilation.
 */
export function setSubagentGraphs(
  middleware: object,
  graphs: SubagentGraphs,
): void {
  (middleware as any)[SUBAGENT_GRAPHS_KEY] = graphs;
}

/**
 * Read compiled subagent graphs previously attached to a middleware object.
 * Called by `createDeepAgent` to retrieve graphs from `subagentMiddleware`
 * and forward them to any middleware that registered an injector.
 */
export function getSubagentGraphs(
  middleware: object,
): SubagentGraphs | undefined {
  return (middleware as any)[SUBAGENT_GRAPHS_KEY];
}

/**
 * Register a subagent graph injector on a middleware object.
 * Called by middleware that needs compiled subagent graphs at runtime
 * (e.g., QuickJS middleware registers this so `createDeepAgent` can
 * push graphs into it without a direct import dependency).
 */
export function setSubagentGraphInjector(
  middleware: object,
  injector: SubagentGraphInjector,
): void {
  (middleware as any)[SUBAGENT_GRAPH_INJECTOR_KEY] = injector;
}

/**
 * Retrieve the subagent graph injector registered on a middleware object,
 * or `undefined` if the middleware does not accept graph injection.
 * Called by `createDeepAgent` when iterating over `customMiddleware`.
 */
export function getSubagentGraphInjector(
  middleware: object,
): SubagentGraphInjector | undefined {
  return (middleware as any)[SUBAGENT_GRAPH_INJECTOR_KEY];
}
