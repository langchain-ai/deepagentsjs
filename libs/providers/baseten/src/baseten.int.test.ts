import { describe, it, expect } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { ChatBaseten } from "./baseten.js";
import { createDeepAgent } from "deepagents";

const BASETEN_MODEL = "deepseek-ai/DeepSeek-V3.1";

describe("ChatBaseten Integration Tests", () => {
  it(
    "should invoke ChatBaseten directly",
    { timeout: 60_000 },
    async () => {
      const model = new ChatBaseten({ model: BASETEN_MODEL });

      const result = await model.invoke([
        new HumanMessage("What is 2 + 2? Answer with just the number."),
      ]);

      expect(result.content).toBeTruthy();
      expect(typeof result.content).toBe("string");
      expect(result.content).toContain("4");
    },
  );

  it(
    "should stream responses from ChatBaseten",
    { timeout: 60_000 },
    async () => {
      const model = new ChatBaseten({ model: BASETEN_MODEL });

      const chunks: string[] = [];
      for await (const chunk of await model.stream(
        "Say the word 'hello' and nothing else.",
      )) {
        if (typeof chunk.content === "string") {
          chunks.push(chunk.content);
        }
      }

      const fullResponse = chunks.join("");
      expect(fullResponse.toLowerCase()).toContain("hello");
    },
  );

  it(
    "should work with createDeepAgent",
    { timeout: 90_000 },
    async () => {
      const model = new ChatBaseten({ model: BASETEN_MODEL });

      const agent = createDeepAgent({ model });

      const result = await agent.invoke({
        messages: [
          new HumanMessage(
            "What is the capital of France? Answer in one word.",
          ),
        ],
      });

      const lastMessage = result.messages[result.messages.length - 1];
      expect(lastMessage.content).toBeTruthy();
    },
  );
});
