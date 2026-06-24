/**
 * Agent Streaming Protocol route handlers for Hono.
 *
 * Mirrors the Next.js route handlers in `js-next/app/api/threads/`.
 */

import { Hono } from "hono";
import type { Command, SubscribeParams } from "@langchain/protocol";

import {
  deleteThread,
  getAgent,
  getCheckpointer,
  getSession,
} from "./registry.ts";
import {
  ThreadNotFoundError,
  getThreadHistory,
  getThreadState,
  listThreads,
  updateThreadState,
} from "./threads.ts";

const SSE_HEADERS = {
  "cache-control": "no-cache, no-transform",
  "content-type": "text/event-stream",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

export const api = new Hono();

api.get("/threads", async (c) => {
  const threads = await listThreads(getAgent().graph, getCheckpointer());
  return c.json(threads);
});

api.delete("/threads/:threadId", async (c) => {
  await deleteThread(c.req.param("threadId"));
  return c.body(null, 204);
});

api.post("/threads/:threadId/commands", async (c) => {
  const threadId = c.req.param("threadId");
  const command = (await c.req.json()) as Command;
  const result = await getSession(threadId).handleCommand(command);
  return c.json(result);
});

api.post("/threads/:threadId/stream", async (c) => {
  const threadId = c.req.param("threadId");
  const subscribeParams = (await c.req.json()) as SubscribeParams;
  const stream = getSession(threadId).stream(subscribeParams);
  return c.newResponse(stream, { headers: SSE_HEADERS });
});

api.get("/threads/:threadId/state", async (c) => {
  const threadId = c.req.param("threadId");
  try {
    const state = await getThreadState(getAgent().graph, threadId);
    return c.json(state);
  } catch (error) {
    if (error instanceof ThreadNotFoundError) {
      return c.json(
        { error: "not_found", message: error.message },
        404
      );
    }
    throw error;
  }
});

api.post("/threads/:threadId/state", async (c) => {
  const threadId = c.req.param("threadId");
  const body = (await c.req.json().catch(() => ({}))) as {
    values?: Record<string, unknown> | null;
    checkpoint?: Record<string, unknown> | null;
    as_node?: string;
  };
  try {
    const state = await updateThreadState(getAgent().graph, threadId, {
      values: body.values ?? null,
      checkpoint: body.checkpoint ?? null,
      asNode: body.as_node,
    });
    return c.json(state);
  } catch (error) {
    return c.json(
      { error: "invalid_state_update", message: String(error) },
      422
    );
  }
});

api.post("/threads/:threadId/history", async (c) => {
  const threadId = c.req.param("threadId");
  const body = (await c.req.json().catch(() => ({}))) as {
    limit?: number;
    before?: unknown;
    metadata?: Record<string, unknown>;
    checkpoint?: Record<string, unknown>;
  };
  try {
    const history = await getThreadHistory(getAgent().graph, threadId, {
      limit: typeof body.limit === "number" ? body.limit : 10,
      before: body.before,
      metadata: body.metadata,
      checkpoint: body.checkpoint,
    });
    return c.json(history);
  } catch (error) {
    if (error instanceof ThreadNotFoundError) {
      return c.json(
        { error: "not_found", message: error.message },
        404
      );
    }
    throw error;
  }
});
