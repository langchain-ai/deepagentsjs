import "server-only";

import { agent, checkpointer } from "@/lib/agent";
import { LocalThreadSession } from "./session";

/**
 * Process-local registry for the agent and its per-thread sessions.
 *
 * Next.js route handlers are stateless per request, and the dev server
 * re-evaluates modules on hot reload. Stashing the agent and the session map on
 * `globalThis` keeps a single agent instance (and therefore a single
 * `MemorySaver` checkpointer) alive across requests and reloads, so a thread's
 * conversation state survives between the `/state`, `/commands`, and `/stream`
 * calls that make up one turn.
 *
 * NOTE: This is in-memory and process-local. A serverless/multi-instance
 * deployment needs a durable checkpointer (Postgres, SQLite, …) and a shared
 * session/replay store. The wiring here stays the same; only the checkpointer
 * in `lib/agent/index.ts` and this store change.
 */
type Registry = {
  sessions: Map<string, LocalThreadSession>;
};

const globalForRegistry = globalThis as unknown as {
  __agentRegistry?: Registry;
};

const registry: Registry = (globalForRegistry.__agentRegistry ??= {
  sessions: new Map(),
});

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
  let session = registry.sessions.get(threadId);
  if (session == null) {
    session = new LocalThreadSession(agent, threadId);
    registry.sessions.set(threadId, session);
  }
  return session;
}

/** Delete a thread: remove its session and its checkpointed state. */
export async function deleteThread(threadId: string): Promise<void> {
  registry.sessions.delete(threadId);
  await checkpointer.deleteThread(threadId);
}
