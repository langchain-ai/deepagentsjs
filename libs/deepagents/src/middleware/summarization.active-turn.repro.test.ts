import { describe, expect, it, vi } from "vitest";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "../agent.js";
import { createSummarizationMiddleware } from "./summarization.js";

describe("summarization active user turn reproduction", () => {
  it("reproduces dropping the active user instruction from the post-summary agent call", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const activeInstruction = "Reply with exactly: received-1";

    try {
      const agent = createDeepAgent({
        model: new FakeListChatModel({
          responses: ["first answer", "second answer"],
        }),
        checkpointer: new MemorySaver(),
        middleware: [
          createSummarizationMiddleware({
            model: new FakeListChatModel({
              responses: ["summary of prior context"],
            }),
            backend: {
              async write(path: string) {
                return { path };
              },
            } as any,
            trigger: { type: "messages", value: 3 },
            keep: { type: "messages", value: 0 },
          }),
        ],
      });
      const config = {
        configurable: { thread_id: `active-turn-${crypto.randomUUID()}` },
      };

      await agent.invoke(
        { messages: [new HumanMessage("older context")] },
        config,
      );
      await agent.invoke(
        { messages: [new HumanMessage(activeInstruction)] },
        config,
      );

      // Calls are: first agent response, summary generation, then the agent
      // response after summarization. With keep: 0, the baseline loses the
      // active instruction and invokes the agent with only the summary.
      const postSummaryMessages = invokeSpy.mock.calls.at(-1)?.[0] as
        | BaseMessage[]
        | undefined;
      expect(postSummaryMessages).toHaveLength(1);
      expect(postSummaryMessages?.[0].content).not.toBe(activeInstruction);
    } finally {
      invokeSpy.mockRestore();
    }
  });
});
