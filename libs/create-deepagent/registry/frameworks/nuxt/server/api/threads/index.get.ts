/**
 * `GET /api/threads` — list every thread known to the checkpointer.
 *
 * The agent's in-memory `MemorySaver` is the single source of truth, so the
 * sidebar is always derived from it (no client-side cache).
 */

import { getAgent, getCheckpointer } from "../../utils/runtime";
import { listThreads } from "../../utils/threads";

export default defineEventHandler(async () => {
  return listThreads(getAgent().graph, getCheckpointer());
});
