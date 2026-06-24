import { agent, checkpointer } from "../agent";

/**
 * Worker-level registry for the compiled agent and checkpointer.
 *
 * Unlike Next.js route handlers (one Node process), Cloudflare Workers are
 * short-lived isolates. The agent and `MemorySaver` checkpointer live here so
 * thread state routes can read/write checkpoints. SSE replay buffers live in
 * per-thread Durable Objects (see `durable-objects/thread-session.ts`) rather
 * than an in-memory session map used by the Node examples.
 *
 * NOTE: This is in-memory and process-local within each isolate. Production
 * deployments need a durable checkpointer and a Durable Object session store.
 * The wiring here stays the same; only the checkpointer in `worker/agent` and
 * the session store change.
 */

/** The shared, compiled agent (and its checkpointer). */
export function getAgent() {
  return agent;
}

/** The shared checkpointer — the single source of truth for threads. */
export function getCheckpointer() {
  return checkpointer;
}

/** Delete a thread: remove its checkpointed state and clear the replay buffer. */
export async function deleteThread(
  env: Env,
  threadId: string
): Promise<void> {
  await checkpointer.deleteThread(threadId);
  const stub = getSessionStub(env, threadId);
  await stub.fetch(new Request("https://session/clear", { method: "POST" }));
}

/** Resolve the per-thread Durable Object stub for SSE replay. */
export function getSessionStub(env: Env, threadId: string) {
  const id = env.SESSIONS.idFromName(threadId);
  return env.SESSIONS.get(id);
}
