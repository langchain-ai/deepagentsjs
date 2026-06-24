import type { SubscribeParams } from "@langchain/protocol";

import { getSession } from "@/lib/server/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ threadId: string }> };

/**
 * `POST /api/threads/:threadId/stream`
 *
 * The request body is a connection-scoped {@link SubscribeParams} filter. The
 * response is an SSE stream that first replays matching buffered events and then
 * stays attached for live events from the same thread.
 */
export async function POST(request: Request, { params }: Params) {
  const { threadId } = await params;
  const subscribeParams = (await request.json()) as SubscribeParams;

  return new Response(getSession(threadId).stream(subscribeParams), {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream",
      connection: "keep-alive",
      // Disable proxy buffering (e.g. nginx) so SSE frames flush immediately.
      "x-accel-buffering": "no",
    },
  });
}
