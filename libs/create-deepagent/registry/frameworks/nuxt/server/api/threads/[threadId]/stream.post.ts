/**
 * `POST /api/threads/:threadId/stream`.
 *
 * The request body is a connection-scoped `SubscribeParams` filter. The
 * response is an SSE stream that first replays matching buffered events and
 * then stays attached for live events from the same thread.
 */

import type { SubscribeParams } from "@langchain/protocol";

import { getSession } from "../../../utils/runtime";

export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, "threadId") ?? "local";
  const params = await readBody<SubscribeParams>(event);

  setResponseHeader(event, "content-type", "text/event-stream");
  setResponseHeader(event, "cache-control", "no-cache");
  setResponseHeader(event, "connection", "keep-alive");
  // Disable proxy buffering so SSE frames flush immediately.
  setResponseHeader(event, "x-accel-buffering", "no");

  return getSession(threadId).stream(params);
});
