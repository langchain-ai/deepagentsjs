/* eslint-disable no-console */
/**
 * Middleman Example: Local Web UI
 *
 * Starts an observed agent session, creates a SessionHandle, and boots the
 * local Vite-based UI server from `deepagents-ui`.
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/observer/middleman-web-ui.ts
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
const sessionId = "middleman-ui-" + crypto.randomUUID().slice(0, 8);

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
          "Create a short utility module and document what you changed when finished.",
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
    // Keep the owner session running while the UI is attached.
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
  // Steering is observe-only by default. Set both flags to true to enable it.
  allowSteering: false,
});

const server = ui.createWebUI({
  port: 3000,
  open: true,
  allowSteering: false,
});

await server.start();
console.log(`DeepAgents UI listening on ${server.url}`);
