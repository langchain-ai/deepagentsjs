import * as ls from "langsmith/vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { getDefaultRunner, getFinalText } from "@deepagents/evals";

type Case = {
  benchmark: "frames" | "nexus" | "bfcl_v3";
  id: string;
  prompt: string;
  files: Record<string, string>;
  answer_snippets: string[];
  difficulty: string;
};

const runner = getDefaultRunner();
const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(
  readFileSync(resolve(__dirname, "data/curated_cases.json"), "utf-8"),
) as Case[];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\t\n\r]+/g, "")
    .replace(/["'`]/g, "");
}

ls.describe(
  "deepagents-js-external-benchmarks",
  () => {
    for (const testCase of CASES) {
      ls.test(
        `${testCase.benchmark}:${testCase.id}`,
        {
          inputs: {
            benchmark: testCase.benchmark,
            id: testCase.id,
            query: testCase.prompt,
          },
        },
        async () => {
          const result = await runner.run({
            query: testCase.prompt,
            initialFiles: testCase.files,
          });

          const answer = normalize(getFinalText(result));
          const snippets = testCase.answer_snippets;

          if (snippets.length > 0) {
            for (const snippet of snippets) {
              expect(answer).toContain(normalize(snippet));
            }
          } else {
            expect(answer.length).toBeGreaterThan(0);
          }

          ls.logFeedback({ key: "benchmark", value: testCase.benchmark });
          ls.logFeedback({ key: "difficulty", value: testCase.difficulty });
          ls.logFeedback({ key: "agent_steps", score: result.steps.length });
        },
      );
    }
  },
  { projectName: runner.name, upsert: true },
);
