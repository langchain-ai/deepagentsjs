import { describe, expect, it } from "vitest";

import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { modelCallLimitMiddleware } from "langchain";

import { createDeepAgent } from "../agent.js";

describe("parallel subagent state updates", () => {
  it("does not merge model-call counters from parallel subagents", async () => {
    const parentModel = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "Explore both areas in parallel.",
          tool_calls: [
            {
              id: "task-1",
              name: "task",
              args: {
                description: "Find where user auth lives",
                subagent_type: "explorer",
              },
            },
            {
              id: "task-2",
              name: "task",
              args: {
                description: "Find where notification preferences live",
                subagent_type: "explorer",
              },
            },
          ],
        }) as unknown as string,
      ],
    });
    const subagentModel = new FakeListChatModel({
      responses: ["Subagent completed.", "Subagent completed."],
    });

    const agent = createDeepAgent({
      model: parentModel,
      middleware: [
        modelCallLimitMiddleware({ runLimit: 40, exitBehavior: "error" }),
      ],
      subagents: [
        {
          name: "explorer",
          description: "Read-only investigator.",
          systemPrompt: "Investigate the requested area and report the result.",
          model: subagentModel,
          tools: [],
          middleware: [
            modelCallLimitMiddleware({ runLimit: 40, exitBehavior: "error" }),
          ],
        },
      ],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content: "Explore two independent things in parallel.",
        },
      ],
    });

    const taskMessages = result.messages.filter(
      (message) => ToolMessage.isInstance(message) && message.name === "task",
    );
    expect(taskMessages).toHaveLength(2);
    expect(
      taskMessages.every((message) => message.text === "Subagent completed."),
    ).toBe(true);
  });
});
