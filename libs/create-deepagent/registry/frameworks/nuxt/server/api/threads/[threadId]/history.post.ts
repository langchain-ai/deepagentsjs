/**
 * `POST /api/threads/:threadId/history`.
 *
 * Lists past thread states (newest-first) from the graph checkpointer, powering
 * the SDK's history/replay reads.
 */

import { getAgent } from "../../../utils/runtime";
import { ThreadNotFoundError, getThreadHistory } from "../../../utils/threads";

type HistoryBody = {
  limit?: number;
  before?: unknown;
  metadata?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
};

export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, "threadId") ?? "local";
  const body = await readBody<HistoryBody>(event).catch(() => ({}) as HistoryBody);
  try {
    return await getThreadHistory(getAgent().graph, threadId, {
      limit: typeof body.limit === "number" ? body.limit : 10,
      before: body.before,
      metadata: body.metadata,
      checkpoint: body.checkpoint,
    });
  } catch (error) {
    if (error instanceof ThreadNotFoundError) {
      setResponseStatus(event, 404);
      return { error: "not_found", message: error.message };
    }
    throw error;
  }
});
