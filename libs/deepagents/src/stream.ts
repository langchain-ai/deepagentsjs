/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Deep Agent streaming support (experimental).
 *
 * Provides:
 * - `DeepAgentRunStream` — type overlay that adds `.subagents` to the
 *   `AgentRunStream` shape
 * - `createSubagentTransformer` — a `__native` transformer whose
 *   projection (`subagents`) lands directly on the `GraphRunStream`
 *   instance via langgraph-core's native transformer support
 *
 * See protocol proposal §15 (In-Process Streaming Interface) and §16
 * (Native Stream Transformers).
 */

import {
  EventLog,
  ChatModelStreamImpl,
  type ProtocolEvent,
  type ToolCallStream,
  type ChatModelStream,
  type Namespace,
  type ToolsEventData,
  type MessagesEventData,
  type NativeStreamTransformer,
} from "@langchain/langgraph";

import type {
  AgentRunStream,
  MiddlewareEvent,
  ReactAgent,
  ToolCallStreamUnion,
} from "langchain";

import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { ToolMessage } from "@langchain/core/messages";

import type { AnySubAgent } from "./types.js";
import type { CompiledSubAgent } from "./middleware/subagents.js";

// ─── SubagentRunStream ────────────────────────────────────────────────────────

/**
 * Represents a single subagent invocation observed during a deep agent run.
 *
 * @typeParam TOutput - The subagent's output state type. Defaults to
 *   `unknown`; inferred to the subagent's `MergedAgentState` for
 *   `CompiledSubAgent` via {@link SubagentRunStreamUnion}.
 */
export interface SubagentRunStream<
  TOutput = unknown,
  TTools extends readonly (ClientTool | ServerTool)[] = readonly (
    | ClientTool
    | ServerTool
  )[],
> {
  readonly name: string;
  readonly taskInput: Promise<string>;
  readonly output: Promise<TOutput>;
  readonly messages: AsyncIterable<ChatModelStream>;
  readonly toolCalls: AsyncIterable<ToolCallStreamUnion<TTools>>;
  readonly middleware: AsyncIterable<MiddlewareEvent>;
  readonly subagents: AsyncIterable<SubagentRunStream>;
}

// ─── Type helpers for discriminated union narrowing ───────────────────────────

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

// ─── DeepAgentRunStream ───────────────────────────────────────────────────────

/**
 * An {@link AgentRunStream} with native deep-agent projections assigned
 * directly on the instance by `createGraphRunStream` (via `__native`
 * transformers).
 *
 * This is a pure type overlay — no runtime class exists.  The
 * `subagents` property is populated at runtime by the
 * `createSubagentTransformer` registered at compile time.
 */
export type DeepAgentRunStream<
  TValues = Record<string, unknown>,
  TTools extends readonly (ClientTool | ServerTool)[] = readonly (
    | ClientTool
    | ServerTool
  )[],
  TSubagents extends readonly AnySubAgent[] = readonly AnySubAgent[],
> = AgentRunStream<TValues, TTools> & {
  /** Subagent invocation streams from the native SubagentTransformer. */
  subagents: AsyncIterable<SubagentRunStreamUnion<TSubagents>>;
};

// ─── SubagentTransformer ──────────────────────────────────────────────────────

function hasPrefix(ns: Namespace, prefix: Namespace): boolean {
  if (prefix.length > ns.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (ns[i] !== prefix[i]) return false;
  }
  return true;
}

interface SubagentProjection {
  subagents: AsyncIterable<SubagentRunStream>;
}

/**
 * Native transformer that correlates `task` tool calls into
 * {@link SubagentRunStream} objects and routes child-namespace
 * `tools` and `messages` events into per-subagent channels.
 *
 * Marked `__native: true` — the `subagents` projection key lands
 * directly on the `GraphRunStream` instance as `run.subagents`.
 */
