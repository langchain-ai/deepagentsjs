/**
 * Baseline test factory for Oolong per-dataset eval files.
 *
 * Creates the agent directly with:
 * - FilesystemBackend seeded with context data
 * - QuickJS middleware with PTC tools (no skills, no task tool)
 * - MemorySaver checkpointer for state propagation
 *
 * Mirrors make-swarm-tests.ts exactly, minus the swarm skill,
 * so the only independent variable is swarm availability.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuidv4 } from "uuid";
import * as ls from "langsmith/vitest";
import { expect, afterAll } from "vitest";
import { getFinalText, parseTrajectory } from "@deepagents/evals";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { ChatAnthropic } from "@langchain/anthropic";
import { createQuickJSMiddleware } from "@langchain/quickjs";
import { scoreOutput, parseGold } from "./scoring.js";
import type { OolongTask } from "./load-oolong.js";

function buildSystemPrompt(): string {
  return `\
You are a precise data analyst. You have a file at /context.txt.

Return ONLY the final answer in the exact format requested — no explanation.`;
}

const PTC_TOOLS = ["task", "read_file", "write_file", "glob"];

export function makeOolongTests(tasks: OolongTask[]): void {
  if (tasks.length === 0) {
    throw new Error("No Oolong tasks provided");
  }

  const rootDir = join(tmpdir(), `deepagents-baseline-eval-${Date.now()}`);
  mkdirSync(rootDir, { recursive: true });

  const backend = new FilesystemBackend({ rootDir, virtualMode: true });
  const checkpointer = new MemorySaver();

  const model = new ChatAnthropic({
    model: "claude-sonnet-4-6",
  });

  const quickjsMiddleware = createQuickJSMiddleware({
    ptc: PTC_TOOLS,
    executionTimeoutMs: 120_000,
    maxPtcCalls: 512,
    memoryLimitBytes: 256 * 1024 * 1024,
  });

  const agent = createDeepAgent({
    model,
    backend,
    middleware: [quickjsMiddleware],
    checkpointer,
    systemPrompt: buildSystemPrompt(),
    name: "oolong-baseline-eval",
  });

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
        writeFileSync(
          join(rootDir, "context.txt"),
          task.contextWindowText,
          "utf-8",
        );

        const threadId = uuidv4();
        const result = await agent.invoke(
          {
            messages: [{ role: "user", content: inputs.question as string }],
          },
          { configurable: { thread_id: threadId } },
        );

        const r = result as Record<string, unknown>;
        const trajectory = parseTrajectory(
          r.messages as unknown[],
          r.files as Record<string, unknown>,
        );

        const finalText = getFinalText(trajectory);
        const goldAnswer = parseGold(referenceOutputs?.answer);
        const answerType = inputs.answer_type as string;
        const score = scoreOutput(finalText, goldAnswer, answerType);

        ls.logFeedback({ key: "correct", score: score.correct ? 1 : 0 });
        ls.logFeedback({ key: "score", score: score.score });
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
        ls.logFeedback({ key: "agent_steps", score: trajectory.steps.length });
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

  afterAll(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });
}
