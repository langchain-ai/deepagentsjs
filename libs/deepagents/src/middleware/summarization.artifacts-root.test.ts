import { describe, it, expect, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { createSummarizationMiddleware } from "./summarization.js";
import { CompositeBackend } from "../backends/composite.js";
import { createMockBackend } from "./test.js";
import type { BackendProtocolV2 } from "../backends/protocol.js";

vi.mock("langchain/chat_models/universal", () => {
  return {
    initChatModel: async (_modelName: string) => {
      return {
        async invoke(_messages: any) {
          return {
            content: "This is a summary of the conversation.",
          };
        },
        profile: {
          maxInputTokens: 128000,
        },
      };
    },
  };
});

async function callWrapModelCall(
  middleware: ReturnType<typeof createSummarizationMiddleware>,
  state: Record<string, unknown>,
): Promise<{
  result: any;
  capturedRequest: { messages: BaseMessage[]; [key: string]: any } | null;
}> {
  let capturedRequest: any = null;
  const handler = async (req: any) => {
    capturedRequest = req;
    return req.messages[req.messages.length - 1];
  };

  const request = {
    messages: state.messages as BaseMessage[],
    systemMessage: { concat: (s: string) => s },
    tools: [],
    state,
    runtime: {},
    config: {},
  };

  const result = await middleware.wrapModelCall!(request as any, handler);
  return { result, capturedRequest };
}

function makeCompositeBackend(
  mockBackend: BackendProtocolV2,
  artifactsRoot: string,
): CompositeBackend {
  return new CompositeBackend(mockBackend, {}, { artifactsRoot });
}

describe("SummarizationMiddleware artifactsRoot", () => {
  it("should use default /conversation_history/ prefix with plain backend", async () => {
    const mockBackend = createMockBackend();
    const middleware = createSummarizationMiddleware({
      model: "gpt-4o-mini",
      backend: mockBackend,
      trigger: { type: "messages", value: 5 },
      keep: { type: "messages", value: 2 },
    });

    const messages = Array.from(
      { length: 10 },
      (_, i) => new HumanMessage({ content: `Message ${i}` }),
    );

    const { capturedRequest } = await callWrapModelCall(middleware, {
      messages,
    });

    expect(capturedRequest).not.toBeNull();
    const summaryMessage = capturedRequest!.messages[0];
    expect(summaryMessage.content).toContain("/conversation_history/");
  });

  it("should use custom artifactsRoot prefix from CompositeBackend", async () => {
    const mockBackend = createMockBackend();
    const composite = makeCompositeBackend(mockBackend, "/workspace");
    const middleware = createSummarizationMiddleware({
      model: "gpt-4o-mini",
      backend: composite,
      trigger: { type: "messages", value: 5 },
      keep: { type: "messages", value: 2 },
    });

    const messages = Array.from(
      { length: 10 },
      (_, i) => new HumanMessage({ content: `Message ${i}` }),
    );

    const { capturedRequest } = await callWrapModelCall(middleware, {
      messages,
    });

    expect(capturedRequest).not.toBeNull();
    const summaryMessage = capturedRequest!.messages[0];
    expect(summaryMessage.content).toContain(
      "/workspace/conversation_history/",
    );
  });

  it("should normalize trailing slash in artifactsRoot", async () => {
    const mockBackend = createMockBackend();
    const composite = makeCompositeBackend(mockBackend, "/workspace/");
    const middleware = createSummarizationMiddleware({
      model: "gpt-4o-mini",
      backend: composite,
      trigger: { type: "messages", value: 5 },
      keep: { type: "messages", value: 2 },
    });

    const messages = Array.from(
      { length: 10 },
      (_, i) => new HumanMessage({ content: `Message ${i}` }),
    );

    const { capturedRequest } = await callWrapModelCall(middleware, {
      messages,
    });

    expect(capturedRequest).not.toBeNull();
    const summaryMessage = capturedRequest!.messages[0];
    expect(summaryMessage.content).toContain(
      "/workspace/conversation_history/",
    );
    expect(summaryMessage.content).not.toContain(
      "/workspace//conversation_history/",
    );
  });

  it("should allow explicit historyPathPrefix to override artifactsRoot", async () => {
    const mockBackend = createMockBackend();
    const composite = makeCompositeBackend(mockBackend, "/workspace");
    const middleware = createSummarizationMiddleware({
      model: "gpt-4o-mini",
      backend: composite,
      trigger: { type: "messages", value: 5 },
      keep: { type: "messages", value: 2 },
      historyPathPrefix: "/custom/history",
    });

    const messages = Array.from(
      { length: 10 },
      (_, i) => new HumanMessage({ content: `Message ${i}` }),
    );

    const { capturedRequest } = await callWrapModelCall(middleware, {
      messages,
    });

    expect(capturedRequest).not.toBeNull();
    const summaryMessage = capturedRequest!.messages[0];
    expect(summaryMessage.content).toContain("/custom/history/");
    expect(summaryMessage.content).not.toContain(
      "/workspace/conversation_history/",
    );
  });
});
