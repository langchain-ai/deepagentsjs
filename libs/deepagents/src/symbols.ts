import type { ReactAgent } from "langchain";
import type { Runnable } from "@langchain/core/runnables";

/**
 * Map of subagent type name to its compiled graph.
 */
type SubagentGraphs = Record<string, ReactAgent<any> | Runnable>;

/**
 * Factory function that compiles a subagent graph, optionally constrained
 * by a `responseFormat` for structured output. Called with no arguments
 * to produce the default graph; called with a JSON Schema to produce a
 * variant that enforces that schema on the model's output.
 */
export type SubagentFactory = (
  responseFormat?: unknown,
) => ReactAgent<any> | Runnable;

/** Map of subagent type name to its factory function. */
type SubagentFactories = Record<string, SubagentFactory>;

/**
 * Callback that receives compiled subagent graphs and optional factory
 * functions. Registered by middleware that needs access to subagent graphs
 * at runtime (e.g., the QuickJS middleware for swarm dispatch).
 */
type SubagentGraphInjector = (
  graphs: SubagentGraphs,
  factories?: SubagentFactories,
) => void;

/**
 * Symbol key for storing compiled subagent graphs on a middleware object.
 */
const SUBAGENT_GRAPHS_KEY = Symbol.for("deepagents.subagent.graphs");

/**
 * Symbol key for storing subagent factory functions on a middleware object.
 */
const SUBAGENT_FACTORIES_KEY = Symbol.for("deepagents.subagent.factories");

/**
 * Symbol key for storing the graph injector callback on a middleware object.
 */
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
 * Attach subagent factory functions to a middleware object.
 * Called by `createSubAgentMiddleware` alongside `setSubagentGraphs`.
 */
export function setSubagentFactories(
  middleware: object,
  factories: SubagentFactories,
): void {
  (middleware as any)[SUBAGENT_FACTORIES_KEY] = factories;
}

/**
 * Read subagent factory functions previously attached to a middleware object.
 */
export function getSubagentFactories(
  middleware: object,
): SubagentFactories | undefined {
  return (middleware as any)[SUBAGENT_FACTORIES_KEY];
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

