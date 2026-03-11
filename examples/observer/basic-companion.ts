/* eslint-disable no-console */
/**
 * Observer Example: Basic Companion Agent
 *
 * Demonstrates the main agent + companion pattern. A main coding agent runs
 * a task in the background while a companion agent observes its activity
 * and answers questions about what it's doing.
 *
 * The companion uses a shared store to read the main agent's activity events
 * written by the observer middleware — no direct coupling between the two.
 *
 * The main agent uses the default StateBackend (ephemeral in-memory files),
 * so no sandbox or filesystem backend is needed.
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/observer/basic-companion.ts
 */
import {
  createDeepAgent,
  createObserverMiddleware,
  createSessionHandle,
  createCompanionAgent,
} from "deepagents";
import { MemorySaver, InMemoryStore } from "@langchain/langgraph-checkpoint";

const checkpointer = new MemorySaver();
const store = new InMemoryStore();
const mainThreadId = "task-" + crypto.randomUUID().slice(0, 8);

const observerMiddleware = createObserverMiddleware({
  store,
  sessionId: mainThreadId,
});

const agent = createDeepAgent({
  model: "claude-haiku-4-5",
  middleware: [observerMiddleware],
  checkpointer,
  store,
});

console.log(`Starting main agent on thread ${mainThreadId}…\n`);

// A task that uses the built-in filesystem tools (StateBackend) — no sandbox
// needed. The agent plans, writes files, and edits them in ephemeral state.
const mainRun = agent.stream(
  {
    messages: [
      {
        role: "user",
        content:
          "Write a short Python utility module at /utils/strings.py with " +
          "functions for reversing a string, checking if a string is a " +
          "palindrome, and counting vowels. Then write a brief README.md " +
          "documenting the module.",
      },
    ],
  },
  {
    configurable: {
      thread_id: mainThreadId,
      observer_session_id: mainThreadId,
    },
  },
);

// Consume the main agent stream in the background
let mainDone = false;
const backgroundTask = (async () => {
  for await (const _chunk of await mainRun) {
    // main agent runs…
  }
  mainDone = true;
})();

const session = createSessionHandle({
  sessionId: mainThreadId,
  store,
  getState: (threadId) =>
    agent.getState({ configurable: { thread_id: threadId } }),
});

const companion = createCompanionAgent({
  model: "claude-haiku-4-5",
  session,
  checkpointer,
});

const companionThreadId = "companion-" + mainThreadId;

// Poll the companion for status updates until the main agent finishes
let tick = 0;
while (!mainDone) {
  await new Promise((r) => setTimeout(r, 3000));
  if (mainDone) break;

  tick++;
  console.log(`--- status update #${tick} ---`);

  const answer = await companion.invoke(
    {
      messages: [
        {
          role: "user",
          content:
            "Give a one-sentence status update on what the agent is doing right now.",
        },
      ],
    },
    { configurable: { thread_id: companionThreadId } },
  );

  const lastMsg = answer.messages[answer.messages.length - 1];
  console.log("Companion:", lastMsg.content, "\n");
}

// One final summary after the agent finishes
const summary = await companion.invoke(
  {
    messages: [
      {
        role: "user",
        content: "The agent just finished. Summarize what it did.",
      },
    ],
  },
  { configurable: { thread_id: companionThreadId } },
);

const summaryMsg = summary.messages[summary.messages.length - 1];
console.log("--- final summary ---");
console.log("Companion:", summaryMsg.content);

await backgroundTask;
