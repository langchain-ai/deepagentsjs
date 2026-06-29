import { getAgent, getCheckpointer } from "@/lib/server/registry";
import { listThreads } from "@/lib/server/threads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/threads` — list every thread known to the checkpointer. */
export async function GET() {
  const threads = await listThreads(getAgent().graph, getCheckpointer());
  return Response.json(threads);
}
