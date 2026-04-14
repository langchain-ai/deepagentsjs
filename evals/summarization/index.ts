import type { EvalRunner } from "@deepagents/evals";
import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner, getFinalText } from "@deepagents/evals";



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

export function summarizationSuite(runner: EvalRunner): void {
      ls.test(
        "summarize continues task",
        {
          inputs: {
            query:
              "Read /summarization.py in small chunks (at most 100 lines per read), and return only the value of MAGIC_END_MARKER.",
          },
        },
        async ({ inputs }) => {
          const run = await runner.run({
            query: inputs.query,
            initialFiles: {
              "/summarization.py": makeLargePythonFile(),
            },
          });
  
          expect(getFinalText(run).toLowerCase()).toContain("opal-fox-91");
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
          const run = await runner.run({
            query: inputs.query,
            initialFiles: {
              "/summarization.py": makeLargePythonFile(),
            },
          });
  
          const historyFiles = getHistoryFiles(run.files);
          ls.logFeedback({
            key: "history_file_count",
            score: historyFiles.length,
          });
          if (historyFiles.length > 0) {
            const historyText = run.files[historyFiles[0]] ?? "";
            expect(historyText).toContain("## Summarized at");
          }
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
          const run = await runner.run({
            query: inputs.query,
            initialFiles: {
              "/summarization.py": makeLargePythonFile(),
            },
          });
          expect(getFinalText(run).toLowerCase()).toContain("logging");
        },
      );
}
