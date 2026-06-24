import { DurableObject } from "cloudflare:workers";
// `StreamChannel` buffers events; `matchesSubscription` is the shared protocol
// predicate from `@langchain/langgraph/stream` — the same one langgraph-api
// uses, so this custom transport stays aligned with the production server.
import {
  StreamChannel,
  matchesSubscription,
  type ProtocolEvent,
} from "@langchain/langgraph/stream";
import type { SubscribeParams } from "@langchain/protocol";

import { sanitizeForJson } from "../server/serialize";

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

const SSE_HEADERS = {
  "cache-control": "no-cache, no-transform",
  "content-type": "text/event-stream",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/**
 * Per-thread Durable Object that owns the Agent Streaming Protocol event log.
 *
 * Cloudflare Workers cannot keep an in-memory session map like the Node
 * examples. Instead the Worker runs the LangGraph agent and POSTs each protocol
 * each protocol event here; browser clients subscribe via `/stream`, which
 * replays buffered events and stays attached for live frames.
 *
 * - `POST /publish` appends a protocol event to the replay log.
 * - `POST /stream` opens a connection-scoped SSE subscription described by
 *   `SubscribeParams`.
 * - `POST /clear` resets the replay buffer when a thread is deleted.
 *
 * The implementation is intentionally small. Production servers should persist
 * threads, enforce concurrency policies, and coordinate replay buffers across
 * workers.
 */
export class ThreadSession extends DurableObject {
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/publish") {
      const event = (await request.json()) as ProtocolEvent;
      this.#publish(event);
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && url.pathname === "/stream") {
      const params = (await request.json()) as SubscribeParams;
      return new Response(this.#stream(params), { headers: SSE_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/clear") {
      this.#nextSeq = 0;
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }

    return new Response("Not Found", { status: 404 });
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

  /**
   * Open a connection-scoped SSE subscription for this thread.
   *
   * The returned `ReadableStream` first replays buffered events matching the
   * requested `channels`, `namespaces`, `depth`, and optional `since` cursor,
   * then stays attached for live events. Closing the HTTP connection releases
   * this subscription's event-log cursor.
   */
  #stream(params: SubscribeParams) {
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
}

export default ThreadSession;
