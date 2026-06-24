/**
 * `GET /api/threads/:threadId/state`.
 *
 * Reads checkpointed thread state. Returns 404 when the thread has no
 * checkpoint yet so the LangGraph SDK can bootstrap it before the first run.
 */

import { getAgent } from "../../../utils/runtime";
import { ThreadNotFoundError, getThreadState } from "../../../utils/threads";

export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, "threadId") ?? "local";
  try {
    return await getThreadState(getAgent().graph, threadId);
  } catch (error) {
    if (error instanceof ThreadNotFoundError) {
      setResponseStatus(event, 404);
      return { error: "not_found", message: error.message };
    }
    throw error;
  }
});
