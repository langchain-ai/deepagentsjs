import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import { DATASET_NAME, createDeepAgent, runAgent } from "./index.js";

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

ls.describe("subagents", () => {
  ls.test(
    "task calls weather subagent",
    {
      inputs: {
        query: "Use the weather_agent subagent to get the weather in Tokyo.",
      },
      referenceOutputs: { expectedText: "89" },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        subagents: [
          {
            name: "weather_agent",
            description: "Use this agent to get the weather",
            systemPrompt: "You are a weather agent.",
            tools: [getWeatherFake],
          },
        ],
      });
      const result = await runAgent(customAgent, { query: inputs.query });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveToolCallInStep(1, {
        name: "task",
        argsContains: { subagent_type: "weather_agent" },
      });
      expect(result).toHaveFinalTextContaining("89");
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
      const customAgent = createDeepAgent({ tools: [getWeatherFake] });
      const result = await runAgent(customAgent, { query: inputs.query });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveToolCallInStep(1, {
        name: "task",
        argsContains: { subagent_type: "general-purpose" },
      });
      expect(result).toHaveFinalTextContaining("89");
    },
  );
}, { testSuiteName: DATASET_NAME });
