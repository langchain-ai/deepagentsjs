/* eslint-disable no-console */
/**
 * Observer Example: Interactive REPL Companion
 *
 * An interactive terminal session where you can ask questions about a
 * running agent and steer it with lightweight commands. The companion
 * agent has `allowSteering: true`, so it can queue reminders, todos,
 * and guidance for the main agent.
 *
 * The main agent uses the default StateBackend (ephemeral in-memory files),
 * so no sandbox or filesystem backend is needed.
 *
 * Example commands you can type:
 *   "What is the agent doing right now?"
 *   "What files has it touched?"
 *   "Remind it to add error handling"
 *   "Add a todo to write unit tests"
 *   "What todos are pending?"
 *
 * Run:
 *   ANTHROPIC_API_KEY="..." bun ./examples/observer/interactive-companion.ts
 */
import * as readline from "readline";
import {
  createDeepAgent,
  createObserverMiddleware,
  createSessionHandle,
  createCompanionAgent,
} from "deepagents";
import {
  MemorySaver,
  InMemoryStore,
} from "@langchain/langgraph-checkpoint";

const checkpointer = new MemorySaver();
const store = new InMemoryStore();
const mainThreadId = "task-" + crypto.randomUUID().slice(0, 8);

const observerMiddleware = createObserverMiddleware({
  store,
  sessionId: mainThreadId,
});

const agent = createDeepAgent({
  middleware: [observerMiddleware],
  checkpointer,
  store,
});

console.log(`Starting main agent on thread ${mainThreadId}…`);
console.log("Type a question or command, or 'exit' to quit.\n");

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
  console.log("\n[system] Main agent finished.");
})();

const session = createSessionHandle({
  sessionId: mainThreadId,
  store,
  getState: (threadId) =>
    agent.getState({ configurable: { thread_id: threadId } }),
});

const companion = createCompanionAgent({
  session,
  checkpointer,
  allowSteering: true,
});

const companionThreadId = "companion-" + mainThreadId;

async function askCompanion(message: string) {
  const response = await companion.invoke(
    { messages: [{ role: "user", content: message }] },
    { configurable: { thread_id: companionThreadId } },
  );
  return response.messages[response.messages.length - 1].content;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt() {
  const status = mainDone ? "(agent finished)" : "(agent running)";
  rl.question(`\n${status} you> `, async (line) => {
    const input = line.trim();
    if (!input) {
      prompt();
      return;
    }

    if (input.toLowerCase() === "exit") {
      console.log("Goodbye!");
      rl.close();
      return;
    }

    try {
      const reply = await askCompanion(input);
      console.log(`\nCompanion: ${reply}`);
    } catch (err) {
      console.error("Error:", err);
    }

    prompt();
  });
}

prompt();

await backgroundTask;
