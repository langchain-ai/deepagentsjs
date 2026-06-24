import type { Command } from "@langchain/protocol";

import { getSession } from "@/lib/server/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ threadId: string }> };

/**
 * `POST /api/threads/:threadId/commands`
 *
 * The request body is an Agent Protocol {@link Command}. The response is the
 * command result emitted by the owning `LocalThreadSession`.
 */
export async function POST(request: Request, { params }: Params) {
  const { threadId } = await params;
  const command = (await request.json()) as Command;
  const result = await getSession(threadId).handleCommand(command);
  return Response.json(result);
}
