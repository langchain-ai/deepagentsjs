import { describe, expect, it } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createAgent } from "langchain";

import { createSummarizationMiddleware } from "./summarization.js";
import { createMockBackend } from "./test.js";

describe("summarization streaming", () => {
  it("keeps the summary model's output off the messages stream", async () => {
    const reply = (messages: BaseMessage[]) =>
      new AIMessage(
        messages[0].text.startsWith("SUMMARIZE")
          ? "private summary"
          : "visible answer",
      );
    const model = fakeModel().respond(reply).respond(reply);

    const agent = createAgent({
      model,
      tools: [],
      middleware: [
        createSummarizationMiddleware({
          backend: createMockBackend(),
          summaryPrompt: "SUMMARIZE {conversation}",
          trigger: { type: "messages", value: 3 },
          keep: { type: "messages", value: 1 },
        }),
      ],
    });

    const streamed: string[] = [];
    for await (const [message] of await agent.stream(
      {
        messages: [
          new HumanMessage("one"),
          new AIMessage("two"),
          new HumanMessage("three"),
          new AIMessage("four"),
          new HumanMessage("five"),
        ],
      },
      { streamMode: "messages" },
    )) {
      streamed.push(message.text);
    }

    expect(
      model.callCount,
      "the summary call and the answer call both ran",
    ).toBe(2);
    expect(streamed).toEqual(["visible answer"]);
  });
});
