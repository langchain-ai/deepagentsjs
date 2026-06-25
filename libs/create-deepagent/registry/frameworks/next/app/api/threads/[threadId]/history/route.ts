import { getAgent } from "@/lib/server/registry";
import { ThreadNotFoundError, getThreadHistory } from "@/lib/server/threads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ threadId: string }> };

/** `POST /api/threads/:threadId/history` — list past checkpointed states. */
export async function POST(request: Request, { params }: Params) {
  const { threadId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
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
    return Response.json(history);
  } catch (error) {
    if (error instanceof ThreadNotFoundError) {
      return Response.json(
        { error: "not_found", message: error.message },
        { status: 404 }
      );
    }
    throw error;
  }
}
