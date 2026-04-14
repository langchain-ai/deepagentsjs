import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import {
  createDeepAgent,
  createSummarizationMiddleware,
  StateBackend,
} from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import {
  getDefaultRunner,
  parseTrajectory,
  getFinalText,
} from "@deepagents/evals";

const runner = getDefaultRunner();

function resolveModelFromEvalRunner(): string {
  const name = process.env.EVAL_RUNNER;
  if (name === "sonnet-4-5" || name === "sonnet-4-5-thinking")
    return "claude-sonnet-4-5-20250929";
  if (name === "sonnet-4-6") return "claude-sonnet-4-6";
  if (name === "opus-4-6") return "claude-opus-4-6";
  if (name === "gpt-4.1") return "gpt-4.1";
  if (name === "gpt-4.1-mini") return "gpt-4.1-mini";
  if (name === "o3-mini") return "o3-mini";
  return "claude-sonnet-4-6";
}

async function invoke(
  agent: ReturnType<typeof createDeepAgent>,
  threadId: string,
  query: string,
  initialFiles?: Record<string, string>,
) {
  const now = new Date().toISOString();
  const files: Record<
    string,
    { content: string[]; created_at: string; modified_at: string }
  > = {};
  for (const [path, content] of Object.entries(initialFiles ?? {})) {
    files[path] = {
      content: content.split("\n"),
      created_at: now,
      modified_at: now,
    };
  }

  const result = await agent.invoke(
    {
      messages: [{ role: "user", content: query }],
      ...(Object.keys(files).length > 0 ? { files } : {}),
    },
    { configurable: { thread_id: threadId } },
  );

  return parseTrajectory(
    result.messages as unknown[],
    result.files as Record<string, unknown>,
  );
}

function makeLargePythonFile(): string {
  const lines = [
    "from __future__ import annotations",
    "import logging",
    "import math",
    "",
  ];
  for (let i = 1; i <= 1600; i += 1) {
    lines.push(`def fn_${i}(x):`);
    lines.push(`    return (x + ${i}) * ${i % 13}`);
    lines.push("");
  }
  lines.push("MAGIC_END_MARKER = 'opal-fox-91'");
  return `${lines.join("\n")}\n`;
}

function getHistoryFiles(files: Record<string, string>): string[] {
  return Object.keys(files).filter((path) =>
    path.startsWith("/conversation_history/"),
  );
}

function createAgent() {
  const model = resolveModelFromEvalRunner();
  return createDeepAgent({
    model,
    checkpointer: new MemorySaver(),
    backend: (config) => new StateBackend(config),
    middleware: [
      createSummarizationMiddleware({
        model,
        backend: (config) => new StateBackend(config),
        trigger: { type: "messages", value: 8 },
        keep: { type: "messages", value: 4 },
      }),
    ],
    systemPrompt:
      "Read files in pages when large. Preserve correctness after long conversations and summarization.",
  });
}

ls.describe(
  runner.name,
  () => {
    ls.test(
      "summarize continues task",
      {
        inputs: {
          query:
            "Read /summarization.py and return only the value of MAGIC_END_MARKER. You may need to paginate.",
        },
      },
      async ({ inputs }) => {
        const agent = createAgent();
        const threadId = crypto.randomUUID();

        await invoke(agent, threadId, "Acknowledge this message briefly.", {
          "/summarization.py": makeLargePythonFile(),
        });
        for (let i = 0; i < 12; i += 1) {
          await invoke(agent, threadId, `Context warmup message ${i}.`);
        }

        const run = await invoke(agent, threadId, inputs.query);

        expect(getFinalText(run).toLowerCase()).toContain("opal-fox-91");
        const historyFiles = getHistoryFiles(run.files);
        expect(historyFiles.length).toBeGreaterThan(0);
      },
    );

    ls.test(
      "summarization offloads to filesystem",
      {
        inputs: {
          query:
            "Summarize the key imports in /summarization.py in one sentence.",
        },
      },
      async ({ inputs }) => {
        const agent = createAgent();
        const threadId = crypto.randomUUID();

        await invoke(agent, threadId, "Start a long technical discussion.", {
          "/summarization.py": makeLargePythonFile(),
        });
        for (let i = 0; i < 14; i += 1) {
          await invoke(
            agent,
            threadId,
            `Extra context segment ${i}: ${"token ".repeat(60)}`,
          );
        }

        const run = await invoke(agent, threadId, inputs.query);

        const historyFiles = getHistoryFiles(run.files);
        expect(historyFiles.length).toBeGreaterThan(0);
        const historyText = run.files[historyFiles[0]] ?? "";
        expect(historyText).toContain("## Summarized at");
      },
    );

    ls.test(
      "summarization preserves followup answerability",
      {
        inputs: {
          query:
            "What is the first standard library import after __future__ in /summarization.py? Return only the module name.",
        },
      },
      async ({ inputs }) => {
        const agent = createAgent();
        const threadId = crypto.randomUUID();

        await invoke(
          agent,
          threadId,
          "Read /summarization.py and confirm when done.",
          {
            "/summarization.py": makeLargePythonFile(),
          },
        );
        for (let i = 0; i < 16; i += 1) {
          await invoke(
            agent,
            threadId,
            `Conversation filler ${i}: ${"details ".repeat(40)}`,
          );
        }

        const followup = await invoke(agent, threadId, inputs.query);
        expect(getFinalText(followup).toLowerCase()).toContain("logging");
      },
    );
  },
  { projectName: "deepagents-js-summarization", upsert: true },
);
