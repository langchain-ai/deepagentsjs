/**
 * Shared test factory for Oolong per-dataset eval files.
 *
 * Each dataset test file calls `makeOolongTests(tasks)` which registers
 * `ls.test` cases for every task in the provided slice.
 *
 * This avoids duplicating the test body across 10 files while keeping
 * each dataset in its own file for independent runs and cleaner
 * LangSmith reporting.
 */

import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner, getFinalText } from "@deepagents/evals";
import { scoreOutput, parseGold } from "./scoring.js";
import type { OolongTask } from "./load-oolong.js";

/**
 * Build a system prompt that instructs the agent to analyse the seeded
 * context file and answer the given question precisely.
 */
function buildSystemPrompt(): string {
  return `\
You are a precise data analyst. You have access to a file /context.txt that contains labelled data.

When asked a question about this data, you MUST:
1. Read the file /context.txt to see the full dataset
2. Carefully analyse every single data point — do not skip, estimate, or approximate
3. Count and classify exactly as instructed by the question
4. Return ONLY the final answer in the exact format requested by the question — no explanation, no extra text

Be precise. The questions ask about aggregate statistics (counts, frequencies, comparisons). Every data point matters.`;
}

/**
 * Register `ls.test` cases for the provided tasks.
 *
 * Must be called inside an `ls.describe` block.
 */
export function makeOolongTests(tasks: OolongTask[]): void {
  if (tasks.length === 0) {
    throw new Error("No Oolong tasks provided");
  }

  const runner = getDefaultRunner();

  for (const task of tasks) {
    const testName = `[${task.contextLen}] ${task.task}::${task.id}`;

    ls.test(
      testName,
      {
        inputs: {
          question: task.question,
          task_id: task.id,
          dataset: task.dataset,
          context_len: task.contextLen,
          task_type: task.task,
          task_group: task.taskGroup,
          answer_type: task.answerType,
          input_subset: task.inputSubset,
        },
        referenceOutputs: {
          answer: task.answer,
        },
      },
      async ({ inputs, referenceOutputs }) => {
        const result = await runner
          .extend({ systemPrompt: buildSystemPrompt() })
          .run({
            query: inputs.question as string,
            initialFiles: {
              "/context.txt": task.contextWindowText,
            },
          });

        const finalText = getFinalText(result);
        const goldAnswer = parseGold(referenceOutputs?.answer);
        const answerType = inputs.answer_type as string;
        const score = scoreOutput(finalText, goldAnswer, answerType);

        // Log all score dimensions to LangSmith
        ls.logFeedback({
          key: "correct",
          score: score.correct ? 1 : 0,
        });
        ls.logFeedback({
          key: "score",
          score: score.score,
        });
        ls.logFeedback({
          key: "exact_match",
          score: score.exactMatch ? 1 : 0,
        });
        ls.logFeedback({
          key: "normalized_match",
          score: score.normalizedMatch ? 1 : 0,
        });
        ls.logFeedback({
          key: "contains_match",
          score: score.containsMatch ? 1 : 0,
        });
        ls.logFeedback({
          key: "numeric_match",
          score: score.numericMatch ? 1 : 0,
        });
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
        ls.logOutputs({
          prediction: score.pred,
          gold_answer: score.gold,
          score: score.score,
          final_text: finalText,
        });

        expect(
          score.correct,
          `Expected "${score.gold}" but got "${score.pred}" (score: ${score.score.toFixed(2)}, final text: "${finalText.slice(0, 200)}")`,
        ).toBe(true);
      },
    );
  }
}
