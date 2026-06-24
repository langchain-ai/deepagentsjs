import { deleteThread } from "@/lib/server/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ threadId: string }> };

/** `DELETE /api/threads/:threadId` — drop a thread's session and checkpoints. */
export async function DELETE(_request: Request, { params }: Params) {
  const { threadId } = await params;
  await deleteThread(threadId);
  return new Response(null, { status: 204 });
}
