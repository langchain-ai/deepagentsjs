import { expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createAgent } from "langchain";
import { createSummarizationMiddleware } from "./summarization.js";
import { createMockBackend } from "./test.js";

it("keeps internal summary tokens out of the agent message stream", async () => {
  const model = new FakeListChatModel({
    responses: ["private summary", "visible answer"],
  });
  const summarize = vi.spyOn(model, "invoke");
  const agent = createAgent({
    model,
    tools: [],
    middleware: [
      createSummarizationMiddleware({
        backend: createMockBackend(),
        trigger: { type: "messages", value: 3 },
        keep: { type: "messages", value: 1 },
      }),
    ],
  });
  const stream = await agent.stream(
    {
      messages: [
        new HumanMessage("previous question"),
        new AIMessage("previous answer"),
        new HumanMessage("current question"),
      ],
    },
    { streamMode: "messages" },
  );
  let text = "";
  for await (const [message] of stream) {
    if (message.type === "ai") text += message.text;
  }
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(text).toBe("visible answer");
});
