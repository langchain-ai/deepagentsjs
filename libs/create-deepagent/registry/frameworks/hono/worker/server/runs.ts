import type { ReactAgent } from "langchain";
import type { ProtocolEvent } from "@langchain/langgraph/stream";

import { getAgent, getSessionStub } from "./registry";
import { isRecord, sanitizeForJson } from "./serialize";

// `ReactAgent<any>` accepts both `createAgent` results and `DeepAgent`
// instances (which carry a specific, non-default type config).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReactAgent = ReactAgent<any>;
type AgentRunInput = Parameters<AnyReactAgent["streamEvents"]>[0];

/**
 * Make an event safe to `JSON.stringify` onto the SSE wire.
 *
 * Only the protocol payload (`params.data`) and any `params.interrupts` can
 * carry LangChain message instances, so those are the fields we sanitize into
 * the plain, role-keyed protocol message shape the SDK expects.
 */
function sanitizeEvent(event: ProtocolEvent): ProtocolEvent {
  const params = event.params as Record<string, unknown>;
  const sanitizedParams: Record<string, unknown> = {
    ...params,
    data: sanitizeForJson(params.data),
  };
  if ("interrupts" in params) {
    sanitizedParams.interrupts = sanitizeForJson(params.interrupts);
  }
  return { ...event, params: sanitizedParams } as ProtocolEvent;
}

/**
 * Start an agent run on the Worker and fan protocol events into the thread's
 * Durable Object for SSE replay.
 *
 * The SDK sends `run.start` to the `/commands` route, which calls this helper
 * and immediately returns a generated `run_id`. Streamed events are published
 * asynchronously to the thread's Durable Object while clients consume them
 * through active `/stream` subscriptions.
 */
export async function startAgentRun(
  env: Env,
  threadId: string,
  input: unknown,
  runId: string
) {
  const stub = getSessionStub(env, threadId);
  const activeAgent = getAgent() as AnyReactAgent;

  // Thread the `thread_id` / `run_id` into the run config so the checkpointer
  // persists conversation state per thread and downstream events carry the
  // run identity.
  const run = await activeAgent.streamEvents(input as AgentRunInput, {
    version: "v3",
    configurable: { thread_id: threadId, run_id: runId },
  });

  try {
    for await (const rawEvent of run) {
      const event = sanitizeEvent({
        ...(rawEvent as ProtocolEvent),
        type: "event",
      } as ProtocolEvent);
      await stub.fetch(
        new Request("https://session/publish", {
          method: "POST",
          body: JSON.stringify(event),
        })
      );
    }
  } catch (error) {
    console.error(error);
  }
}

/** Parse the `run.start` command payload accepted by `/commands`. */
export function parseRunInput(command: {
  params?: unknown;
}): AgentRunInput | undefined {
  if (!isRecord(command.params)) return undefined;
  return command.params.input as AgentRunInput;
}
