/**
 * RLM OOLONG trec_coarse Evaluation
 *
 * Tests the Recursive Language Model (RLM) pattern on the OOLONG benchmark:
 * 50 long-context aggregation tasks where the agent must classify ~3,190 text
 * lines into TREC coarse categories and answer distributional questions.
 *
 * Paper baselines (GPT-5):
 *   Base: 44.0% | CodeAct: 38.0% | Summary Agent: 46.0% | RLM: 56.5%
 *
 * Our target: ≥56.5% using Claude Opus 4.6 + QuickJS REPL + PTC
 *
 * Dataset is auto-fetched from HuggingFace (oolongbench/oolong-synth) and
 * cached locally on first run.
 *
 * ## Running
 *
 * ```bash
 * cd libs/deepagents
 *
 * # Run all 50 tasks
 * pnpm test:eval -- src/evals/rlm-oolong.eval.test.ts
 *
 * # Run first 10 tasks with a named experiment
 * OOLONG_MAX_TASKS=10 OOLONG_EXPERIMENT_NAME=my-experiment \
 *   pnpm test:eval -- src/evals/rlm-oolong.eval.test.ts
 * ```
 */
import { expect } from "vitest";
import * as ls from "langsmith/vitest";
import { runAgent, getFinalText } from "./index.js";
import { createRlmAgent } from "./rlm/agent.js";
import { loadOolongTasks } from "./rlm/load-oolong.js";
import { scoreOutput, parseGold } from "./rlm/scoring.js";

const MAX_TASKS = 10;
const EXPERIMENT_NAME = "quickjs-anthropic-rlm-simple";

const tasks = await loadOolongTasks(MAX_TASKS);

ls.describe(
  "rlm-oolong-trec-coarse",
  () => {
    for (const task of tasks) {
      ls.test(
        `${task.taskType}::${task.id}`,
        {
          inputs: {
            question: task.question,
            task_id: task.id,
            task_type: task.taskType,
          },
          referenceOutputs: { answer: task.answer },
        },
        async ({ inputs }) => {
          const agent = createRlmAgent({
            files: {
              "/context.txt": task.contextWindowText,
              "/question.txt": task.question,
            },
          });

          const result = await runAgent(agent, {
            query: inputs.question,
          });

          const finalText = getFinalText(result);
          const goldAnswer = parseGold(task.answer);
          const score = scoreOutput(finalText, goldAnswer);

          // Log all score dimensions to LangSmith
          ls.logFeedback({ key: "correct", score: score.correct ? 1 : 0 });
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
          ls.logFeedback({ key: "agent_steps", score: result.steps.length });
          ls.logOutputs({
            prediction: score.pred,
            gold_answer: score.gold,
          });

          expect(score.correct).toBe(true);
        },
      );
    }
  },
  { projectName: EXPERIMENT_NAME },
);
