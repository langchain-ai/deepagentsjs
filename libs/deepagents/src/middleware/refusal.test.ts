import { describe, it, expect } from "vitest";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ModelRefusalError } from "@langchain/core/errors";
import type { ChatResult } from "@langchain/core/outputs";
import {
  createAgent,
  modelFallbackMiddleware,
  StructuredOutputParsingError,
} from "langchain";
import { createDeepAgent } from "../agent.js";
import { finalContent } from "./async_subagents.js";
import { refusalNoticeFor } from "./refusal.js";

/** Replies with `replies` in order, repeating the last one. */
class ScriptedChatModel extends BaseChatModel {
  private calls = 0;

  constructor(
    private readonly replies: AIMessage[],
    fields: BaseChatModelParams = {},
  ) {
    super(fields);
  }

  _llmType(): string {
    return "scripted";
  }

  bindTools(): this {
    return this;
  }

  async _generate(): Promise<ChatResult> {
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return { generations: [{ text: reply.text, message: reply }] };
  }
}

function refusal(): AIMessage {
  return new AIMessage({
    content: "",
    response_metadata: {
      model_provider: "anthropic",
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "No." },
    },
  });
}

function taskCall(subagentType: string): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [
      {
        id: "call_task",
        name: "task",
        args: { description: "do it", subagent_type: subagentType },
      },
    ],
  });
}

const NOTICE =
  'The subagent stopped because a model refused the request. Category: cyber. Explanation: "No." Retrying the same request is unlikely to succeed; rephrase it or continue without it.';

describe("model refusals", () => {
  it("raises ModelRefusalError when the main agent's model refuses", async () => {
    const agent = createDeepAgent({
      model: new ScriptedChatModel([refusal()]),
    });

    const error = await agent
      .invoke({ messages: [new HumanMessage("hi")] })
      .catch((e: unknown) => e);
    expect(ModelRefusalError.isInstance(error)).toBe(true);
  });

  it("lets a caller's modelFallbackMiddleware catch the refusal first", async () => {
    const agent = createDeepAgent({
      model: new ScriptedChatModel([refusal()]),
      middleware: [
        modelFallbackMiddleware(
          new ScriptedChatModel([new AIMessage("fallback answer")]),
        ),
      ],
    });

    const result = await agent.invoke({ messages: [new HumanMessage("hi")] });
    expect((result.messages as BaseMessage[]).at(-1)?.text).toBe(
      "fallback answer",
    );
  });

  it("reports a subagent's refusal to the main agent as the task result", async () => {
    const agent = createDeepAgent({
      model: new ScriptedChatModel([taskCall("worker"), new AIMessage("done")]),
      subagents: [
        {
          name: "worker",
          description: "Does work.",
          systemPrompt: "Work.",
          model: new ScriptedChatModel([refusal()]),
        },
      ],
    });

    const result = await agent.invoke({ messages: [new HumanMessage("hi")] });
    const messages = result.messages as BaseMessage[];
    expect(messages.find(ToolMessage.isInstance)?.content).toBe(NOTICE);
    expect(messages.at(-1)?.text).toBe("done");
  });

  it("reports a refusal that ends a compiled subagent's run", async () => {
    const worker = createAgent({ model: new ScriptedChatModel([refusal()]) });
    const agent = createDeepAgent({
      model: new ScriptedChatModel([taskCall("worker"), new AIMessage("done")]),
      subagents: [
        { name: "worker", description: "Does work.", runnable: worker },
      ],
    });

    const result = await agent.invoke({ messages: [new HumanMessage("hi")] });
    const messages = result.messages as BaseMessage[];
    expect(messages.find(ToolMessage.isInstance)?.content).toBe(NOTICE);
  });
});

describe("refusalNoticeFor", () => {
  it("uses the refusal block of the raw message", () => {
    const error = new ModelRefusalError("refused", { rawMessage: refusal() });
    expect(refusalNoticeFor(error)).toBe(NOTICE);
  });

  it("falls back to the error message without a raw message", () => {
    expect(refusalNoticeFor(new ModelRefusalError("Model refused."))).toBe(
      'The subagent stopped because a model refused the request. Explanation: "Model refused." Retrying the same request is unlikely to succeed; rephrase it or continue without it.',
    );
  });

  it("reports a structured output parse error caused by a refusal", () => {
    const error = new StructuredOutputParsingError(
      "extract",
      ["bad"],
      refusal(),
    );
    expect(refusalNoticeFor(error)).toBe(NOTICE);
  });

  it("returns undefined for other errors", () => {
    expect(
      refusalNoticeFor(new StructuredOutputParsingError("extract", ["bad"])),
    ).toBeUndefined();
    expect(refusalNoticeFor(new Error("boom"))).toBeUndefined();
  });
});

describe("finalContent", () => {
  it("reports an async subagent's refusal as the task result", () => {
    expect(finalContent({ messages: [refusal()] })).toEqual([
      { type: "text", text: NOTICE },
    ]);
  });
});
