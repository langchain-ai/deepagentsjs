/**
 * Thread state helpers backed by the graph checkpointer.
 *
 * Implements the LangGraph SDK thread state wire-shape consumed by
 * `client.threads.getState` / `updateState` (`GET|POST /threads/:id/state`) and
 * `getHistory` (`POST /threads/:id/history`), aligned with the Agent Protocol
 * thread model.
 */

import type { MemorySaver } from "@langchain/langgraph";
import type { CompiledGraphType } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";

import { isRecord, sanitizeForJson } from "./serialize";

/**
 * Compiled LangGraph instance exposed through the custom protocol server.
 *
 * Thread routes read and write checkpointed state through this graph's
 * checkpointer rather than maintaining a separate thread store.
 */
export type LocalProtocolGraph = CompiledGraphType;

type StateSnapshot = Awaited<ReturnType<LocalProtocolGraph["getState"]>>;

/**
 * Raised when a thread has no checkpoint yet.
 *
 * The route handlers map this to HTTP 404 so the LangGraph SDK can bootstrap
 * the thread via `POST /threads/:id/state` before the first run.
 */
export class ThreadNotFoundError extends Error {
  readonly threadId: string;

  constructor(threadId: string) {
    super(`Thread ${threadId} not found`);
    this.name = "ThreadNotFoundError";
    this.threadId = threadId;
  }
}

/**
 * Graph node used when bootstrapping an empty thread.
 *
 * Empty `messages` updates must land on `__start__` so conditional edges are
 * not evaluated before the first human turn exists.
 */
const INITIAL_UPDATE_NODE = "__start__";

/**
 * Default graph node for non-empty state updates on an existing checkpoint.
 *
 * Matches the agent's model node when the client omits `as_node`.
 */
const DEFAULT_UPDATE_NODE = "model_request";

/** Build the {@link RunnableConfig} that scopes graph calls to a thread id. */
function threadConfig(threadId: string): RunnableConfig {
  return { configurable: { thread_id: threadId } };
}

/**
 * Build the config passed to `getStateHistory` for root or subgraph-scoped
 * history, matching langgraph-api's `{ thread_id, checkpoint_ns: "", ...checkpoint }`.
 */
function historyConfig(
  threadId: string,
  checkpoint?: Record<string, unknown> | null
): RunnableConfig {
  const configurable: Record<string, unknown> = {
    thread_id: threadId,
    checkpoint_ns: "",
  };
  if (checkpoint && isRecord(checkpoint)) {
    Object.assign(configurable, checkpoint);
  }
  return { configurable };
}

/** Read the `configurable` bag from a LangGraph run config. */
function configurableOf(config: RunnableConfig): Record<string, unknown> {
  return isRecord(config.configurable) ? config.configurable : {};
}

/**
 * Return whether a {@link StateSnapshot} represents a persisted checkpoint.
 *
 * LangGraph returns an empty configurable bag before the first write; the SDK
 * treats that as "thread not found" rather than an empty thread state.
 */
function threadHasCheckpoint(snapshot: StateSnapshot): boolean {
  const checkpointId = configurableOf(snapshot.config).checkpoint_id;
  return typeof checkpointId === "string" && checkpointId.length > 0;
}

function isStateSnapshot(state: unknown): state is StateSnapshot {
  return isRecord(state) && "values" in state && "next" in state;
}

