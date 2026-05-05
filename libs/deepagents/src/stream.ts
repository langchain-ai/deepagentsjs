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
  ChatModelStreamImpl,
  StreamChannel,
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
  ReactAgent,
  ToolCallStreamUnion,
} from "langchain";

import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { ToolMessage } from "@langchain/core/messages";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";

import type { AnySubAgent } from "./types.js";
import type { CompiledSubAgent } from "./middleware/subagents.js";

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
  readonly subagents: AsyncIterable<SubagentRunStream>;
}

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
  TExtensions extends Record<string, unknown> = Record<string, unknown>,
> = AgentRunStream<TValues, TTools, TExtensions> & {
  /** Subagent invocation streams from the native SubagentTransformer. */
  subagents: AsyncIterable<SubagentRunStreamUnion<TSubagents>>;
};

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

interface PendingSubagent {
  name: string;
  callId: string;
  resolveTaskInput: (v: string) => void;
  resolveOutput: (v: unknown) => void;
  rejectOutput: (e: unknown) => void;
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
    const subagentsLog = StreamChannel.local<SubagentRunStream>();
    const pendingByCallId = new Map<string, PendingSubagent>();
    const pendingByNamespaceSegment = new Map<string, PendingSubagent>();
    const latestValuesByNamespaceSegment = new Map<string, unknown>();

    const subagentsByName = new Map<
      string,
      {
        messagesLog: StreamChannel<ChatModelStream>;
        toolCallsLog: StreamChannel<
          ToolCallStream<string, unknown, ToolMessage>
        >;
        nestedSubagentsLog: StreamChannel<SubagentRunStream>;
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
    const activeMessages = new Map<
      string,
      {
        stream: ChatModelStreamImpl;
        eventsLog: StreamChannel<ChatModelStreamEvent>;
      }
    >();

    function deletePendingSubagent(pending: PendingSubagent): void {
      pendingByCallId.delete(pending.callId);
      for (const [segment, entry] of pendingByNamespaceSegment) {
        if (entry === pending) {
          pendingByNamespaceSegment.delete(segment);
          latestValuesByNamespaceSegment.delete(segment);
        }
      }
    }

    function subagentSegment(ns: Namespace): string | undefined {
      return ns.length === path.length + 1 ? ns[path.length] : undefined;
    }

    function getOrCreateSubagentLogs(name: string) {
      let logs = subagentsByName.get(name);
      if (!logs) {
        logs = {
          messagesLog: StreamChannel.local<ChatModelStream>(),
          toolCallsLog:
            StreamChannel.local<ToolCallStream<string, unknown, ToolMessage>>(),
          nestedSubagentsLog: StreamChannel.local<SubagentRunStream>(),
        };
        subagentsByName.set(name, logs);
      }
      return logs;
    }

    return {
      __native: true as const,

      init: () => ({
        subagents: subagentsLog,
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

            const pending: PendingSubagent = {
              name: subagentName,
              callId: toolCallId,
              resolveTaskInput,
              resolveOutput,
              rejectOutput,
            };

            if (toolCallId) {
              pendingByCallId.set(toolCallId, pending);
            }

            resolveTaskInput(taskDescription);

            if (depth === 1) {
              toolsNodeToName.set(ns[path.length], subagentName);
              pendingByNamespaceSegment.set(ns[path.length], pending);
            }
            if (toolCallId) {
              const taskSegment = `tools:${toolCallId}`;
              toolsNodeToName.set(taskSegment, subagentName);
              pendingByNamespaceSegment.set(taskSegment, pending);
            }

            const logs = getOrCreateSubagentLogs(subagentName);

            subagentsLog.push({
              name: subagentName,
              taskInput,
              output,
              messages: logs.messagesLog,
              toolCalls: logs.toolCallsLog,
              subagents: logs.nestedSubagentsLog,
            });
          }

          if (toolName === "task" && toolCallId) {
            const pending = pendingByCallId.get(toolCallId);
            if (pending) {
              if (data.event === "tool-finished") {
                pending.resolveOutput((data as Record<string, unknown>).output);
                deletePendingSubagent(pending);
              } else if (data.event === "tool-error") {
                const message =
                  ((data as Record<string, unknown>).message as string) ??
                  "unknown error";
                pending.rejectOutput(new Error(message));
                deletePendingSubagent(pending);
              }
            }
          }
        }

        const segment = subagentSegment(ns);
        const pending = segment
          ? pendingByNamespaceSegment.get(segment)
          : undefined;
        if (pending) {
          if (event.method === "values") {
            latestValuesByNamespaceSegment.set(segment!, event.params.data);
          } else if (event.method === "lifecycle") {
            const data = event.params.data as { event?: string };
            if (data.event === "completed" || data.event === "interrupted") {
              pending.resolveOutput(
                latestValuesByNamespaceSegment.get(segment!),
              );
              deletePendingSubagent(pending);
            } else if (data.event === "failed") {
              pending.rejectOutput(
                new Error(`Subagent ${pending.name} failed`),
              );
              deletePendingSubagent(pending);
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
                const eventsLog = StreamChannel.local<ChatModelStreamEvent>();
                const stream = new ChatModelStreamImpl(eventsLog);
                eventsLog.push(data as ChatModelStreamEvent);
                activeMessages.set(subagentName, { stream, eventsLog });
                logs.messagesLog.push(stream as unknown as ChatModelStream);
              } else if (data.event === "message-finish") {
                const active = activeMessages.get(subagentName);
                if (active) {
                  active.eventsLog.push(data as ChatModelStreamEvent);
                  active.eventsLog.close();
                  activeMessages.delete(subagentName);
                }
              } else {
                const active = activeMessages.get(subagentName);
                active?.eventsLog.push(data as ChatModelStreamEvent);
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
        for (const active of activeMessages.values()) {
          active.eventsLog.fail(
            new Error("run finalized before message completed"),
          );
        }
        activeMessages.clear();
        subagentsLog.close();
        for (const logs of subagentsByName.values()) {
          logs.toolCallsLog.close();
          logs.messagesLog.close();
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
        for (const active of activeMessages.values()) {
          active.eventsLog.fail(err);
        }
        activeMessages.clear();
        subagentsLog.fail(err);
        for (const logs of subagentsByName.values()) {
          logs.toolCallsLog.fail(err);
          logs.messagesLog.fail(err);
          logs.nestedSubagentsLog.fail(err);
        }
      },
    };
  };
}
