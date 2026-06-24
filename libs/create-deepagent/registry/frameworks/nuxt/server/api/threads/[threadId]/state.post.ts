/**
 * `POST /api/threads/:threadId/state`.
 *
 * Creates or updates checkpointed thread state. Used by the browser bootstrap
 * and by the SDK when hydrating or editing conversation history.
 */

import { getAgent } from "../../../utils/runtime";
import { updateThreadState } from "../../../utils/threads";

type StateUpdateBody = {
  values?: Record<string, unknown> | null;
  checkpoint?: Record<string, unknown> | null;
  as_node?: string;
};

export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, "threadId") ?? "local";
  const body = await readBody<StateUpdateBody>(event).catch(
    () => ({}) as StateUpdateBody,
  );
  try {
    return await updateThreadState(getAgent().graph, threadId, {
      values: body.values ?? null,
      checkpoint: body.checkpoint ?? null,
      asNode: body.as_node,
    });
  } catch (error) {
    setResponseStatus(event, 422);
    return { error: "invalid_state_update", message: String(error) };
  }
});