function serializeTaskError(error: unknown): string | null {
  if (error == null) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** Map a LangGraph run config to the SDK checkpoint wire shape. */
function runnableConfigToCheckpoint(
  config: RunnableConfig | null | undefined,
  fallbackThreadId?: string
): Record<string, unknown> | null {
  if (!config || !isRecord(config.configurable)) return null;
  const c = config.configurable;
  const thread_id =
    typeof c.thread_id === "string" ? c.thread_id : fallbackThreadId;
  if (!thread_id || typeof c.checkpoint_id !== "string") return null;

  return {
    thread_id,
    checkpoint_id: c.checkpoint_id,
    checkpoint_ns: typeof c.checkpoint_ns === "string" ? c.checkpoint_ns : "",
    checkpoint_map: isRecord(c.checkpoint_map) ? c.checkpoint_map : null,
  };
}

function taskCheckpointFromState(
  state: unknown
): Record<string, unknown> | null {
  if (state == null || !isRecord(state) || !isRecord(state.configurable)) {
    return null;
  }
  const c = state.configurable;
  if (typeof c.thread_id !== "string") return null;
  return {
    thread_id: c.thread_id,
    checkpoint_id:
      typeof c.checkpoint_id === "string" ? c.checkpoint_id : null,
    checkpoint_ns: typeof c.checkpoint_ns === "string" ? c.checkpoint_ns : "",
    checkpoint_map: isRecord(c.checkpoint_map) ? c.checkpoint_map : null,
  };
}

/**
 * Serialize a LangGraph {@link StateSnapshot} to the SDK `ThreadState` shape.
 *
 * Aligned with langgraph-api's `stateSnapshotToThreadState`, plus
 * {@link sanitizeForJson} on `values` and nested task `result` payloads.
 */
export function serializeThreadState(
  snapshot: StateSnapshot,
  threadId: string
): Record<string, unknown> {
  const configurable = configurableOf(snapshot.config);
  const checkpoint = runnableConfigToCheckpoint(snapshot.config, threadId) ?? {
    thread_id: threadId,
    checkpoint_id:
      typeof configurable.checkpoint_id === "string"
        ? configurable.checkpoint_id
        : null,
    checkpoint_ns:
      typeof configurable.checkpoint_ns === "string"
        ? configurable.checkpoint_ns
        : "",
    checkpoint_map: null,
  };

  const tasks = (snapshot.tasks ?? []).map((task) => {
    const record = task as {
      id?: unknown;
      name?: unknown;
      error?: unknown;
      interrupts?: unknown;
      path?: unknown;
      result?: unknown;
      state?: unknown;
    };
    return {
      id: record.id,
      name: record.name,
      error: serializeTaskError(record.error),
      interrupts: Array.isArray(record.interrupts) ? record.interrupts : [],
      path: record.path ?? null,
      checkpoint: taskCheckpointFromState(record.state),
      state:
        record.state != null && isStateSnapshot(record.state)
          ? serializeThreadState(record.state, threadId)
          : null,
      result:
        record.result != null ? sanitizeForJson(record.result) : null,
    };
  });

  const parentConfig = (snapshot as { parentConfig?: RunnableConfig })
    .parentConfig;

  return {
    values: sanitizeForJson(snapshot.values ?? {}),
    next: [...(snapshot.next ?? [])],
    tasks,
    checkpoint,
    metadata: { ...snapshot.metadata },
    created_at: snapshot.createdAt ?? null,
    parent_checkpoint: runnableConfigToCheckpoint(parentConfig, threadId),
  };
}

/** Summary of a thread for the history sidebar. */
export type ThreadSummary = {
  id: string;
  title: string;
  updatedAt: string | null;
};

const UNTITLED = "New conversation";

/** Derive a sidebar title from the first human message in a thread. */
function deriveTitle(values: unknown): string {
  if (!isRecord(values) || !Array.isArray(values.messages)) return UNTITLED;
  for (const message of values.messages) {
    if (!isRecord(message) || message.type !== "human") continue;
    const { content } = message;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((block) =>
                isRecord(block) && typeof block.text === "string"
                  ? block.text
                  : ""
              )
              .join("")
          : "";
    const trimmed = text.trim();
    if (trimmed) return trimmed.slice(0, 80);
  }
  return UNTITLED;
}

/**
 * List every thread known to the checkpointer, newest first.
 *
 * The checkpointer is the single source of truth: thread ids are the top-level
 * keys of {@link MemorySaver.storage}, and each thread's title/timestamp is
 * derived from its latest checkpoint. Restarting the server clears all of this.
 */
export async function listThreads(
  graph: LocalProtocolGraph,
  checkpointer: MemorySaver
): Promise<ThreadSummary[]> {
  const ids = Object.keys(checkpointer.storage);
  const summaries: ThreadSummary[] = [];
  for (const id of ids) {
    try {
      const state = await getThreadState(graph, id);
      summaries.push({
        id,
        title: deriveTitle(state.values),
        updatedAt:
          typeof state.created_at === "string" ? state.created_at : null,
      });
    } catch {
      // Skip threads without a readable checkpoint.
    }
  }
  summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return summaries;
}

/**
 * Read checkpointed thread state for `GET /threads/:threadId/state`.
 *
 * @throws {@link ThreadNotFoundError} When the thread has no checkpoint yet.
 */
export async function getThreadState(
  graph: LocalProtocolGraph,
  threadId: string
): Promise<Record<string, unknown>> {
  const snapshot = await graph.getState(threadConfig(threadId));
  if (!threadHasCheckpoint(snapshot)) throw new ThreadNotFoundError(threadId);
  return serializeThreadState(snapshot, threadId);
}

/**
 * Parse the `before` pagination cursor accepted by `POST /threads/:id/history`.
 */
function parseBeforeCursor(
  threadId: string,
  before: unknown
): RunnableConfig | undefined {
  if (before == null) return undefined;
  if (typeof before === "string") {
    return { configurable: { thread_id: threadId, checkpoint_id: before } };
  }
  if (!isRecord(before)) return undefined;

  if (isRecord(before.configurable)) {
    return {
      configurable: { thread_id: threadId, ...before.configurable },
    };
  }

  const checkpointId = before.checkpoint_id;
  if (typeof checkpointId !== "string") return undefined;

  const cursor: RunnableConfig = {
    configurable: { thread_id: threadId, checkpoint_id: checkpointId },
  };
  if (typeof before.checkpoint_ns === "string") {
    (cursor.configurable as Record<string, unknown>).checkpoint_ns =
      before.checkpoint_ns;
  }
  return cursor;
}

/**
 * List past thread states for `POST /threads/:threadId/history`.
 *
 * @throws {@link ThreadNotFoundError} When the thread has no checkpoint yet.
 */
export async function getThreadHistory(
  graph: LocalProtocolGraph,
  threadId: string,
  options: {
    limit?: number;
    before?: unknown;
    metadata?: Record<string, unknown>;
    checkpoint?: Record<string, unknown> | null;
  } = {}
): Promise<Record<string, unknown>[]> {
  await getThreadState(graph, threadId);

  const history: Record<string, unknown>[] = [];
  const iterator = graph.getStateHistory(historyConfig(threadId, options.checkpoint), {
    before: parseBeforeCursor(threadId, options.before),
    limit: options.limit ?? 10,
    ...(options.metadata ? { filter: options.metadata } : {}),
  });
  for await (const snapshot of iterator) {
    history.push(serializeThreadState(snapshot, threadId));
  }
  return history;
}

/** Choose which graph node should receive an `updateState` write. */
function resolveUpdateNode(options: {
  asNode?: string;
  values: Record<string, unknown> | null;
  hasCheckpoint: boolean;
}): string {
  if (options.asNode) return options.asNode;
  const messages = options.values?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return INITIAL_UPDATE_NODE;
  }
  if (!options.hasCheckpoint) return INITIAL_UPDATE_NODE;
  return DEFAULT_UPDATE_NODE;
}

