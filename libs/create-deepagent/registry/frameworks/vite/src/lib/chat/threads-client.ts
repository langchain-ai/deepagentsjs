/**
 * Browser-side thread helpers for a LangSmith Deployment.
 *
 * Uses the LangGraph SDK against the Agent Server's built-in `/threads`
 * API — no custom protocol routes required.
 */

import { Client } from "@langchain/langgraph-sdk/client";

/** Graph id from `agent/langgraph.json`. */
const ASSISTANT_ID = "agent";

/** LangSmith deployment root URL (no path suffix). */
export function getAgentApiUrl(): string {
  const configured = import.meta.env.VITE_AGENT_API_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  // Dev: same-origin Vite proxy avoids CORS (see scripts/vite-langgraph-proxy.ts).
  if (import.meta.env.DEV) {
    return `${window.location.origin}/api/langgraph`;
  }
  return "http://localhost:2025";
}

export function getApiKey(): string | undefined {
  return import.meta.env.LANGSMITH_API_KEY?.trim() || undefined;
}

function getClient(): Client {
  return new Client({
    apiUrl: getAgentApiUrl(),
    apiKey: getApiKey(),
  });
}

/** Summary of a thread for the history sidebar. */
export type ThreadSummary = {
  id: string;
  title: string;
  updatedAt: string | null;
};

const UNTITLED = "New conversation";

function deriveTitle(values: unknown): string {
  if (typeof values !== "object" || values == null) return UNTITLED;
  const messages = (values as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return UNTITLED;
  for (const message of messages) {
    if (typeof message !== "object" || message == null) continue;
    const record = message as { type?: string; content?: unknown };
    if (record.type !== "human") continue;
    const { content } = record;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((block) =>
                typeof block === "object" &&
                block != null &&
                "text" in block &&
                typeof (block as { text?: unknown }).text === "string"
                  ? (block as { text: string }).text
                  : "",
              )
              .join("")
          : "";
    const trimmed = text.trim();
    if (trimmed) return trimmed.slice(0, 80);
  }
  return UNTITLED;
}

/** Fetch threads from the deployment, newest first. */
export async function fetchThreads(): Promise<ThreadSummary[]> {
  const client = getClient();
  const threads = await client.threads.search({
    metadata: { graph_id: ASSISTANT_ID },
    limit: 100,
    sortBy: "updated_at",
    sortOrder: "desc",
  });

  const summaries: ThreadSummary[] = [];
  for (const thread of threads) {
    let title = UNTITLED;
    try {
      const state = await client.threads.getState(thread.thread_id);
      title = deriveTitle(state.values);
    } catch {
      // Thread may have no checkpoint yet.
    }
    summaries.push({
      id: thread.thread_id,
      title,
      updatedAt: thread.updated_at ?? null,
    });
  }
  return summaries;
}

/** Create a thread on the deployment. */
export async function createThread(): Promise<string> {
  const client = getClient();
  const thread = await client.threads.create({
    metadata: { graph_id: ASSISTANT_ID },
  });
  return thread.thread_id;
}

/** Delete a thread on the deployment. */
export async function deleteThread(threadId: string): Promise<void> {
  await getClient().threads.delete(threadId);
}
