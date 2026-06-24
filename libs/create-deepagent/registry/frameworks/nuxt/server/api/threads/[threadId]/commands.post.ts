/**
 * `POST /api/threads/:threadId/commands`.
 *
 * The request body is an Agent Protocol `Command`. The response is the command
 * result emitted by the owning {@link LocalThreadSession}.
 */

import type { Command } from "@langchain/protocol";

import { getSession } from "../../../utils/runtime";

export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, "threadId") ?? "local";
  const command = await readBody<Command>(event);
  return getSession(threadId).handleCommand(command);
});