/**
 * Create or update thread state for `POST /threads/:threadId/state`.
 *
 * Used by the browser bootstrap and by the SDK when hydrating or editing
 * conversation history. Applies the update at {@link resolveUpdateNode}, then
 * returns the latest serialized snapshot.
 */
export async function updateThreadState(
  graph: LocalProtocolGraph,
  threadId: string,
  options: {
    values?: Record<string, unknown> | null;
    checkpoint?: Record<string, unknown> | null;
    asNode?: string;
  } = {}
): Promise<Record<string, unknown>> {
  let config = threadConfig(threadId);
  const checkpoint = options.checkpoint;
  if (checkpoint && typeof checkpoint.checkpoint_id === "string") {
    config = {
      configurable: {
        ...configurableOf(config),
        checkpoint_id: checkpoint.checkpoint_id,
        ...(typeof checkpoint.checkpoint_ns === "string"
          ? { checkpoint_ns: checkpoint.checkpoint_ns }
          : {}),
      },
    };
  }

  const snapshot = await graph.getState(config);
  const resolvedValues = options.values ?? { messages: [] };
  const resolvedAsNode = resolveUpdateNode({
    asNode: options.asNode,
    values: resolvedValues,
    hasCheckpoint: threadHasCheckpoint(snapshot),
  });

  await graph.updateState(config, resolvedValues, resolvedAsNode);
  const updated = await graph.getState(threadConfig(threadId));
  return serializeThreadState(updated, threadId);
}
