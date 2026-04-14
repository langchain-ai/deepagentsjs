import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { createSummarizationMiddleware, StateBackend } from "deepagents";
import { getDefaultRunner, getFinalText } from "@deepagents/evals";

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

function createSummarizationRunner() {
  const model = resolveModelFromEvalRunner();
  return runner.extend({
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
  "deepagents-js-summarization",
  () => {
    ls.test(
      "summarize continues task",
      {
        inputs: {
          query:
            "Read /summarization.py in small chunks (at most 100 lines per read), and return only the value of MAGIC_END_MARKER.",
        },
      },
      async ({ inputs }) => {
        const run = await createSummarizationRunner().run({
          query: inputs.query,
          initialFiles: {
            "/summarization.py": makeLargePythonFile(),
          },
        });

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
            "Read /summarization.py in small chunks, then summarize the key imports in one sentence.",
        },
      },
      async ({ inputs }) => {
        const run = await createSummarizationRunner().run({
          query: inputs.query,
          initialFiles: {
            "/summarization.py": makeLargePythonFile(),
          },
        });

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
            "Read /summarization.py in small chunks and then answer: what is the first standard library import after __future__? Return only the module name.",
        },
      },
      async ({ inputs }) => {
        const run = await createSummarizationRunner().run({
          query: inputs.query,
          initialFiles: {
            "/summarization.py": makeLargePythonFile(),
          },
        });
        expect(getFinalText(run).toLowerCase()).toContain("logging");
      },
    );
  },
  { projectName: runner.name, upsert: true },
);
