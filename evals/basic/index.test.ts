import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner } from "@deepagents/evals";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-basic",
  () => {
    ls.test(
      "system prompt: custom system prompt",
      {
        inputs: { query: "what is your name" },
        referenceOutputs: { expectedText: "Foo Bar" },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ systemPrompt: "Your name is Foo Bar." })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("Foo Bar");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "avoid unnecessary tool calls",
      {
        inputs: { query: "What is 2+2? Answer with just the number." },
      },
      async ({ inputs }) => {
        const result = await runner.run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("4");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );
  },
  { projectName: runner.name, upsert: true },
);