export function createSubagentTransformer(
  path: Namespace,
): () => NativeStreamTransformer<SubagentProjection> {
  return () => {
    const subagentsLog = new EventLog<SubagentRunStream>();

    const pendingByCallId = new Map<
      string,
      {
        name: string;
        resolveTaskInput: (v: string) => void;
        resolveOutput: (v: unknown) => void;
        rejectOutput: (e: unknown) => void;
      }
    >();

    const subagentsByName = new Map<
      string,
      {
        messagesLog: EventLog<ChatModelStream>;
        toolCallsLog: EventLog<ToolCallStream<string, unknown, ToolMessage>>;
        middlewareLog: EventLog<MiddlewareEvent>;
        nestedSubagentsLog: EventLog<SubagentRunStream>;
      }
    >();

    /** Maps tools-node namespace segment to subagent name. */
    const toolsNodeToName = new Map<string, string>();

    const childToolCalls = new Map<
      string,
      {
        resolveOutput: (v: unknown) => void;
        rejectOutput: (e: unknown) => void;
        resolveStatus: (v: "running" | "finished" | "error") => void;
        resolveError: (v: string | undefined) => void;
      }
    >();

    /** Active ChatModelStreamImpl per subagent (keyed by subagent name). */
    const activeMessages = new Map<string, ChatModelStreamImpl>();

    function getOrCreateSubagentLogs(name: string) {
      let logs = subagentsByName.get(name);
      if (!logs) {
        logs = {
          messagesLog: new EventLog<ChatModelStream>(),
          toolCallsLog: new EventLog<
            ToolCallStream<string, unknown, ToolMessage>
          >(),
          middlewareLog: new EventLog<MiddlewareEvent>(),
          nestedSubagentsLog: new EventLog<SubagentRunStream>(),
        };
        subagentsByName.set(name, logs);
      }
      return logs;
    }

    return {
      __native: true as const,

      init: () => ({
        subagents: subagentsLog.toAsyncIterable(),
      }),

      process(event: ProtocolEvent): boolean {
        if (!hasPrefix(event.params.namespace, path)) return true;

        const ns = event.params.namespace;
        const depth = ns.length - path.length;

        // ── Root-level task tool events (depth 0-1: agent's own graph) ──
        if (depth <= 1 && event.method === "tools") {
          const data = event.params.data as ToolsEventData;
          const toolCallId = (data as Record<string, unknown>)
            .tool_call_id as string;
          const toolName = (data as Record<string, unknown>)
            .tool_name as string;

          if (toolName === "task" && data.event === "tool-started") {
            const rawInput = (data as Record<string, unknown>).input;
            const input: { description?: string; subagent_type?: string } =
              typeof rawInput === "string"
                ? JSON.parse(rawInput)
                : ((rawInput as any) ?? {});

            const subagentName = input.subagent_type ?? "unknown";
            const taskDescription = input.description ?? "";

            let resolveTaskInput!: (v: string) => void;
            let resolveOutput!: (v: unknown) => void;
            let rejectOutput!: (e: unknown) => void;

            const taskInput = new Promise<string>((res) => {
              resolveTaskInput = res;
            });
            const output = new Promise<unknown>((res, rej) => {
              resolveOutput = res;
              rejectOutput = rej;
            });

            pendingByCallId.set(toolCallId, {
              name: subagentName,
              resolveTaskInput,
              resolveOutput,
              rejectOutput,
            });

            resolveTaskInput(taskDescription);

            if (depth === 1) {
              toolsNodeToName.set(ns[path.length], subagentName);
            }

            const logs = getOrCreateSubagentLogs(subagentName);

            subagentsLog.push({
              name: subagentName,
              taskInput,
              output,
              messages: logs.messagesLog.toAsyncIterable(),
              toolCalls: logs.toolCallsLog.toAsyncIterable(),
              middleware: logs.middlewareLog.toAsyncIterable(),
              subagents: logs.nestedSubagentsLog.toAsyncIterable(),
            });
          }

          if (toolName === "task" && toolCallId) {
            const pending = pendingByCallId.get(toolCallId);
            if (pending) {
              if (data.event === "tool-finished") {
                pending.resolveOutput((data as Record<string, unknown>).output);
                pendingByCallId.delete(toolCallId);
              } else if (data.event === "tool-error") {
                const message =
                  ((data as Record<string, unknown>).message as string) ??
                  "unknown error";
                pending.rejectOutput(new Error(message));
                pendingByCallId.delete(toolCallId);
              }
            }
          }
        }

        // ── Child namespace events → route into per-subagent channels ──
        if (depth >= 2) {
          const parentSegment = ns[path.length];
          const subagentName = toolsNodeToName.get(parentSegment);
          const logs = subagentName
            ? subagentsByName.get(subagentName)
            : undefined;

          if (logs && subagentName) {
            // ── Route tools events ──
            if (event.method === "tools") {
              const data = event.params.data as ToolsEventData;
              const toolCallId = (data as Record<string, unknown>)
                .tool_call_id as string;
              const toolName = (data as Record<string, unknown>)
                .tool_name as string;

              if (data.event === "tool-started") {
                let resolveOutput!: (v: unknown) => void;
                let rejectOutput!: (e: unknown) => void;
                let resolveStatus!: (
                  v: "running" | "finished" | "error",
                ) => void;
                let resolveError!: (v: string | undefined) => void;

                const output = new Promise<unknown>((res, rej) => {
                  resolveOutput = res;
                  rejectOutput = rej;
                });
                const status = new Promise<"running" | "finished" | "error">(
                  (res) => {
                    resolveStatus = res;
                  },
                );
                const error = new Promise<string | undefined>((res) => {
                  resolveError = res;
                });

                childToolCalls.set(toolCallId, {
                  resolveOutput,
                  rejectOutput,
                  resolveStatus,
                  resolveError,
                });
                const rawInput = (data as Record<string, unknown>).input;
                const parsedInput =
                  typeof rawInput === "string"
                    ? JSON.parse(rawInput)
                    : rawInput;

                logs.toolCallsLog.push({
                  name: toolName ?? "unknown",
                  callId: toolCallId,
                  input: parsedInput,
                  output: output as Promise<ToolMessage>,
                  status,
                  error,
                });
              }

              const pending = toolCallId
                ? childToolCalls.get(toolCallId)
                : undefined;
              if (pending) {
                if (data.event === "tool-finished") {
                  pending.resolveOutput(
                    (data as Record<string, unknown>).output,
                  );
                  pending.resolveStatus("finished");
                  pending.resolveError(undefined);
                  childToolCalls.delete(toolCallId);
                } else if (data.event === "tool-error") {
                  const message =
                    ((data as Record<string, unknown>).message as string) ??
                    "unknown error";
                  pending.rejectOutput(new Error(message));
                  pending.resolveStatus("error");
                  pending.resolveError(message);
                  childToolCalls.delete(toolCallId);
                }
              }
            }

            // ── Route messages events into ChatModelStreamImpl ──
            if (event.method === "messages") {
              const data = event.params.data as MessagesEventData;

              if (data.event === "message-start") {
                const stream = new ChatModelStreamImpl(ns, event.params.node);
                stream.pushEvent(data);
                activeMessages.set(subagentName, stream);
                logs.messagesLog.push(stream);
              } else if (data.event === "message-finish") {
                const stream = activeMessages.get(subagentName);
                if (stream) {
                  stream.finish(
                    data as MessagesEventData & { event: "message-finish" },
                  );
                  activeMessages.delete(subagentName);
                }
              } else {
                const stream = activeMessages.get(subagentName);
                stream?.pushEvent(data);
              }
            }
          }
        }

        return true;
      },

      finalize(): void {
        for (const pending of pendingByCallId.values()) {
          pending.resolveOutput(undefined);
        }
        pendingByCallId.clear();
        for (const pending of childToolCalls.values()) {
          pending.resolveOutput(undefined);
          pending.resolveStatus("finished");
          pending.resolveError(undefined);
        }
        childToolCalls.clear();
        for (const stream of activeMessages.values()) {
          stream.fail(new Error("run finalized before message completed"));
        }
        activeMessages.clear();
        subagentsLog.close();
        for (const logs of subagentsByName.values()) {
          logs.toolCallsLog.close();
          logs.messagesLog.close();
          logs.middlewareLog.close();
          logs.nestedSubagentsLog.close();
        }
      },

      fail(err: unknown): void {
        for (const pending of pendingByCallId.values()) {
          pending.rejectOutput(err);
        }
        pendingByCallId.clear();
        for (const pending of childToolCalls.values()) {
          pending.rejectOutput(err);
          pending.resolveStatus("error");
          pending.resolveError(
            // oxlint-disable-next-line no-instanceof/no-instanceof
            err instanceof Error ? err.message : String(err),
          );
        }
        childToolCalls.clear();
        for (const stream of activeMessages.values()) {
          stream.fail(err);
        }
        activeMessages.clear();
        subagentsLog.fail(err);
        for (const logs of subagentsByName.values()) {
          logs.toolCallsLog.fail(err);
          logs.messagesLog.fail(err);
          logs.middlewareLog.fail(err);
          logs.nestedSubagentsLog.fail(err);
        }
      },
    };
  };
}
