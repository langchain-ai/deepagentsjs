import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { createDeepAgent, runAgent } from "./index.js";

ls.describe("system prompt", () => {
  ls.test(
    "custom system prompt",
    {
      inputs: { query: "what is your name" },
      referenceOutputs: { expectedText: "Foo Bar" },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        systemPrompt: "Your name is Foo Bar.",
      });
      const result = await runAgent(customAgent, { query: inputs.query });

      expect(result).toHaveAgentSteps(1);
      expect(result).toHaveToolCallRequests(0);
      expect(result).toHaveFinalTextContaining("Foo Bar");
    },
  );
});
