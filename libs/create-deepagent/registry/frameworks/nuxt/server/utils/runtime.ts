import { agent, checkpointer } from "../agent";
import { LocalThreadSession } from "./session";

/**
 * Process-local registry for the agent and its per-thread sessions.
 *
 * Under Nuxt the Agent Streaming Protocol is served by Nitro route handlers, so
 * the shared agent + session registry is a module singleton instead of a
 * standalone Hono server.
 *
 * NOTE: This is in-memory and process-local. A serverless/multi-instance
 * deployment needs a durable checkpointer (Postgres, SQLite, …) and a shared
 * session/replay store. The wiring here stays the same; only the checkpointer
 * in `server/agent/index.ts` and this store change.
 */
const sessions = new Map<string, LocalThreadSession>();

/** The shared, compiled agent (and its checkpointer). */
export function getAgent() {
  return agent;
}

/** The shared checkpointer — the single source of truth for threads. */
export function getCheckpointer() {
  return checkpointer;
}

/** Get or create the process-local session for a thread. */
export function getSession(threadId: string): LocalThreadSession {
  let session = sessions.get(threadId);
  if (session == null) {
    session = new LocalThreadSession(agent, threadId);
    sessions.set(threadId, session);
  }
  return session;
}

/** Delete a thread: remove its session and its checkpointed state. */
export async function deleteThread(threadId: string): Promise<void> {
  sessions.delete(threadId);
  await checkpointer.deleteThread(threadId);
}
