import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner } from "@deepagents/evals";

const runner = getDefaultRunner();

function countWriteTodosCalls(
  steps: Array<{ action: { tool_calls?: Array<{ name: string }> } }>,
): number {
  return steps.reduce(
    (sum, step) =>
      sum +
      (step.action.tool_calls ?? []).filter(
        (toolCall) => toolCall.name === "write_todos",
      ).length,
    0,
  );
}

ls.describe(
  runner.name,
  () => {
    ls.test(
      "write todos sequential updates returns text",
      {
        inputs: {
          query:
            "Create a TODO list with exactly 5 items using the write_todos tool. " +
            "Theme: morning routine. Use these exact items in this exact order: " +
            "1) Make coffee 2) Drink water 3) Check calendar 4) Write a short plan 5) Start first task. " +
            "Then update the TODO list 5 times sequentially (one write_todos call per step). " +
            "For update i (1-5), mark item i as completed and leave the others unchanged. " +
            "After the final update, reply with the single word DONE.",
        },
      },
      async ({ inputs }) => {
        const result = await runner.run({ query: inputs.query });

        const writeTodosCalls = countWriteTodosCalls(result.steps);
        expect(writeTodosCalls).toBeGreaterThanOrEqual(6);
        expect(result).toHaveFinalTextContaining("DONE");

        ls.logFeedback({ key: "write_todos_calls", score: writeTodosCalls });
        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );

    ls.test(
      "write todos three steps returns text",
      {
        inputs: {
          query:
            "Create a TODO list with exactly 3 items using the write_todos tool. " +
            "Theme: quick setup. Use these exact items in this exact order: " +
            "1) Open editor 2) Pull latest changes 3) Run tests. " +
            "Then update the TODO list 2 times sequentially (one write_todos call per step). " +
            "For update i (1-2), mark item i as completed and leave the others unchanged. " +
            "After the final update, reply with the single word DONE.",
        },
      },
      async ({ inputs }) => {
        const result = await runner.run({ query: inputs.query });

        const writeTodosCalls = countWriteTodosCalls(result.steps);
        expect(writeTodosCalls).toBeGreaterThanOrEqual(4);
        expect(result).toHaveFinalTextContaining("DONE");

        ls.logFeedback({ key: "write_todos_calls", score: writeTodosCalls });
        ls.logFeedback({ key: "agent_steps", score: result.steps.length });
      },
    );
  },
  { projectName: "deepagents-js-todos", upsert: true },
);
