/**
 * Deep Agent streaming support (experimental).
 *
 * Provides `DeepAgentRunStream` — a type overlay that narrows the `subagents`
 * projection on langchain's `AgentRunStream` to the deep agent's declared
 * subagents, so consumers can discriminate on `sub.name` and get typed
 * `sub.output` / `sub.toolCalls`.
 *
 * Subagents are surfaced at runtime by the `SubagentTransformer` that
 * `createAgent` registers (langchain#37739): each nested named agent binds its
 * own `lc_agent_name` (deep-agent subagents are compiled via
 * `createAgent({ name })`), so they appear on `run.subagents` automatically.
 * Deep agents therefore no longer ships its own subagent transformer.
 */

import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { AgentRunStream, ReactAgent, SubagentRunStream } from "langchain";

import type { AnySubAgent } from "./types.js";
import type { CompiledSubAgent } from "./middleware/subagents.js";

/**
 * A single nested named-agent run surfaced on `run.subagents`. Re-exported
 * from `langchain` (langchain#37739) for convenience — deep agents no longer
 * defines its own variant.
 */
export type { SubagentRunStream } from "langchain";

/**
 * Extract the output state type from a subagent spec.
 * For `CompiledSubAgent<ReactAgent<Types>>`, resolves to the agent's
 * invoke return type. Falls back to `unknown` for `SubAgent` and
 * `AsyncSubAgent`.
 */
export type SubagentOutputOf<T extends AnySubAgent> =
  T extends CompiledSubAgent<infer R>
    ? R extends ReactAgent<infer Types>
      ? Awaited<ReturnType<ReactAgent<Types>["invoke"]>>
      : unknown
    : unknown;

/**
 * Extract the tools tuple from a subagent spec.
 * For `CompiledSubAgent<ReactAgent<Types>>`, resolves to `Types["Tools"]`.
 * Falls back to the default `(ClientTool | ServerTool)[]` for `SubAgent`
 * and `AsyncSubAgent`.
 */
export type SubagentToolsOf<T extends AnySubAgent> =
  T extends CompiledSubAgent<infer R>
    ? R extends ReactAgent<infer Types>
      ? Types["Tools"]
      : readonly (ClientTool | ServerTool)[]
    : readonly (ClientTool | ServerTool)[];

/**
 * A typed `SubagentRunStream` variant for a single subagent spec.
 * Narrows `.name` to the literal string type, `.output` to the
 * inferred state type, and `.toolCalls` to the subagent's tools
 * when available.
 */
export type NamedSubagentRunStream<T extends AnySubAgent> = T extends {
  name: infer N extends string;
}
  ? SubagentRunStream<SubagentOutputOf<T>, SubagentToolsOf<T>> & {
      readonly name: N;
    }
  : SubagentRunStream;

/**
 * Discriminated union of {@link SubagentRunStream} variants, one per
 * subagent in `TSubagents`. Enables TypeScript to narrow `.output`
 * when the consumer checks `sub.name === "someSubagentName"`.
 */
export type SubagentRunStreamUnion<TSubagents extends readonly AnySubAgent[]> =
  {
    [K in keyof TSubagents]: NamedSubagentRunStream<TSubagents[K]>;
  }[number];

/**
 * An {@link AgentRunStream} whose `subagents` projection is narrowed to the
 * deep agent's declared subagents.
 *
 * This is a pure type overlay — no runtime class exists. The `subagents`
 * iterable is populated by the `SubagentTransformer` that `createAgent`
 * registers (langchain#37739); this overlay only refines its element type from
 * the generic `SubagentRunStream` to the typed {@link SubagentRunStreamUnion}.
 */
export type DeepAgentRunStream<
  TValues = Record<string, unknown>,
  TTools extends readonly (ClientTool | ServerTool)[] = readonly (
    | ClientTool
    | ServerTool
  )[],
  TSubagents extends readonly AnySubAgent[] = readonly AnySubAgent[],
  TExtensions extends Record<string, unknown> = Record<string, unknown>,
> = Omit<AgentRunStream<TValues, TTools, TExtensions>, "subagents"> & {
  /** Declared-subagent invocation streams from `createAgent`'s transformer. */
  subagents: AsyncIterable<SubagentRunStreamUnion<TSubagents>>;
};
