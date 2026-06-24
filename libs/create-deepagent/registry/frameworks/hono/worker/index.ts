import { Hono } from "hono";
import type { Command, CommandResponse, ErrorResponse } from "@langchain/protocol";

import { ThreadSession } from "./durable-objects/thread-session";
import {
  deleteThread,
  getAgent,
  getCheckpointer,
  getSessionStub,
} from "./server/registry";
import { parseRunInput, startAgentRun } from "./server/runs";
import {
  ThreadNotFoundError,
  getThreadHistory,
  getThreadState,
  listThreads,
  updateThreadState,
} from "./server/threads";

export { ThreadSession };

const app = new Hono<{ Bindings: Env }>();

app.get("/api/threads", async (c) => {
  const threads = await listThreads(getAgent().graph, getCheckpointer());
  return c.json(threads);
});

app.delete("/api/threads/:threadId", async (c) => {
  const threadId = c.req.param("threadId");
  await deleteThread(c.env, threadId);
  return c.body(null, 204);
});

app.post("/api/threads/:threadId/commands", async (c) => {
  const threadId = c.req.param("threadId");
  const command = (await c.req.json()) as Command;

  if (command.method !== "run.start") {
    const error: ErrorResponse = {
      type: "error",
      id: command.id,
      error: "unknown_command",
      message: `Unsupported command: ${command.method}`,
    };
    return c.json(error);
  }

  const runId = crypto.randomUUID();
  const input = parseRunInput(command);
  c.executionCtx.waitUntil(startAgentRun(c.env, threadId, input, runId));

  const response: CommandResponse = {
    type: "success",
    id: command.id,
    result: { run_id: runId },
  };
  return c.json(response);
});

app.post("/api/threads/:threadId/stream", async (c) => {
  const threadId = c.req.param("threadId");
  const params = await c.req.json();
  const stub = getSessionStub(c.env, threadId);
  return stub.fetch(
    new Request("https://session/stream", {
      method: "POST",
      body: JSON.stringify(params),
    })
  );
});

app.get("/api/threads/:threadId/state", async (c) => {
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

app.post("/api/threads/:threadId/state", async (c) => {
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

app.post("/api/threads/:threadId/history", async (c) => {
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

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
};
