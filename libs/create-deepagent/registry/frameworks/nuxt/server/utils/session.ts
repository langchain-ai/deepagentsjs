import type { ReactAgent } from "langchain";
// `StreamChannel` buffers events; `matchesSubscription` is the shared protocol
// predicate from `@langchain/langgraph/stream` — the same one langgraph-api
// uses, so this custom transport stays aligned with the production server.
import {
  StreamChannel,
  matchesSubscription,
  type ProtocolEvent,
} from "@langchain/langgraph/stream";
import type {
  Command,
  CommandResponse,
  ErrorResponse,
  SubscribeParams,
} from "@langchain/protocol";

import { isRecord, sanitizeForJson } from "./serialize";

// `ReactAgent<any>` accepts both `createAgent` results and `DeepAgent`
// instances (which carry a specific, non-default type config).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReactAgent = ReactAgent<any>;

type AgentRunInput = Parameters<AnyReactAgent["streamEvents"]>[0];

/**
 * Make an event safe to `JSON.stringify` onto the SSE wire.
 *
 * Only the protocol payload (`params.data`) and any `params.interrupts` can
 * carry LangChain message instances, so those are the fields we sanitize into
 * the plain, role-keyed protocol message shape the SDK expects.
 */
function sanitizeEvent(event: ProtocolEvent): ProtocolEvent {
  const params = event.params as Record<string, unknown>;
  const sanitizedParams: Record<string, unknown> = {
    ...params,
    data: sanitizeForJson(params.data),
  };
  if ("interrupts" in params) {
    sanitizedParams.interrupts = sanitizeForJson(params.interrupts);
  }
  return { ...event, params: sanitizedParams } as ProtocolEvent;
}

/**
 * Encode an Agent Protocol event as a Server-Sent Event frame.
 *
 * When available, `event_id` is mirrored into the SSE `id:` field for
 * transport-level reconnection. The SDK primarily deduplicates by `event_id`
 * and replays by `seq`; if an event has no `event_id`, this example falls back
 * to `seq` as a stable frame id.
 */
function encodeSse(event: ProtocolEvent) {
  const eventId = (event as { event_id?: string }).event_id;
  const id = eventId ?? (typeof event.seq === "number" ? `${event.seq}` : "");
  const idLine = id ? `id: ${id}\n` : "";
  return new TextEncoder().encode(
    `${idLine}event: message\ndata: ${JSON.stringify(event)}\n\n`
  );
}

/**
 * Minimal in-memory Agent Streaming Protocol session for the example.
 *
 * This class is the server-side counterpart to `HttpAgentServerAdapter`:
 *
 * - `POST /threads/:thread_id/commands` sends a JSON `Command` and receives a
 *   `CommandResponse` or `ErrorResponse`.
 * - `POST /threads/:thread_id/stream` opens a connection-scoped SSE
 *   subscription described by `SubscribeParams`.
 * - Events are buffered by `seq` and replayed to later subscriptions, enabling
 *   the SDK to rotate streams as subscriptions widen or narrow.
 *
 * The implementation is intentionally small and process-local. It is suitable
 * for this example and for understanding the protocol shape, but production
 * servers should persist threads, enforce concurrency policies, and coordinate
 * replay buffers across workers.
 */
export class LocalThreadSession {
  readonly #agent: AnyReactAgent;
  readonly #threadId: string;

  /**
   * Per-thread protocol event log.
   *
   * A {@link StreamChannel} is LangGraph's buffered, append-only stream with
   * independent per-consumer cursors. Every event ever published stays
   * buffered, and each SSE subscription gets its own cursor via
   * {@link StreamChannel.iterate}, so buffered replay and live delivery are the
   * same iteration.
   */
  readonly #log = StreamChannel.local<ProtocolEvent>();

  /** Monotonic seq across all runs on this thread (graph runs reset at 0). */
  #nextSeq = 0;

  #activeRun:
    | {
        abort(reason?: unknown): void;
      }
    | undefined;

  constructor(agent: AnyReactAgent, threadId: string) {
    this.#agent = agent;
    this.#threadId = threadId;
  }

  /**
   * Handle a thread command sent to the Agent Protocol `/commands` endpoint.
   *
   * The SDK sends `run.start` to start or resume a graph run on the current
   * thread. This starts the in-process v3 stream and immediately returns a
   * success response containing a generated `run_id`, while streamed events
   * flow asynchronously through active `/stream` subscriptions.
   */
  async handleCommand(
    command: Command
  ): Promise<CommandResponse | ErrorResponse> {
    if (command.method !== "run.start") {
      return {
        type: "error",
        id: command.id,
        error: "unknown_command",
        message: `Unsupported command: ${command.method}`,
      } as ErrorResponse;
    }

    const params = isRecord(command.params)
      ? (command.params as { input?: unknown })
      : {};
    const runId = crypto.randomUUID();
    void this.#startRun(params.input as AgentRunInput, runId);

    return {
      type: "success",
      id: command.id,
      result: { run_id: runId },
    } as CommandResponse;
  }

  /**
   * Open a connection-scoped SSE subscription for this thread.
   *
   * The returned `ReadableStream` first replays buffered events matching the
   * requested `channels`, `namespaces`, `depth`, and optional `since` cursor,
   * then stays attached for live events. Closing the HTTP connection releases
   * this subscription's event-log cursor.
   */
  stream(params: SubscribeParams) {
    const cursor = this.#log.iterate();

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        // Scan forward until we find an event matching this subscription's
        // filter, enqueue exactly one frame, and return so the channel honors
        // the consumer's backpressure. `cursor.next()` resolves immediately for
        // buffered events and suspends once the live edge is reached.
        for (;;) {
          const { value: event, done } = await cursor.next();
          if (done) {
            controller.close();
            return;
          }
          if (matchesSubscription(event, params)) {
            controller.enqueue(encodeSse(event));
            return;
          }
        }
      },
      cancel: () => {
        void cursor.return?.(undefined);
      },
    });
  }

  #publish(rawEvent: ProtocolEvent) {
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    const event = sanitizeEvent({
      ...rawEvent,
      type: "event",
      seq,
    } as ProtocolEvent);
    this.#log.push(event);
  }

  async #startRun(input: AgentRunInput, runId: string) {
    this.#activeRun?.abort("Starting a new run.");
    // Thread the `thread_id` / `run_id` into the run config so the checkpointer
    // persists conversation state per thread and downstream events carry the
    // run identity.
    const run = await this.#agent.streamEvents(input, {
      version: "v3",
      configurable: { thread_id: this.#threadId, run_id: runId },
    });
    this.#activeRun = run;

    try {
      for await (const rawEvent of run) {
        this.#publish(rawEvent as ProtocolEvent);
      }
    } catch (error) {
      console.error(error);
    } finally {
      if (this.#activeRun === run) {
        this.#activeRun = undefined;
      }
    }
  }
}
