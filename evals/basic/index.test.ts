import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner } from "@deepagents/evals";

const runner = getDefaultRunner();

ls.describe(
  runner.name,
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

        expect(result).toHaveAgentSteps(1);
        expect(result).toHaveToolCallRequests(0);
        expect(result).toHaveFinalTextContaining("Foo Bar");
      },
    );

    ls.test(
      "avoid unnecessary tool calls",
      {
        inputs: { query: "What is 2+2? Answer with just the number." },
      },
      async ({ inputs }) => {
        const result = await runner.run({ query: inputs.query });

        expect(result).toHaveAgentSteps(1);
        expect(result).toHaveToolCallRequests(0);
        expect(result).toHaveFinalTextContaining("4");
      },
    );
  },
  { projectName: "deepagents-js-basic", upsert: true },
);
