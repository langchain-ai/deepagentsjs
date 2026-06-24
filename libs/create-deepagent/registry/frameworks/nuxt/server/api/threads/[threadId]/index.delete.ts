/**
 * `DELETE /api/threads/:threadId` — drop a thread's session and checkpoints.
 */

import { deleteThread } from "../../../utils/runtime";

export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, "threadId") ?? "local";
  await deleteThread(threadId);
  setResponseStatus(event, 204);
  return null;
});
