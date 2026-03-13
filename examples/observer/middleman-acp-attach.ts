/* eslint-disable no-console */
/**
 * Middleman Example: ACP-Style Attach
 *
 * Demonstrates attaching a client to an existing observed session using the
 * ACP-friendly SessionHandle surface, then polling updates and queueing a
 * safe-boundary steering command.
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/observer/middleman-acp-attach.ts
 */
import {
  createDeepAgent,
  createObserverMiddleware,
  createSessionHandle,
} from "deepagents";
import { MemorySaver, InMemoryStore } from "@langchain/langgraph-checkpoint";
import { middleman } from "deepagents-ui";

const checkpointer = new MemorySaver();
const store = new InMemoryStore();
const sessionId = "middleman-acp-" + crypto.randomUUID().slice(0, 8);

const observerMiddleware = createObserverMiddleware({
  store,
  sessionId,
});

const agent = createDeepAgent({
  middleware: [observerMiddleware],
  checkpointer,
  store,
});

const run = agent.stream(
  {
    messages: [
      {
        role: "user",
        content:
          "Build a small helper and summarize the result when you're finished.",
      },
    ],
  },
  {
    configurable: {
      thread_id: sessionId,
      observer_session_id: sessionId,
    },
  },
);

void (async () => {
  for await (const _chunk of await run) {
    // Observe the owner session from a separate consumer.
  }
})();

const session = createSessionHandle({
  sessionId,
  store,
  getState: (threadId) =>
    agent.getState({ configurable: { thread_id: threadId } }),
});

const ui = middleman({
  session,
  allowSteering: true,
  permissions: {
    canSteer: () => true,
  },
});

const attached = ui.attachACPClient({
  client: { id: "zed-local", transport: "acp", name: "Zed" },
  allowSteering: true,
  historyLimit: 25,
});

const initial = await attached.getInitialUpdates();
console.log("Initial updates:", initial.length);

const page = await attached.poll({ limit: 10 });
console.log("Polled updates:", page.updates.length);

const result = await attached.steer({
  kind: "reminder",
  target: "active",
  payload: { text: "Before you finish, update the docs too." },
});

console.log(
  `Queued steering command ${result.commandId}. It will apply at the next safe reasoning boundary.`,
);

attached.close();
