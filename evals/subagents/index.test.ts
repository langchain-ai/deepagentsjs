import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import { getDefaultRunner } from "@deepagents/evals";

const runner = getDefaultRunner();

const getWeatherFake = tool(
  async (_input) => {
    return "It's sunny at 89 degrees F";
  },
  {
    name: "get_weather_fake",
    description: "Return a fixed weather response for eval scenarios.",
    schema: z.object({
      location: z.string(),
    }),
  },
);

ls.describe(
  "deepagents-js-subagents",
  () => {
    ls.test(
      "task calls weather subagent",
      {
        inputs: {
          query: "Use the weather_agent subagent to get the weather in Tokyo.",
        },
        referenceOutputs: { expectedText: "89" },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({
            subagents: [
              {
                name: "weather_agent",
                description: "Use this agent to get the weather",
                systemPrompt: "You are a weather agent.",
                tools: [getWeatherFake],
              },
            ],
          })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("89");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "task calls general-purpose subagent",
      {
        inputs: {
          query:
            "Use the general purpose subagent to get the weather in Tokyo.",
        },
        referenceOutputs: { expectedText: "89" },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ tools: [getWeatherFake] })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("89");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );
  },
  { projectName: runner.name, upsert: true },
);
