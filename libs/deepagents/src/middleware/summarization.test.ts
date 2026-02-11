import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { isCommand } from "@langchain/langgraph";
import {
  createSummarizationMiddleware,
  type SummarizationEvent,
} from "./summarization.js";
import type {
  BackendProtocol,
  FileDownloadResponse,
  WriteResult,
} from "../backends/protocol.js";
import { createMockBackend } from "./test.js";

// Mock the initChatModel function from langchain/chat_models/universal
vi.mock("langchain/chat_models/universal", () => {
  return {
    initChatModel: async (_modelName: string) => {
      return {
        async invoke(_messages: any) {
          return {
            content: "This is a summary of the conversation.",
          };
        },
        // Mock profile with maxInputTokens for testing
        profile: {
          maxInputTokens: 128000,
        },
      };
    },
  };
});

/**
 * Helper to call wrapModelCall and capture what was passed to the handler.
 *
 * Returns { result, capturedRequest } where:
 * - result: the return value from wrapModelCall (AIMessage or Command)
 * - capturedRequest: the request passed to the handler (or null if handler wasn't called)
 */
async function callWrapModelCall(
  middleware: ReturnType<typeof createSummarizationMiddleware>,
  state: Record<string, unknown>,
): Promise<{
  result: any;
  capturedRequest: { messages: BaseMessage[]; [key: string]: any } | null;
}> {
  const messages = (state.messages ?? []) as BaseMessage[];
  let capturedRequest: { messages: BaseMessage[]; [key: string]: any } | null =
    null;

  const mockResponse = new AIMessage({ content: "Mock response" });

  const handler = (req: any) => {
    capturedRequest = req;
    return mockResponse;
  };

  const request: any = {
    messages,
    state,
    model: {},
    systemPrompt: "",
    systemMessage: {},
    tools: [],
    runtime: {},
  };

  const result = await middleware.wrapModelCall!(request, handler);
  return { result, capturedRequest };
}

describe("createSummarizationMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("basic functionality", () => {
    it("should pass through when no messages", async () => {
      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: createMockBackend(),
        trigger: { type: "messages", value: 5 },
      });

      const { result, capturedRequest } = await callWrapModelCall(middleware, {
        messages: [],
      });
      // Handler is called with original request (pass-through)
      expect(AIMessage.isInstance(result)).toBe(true);
      expect(capturedRequest).not.toBeNull();
    });

    it("should pass through when under trigger threshold", async () => {
      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: createMockBackend(),
        trigger: { type: "messages", value: 10 },
      });

      const messages = [
        new HumanMessage({ content: "Hello" }),
        new AIMessage({ content: "Hi there!" }),
      ];

      const { result, capturedRequest } = await callWrapModelCall(middleware, {
        messages,
      });
      expect(AIMessage.isInstance(result)).toBe(true);
      expect(capturedRequest).not.toBeNull();
      // Messages should be passed through unchanged
      expect(capturedRequest!.messages).toHaveLength(2);
    });

    it("should not summarize when no trigger configured", async () => {
      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: createMockBackend(),
        // No trigger configured
      });

      const messages = Array.from(
        { length: 100 },
        (_, i) => new HumanMessage({ content: `Message ${i}` }),
      );

      const { result, capturedRequest } = await callWrapModelCall(middleware, {
        messages,
      });
      expect(AIMessage.isInstance(result)).toBe(true);
      expect(capturedRequest).not.toBeNull();
    });
  });

  describe("message count trigger", () => {
    it("should trigger summarization when message count exceeds threshold", async () => {
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

      const { result, capturedRequest } = await callWrapModelCall(middleware, {
        messages,
      });

      // Should return a Command with summarization event
      expect(isCommand(result)).toBe(true);
      const cmd = result as any;
      expect(cmd.update).toBeDefined();
      expect(cmd.update._summarizationEvent).toBeDefined();

      // Handler should have been called with summarized messages
      expect(capturedRequest).not.toBeNull();
      // Should have summary message + 2 preserved messages
      expect(capturedRequest!.messages).toHaveLength(3);
      // First message should be the summary
      expect(HumanMessage.isInstance(capturedRequest!.messages[0])).toBe(true);
      expect(capturedRequest!.messages[0].content).toContain("summary");
    });
  });

  describe("token count trigger", () => {
    it("should trigger summarization when token count exceeds threshold", async () => {
      const mockBackend = createMockBackend();
      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: mockBackend,
        trigger: { type: "tokens", value: 100 }, // Low threshold for testing
        keep: { type: "messages", value: 2 },
      });

      // Create messages with enough content to exceed token threshold
      const messages = Array.from(
        { length: 10 },
        (_, i) =>
          new HumanMessage({
            content: `Message ${i} with some extra content to increase token count`,
          }),
      );

      const { result, capturedRequest } = await callWrapModelCall(middleware, {
        messages,
      });

      expect(isCommand(result)).toBe(true);
      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.messages).toBeDefined();
    });
  });

  describe("fraction trigger", () => {
    it("should trigger summarization when token count exceeds fraction of maxInputTokens", async () => {
      const mockBackend = createMockBackend();

      // Create a mock model with profile containing low maxInputTokens
      const mockModelWithProfile = {
        profile: {
          maxInputTokens: 200, // Low threshold for testing (100 tokens = 50%)
        },
        async invoke(_messages: any) {
          return {
            content: "This is a summary of the conversation.",
          };
        },
      };

      const middleware = createSummarizationMiddleware({
        model: mockModelWithProfile as any,
        backend: mockBackend,
        trigger: { type: "fraction", value: 0.5 }, // 50% of maxInputTokens
        keep: { type: "messages", value: 2 },
      });

      // Create messages with enough content to exceed 100 tokens (50% of 200)
      const messages = Array.from(
        { length: 10 },
        (_, i) =>
          new HumanMessage({
            content: `Message ${i} with some extra content to increase token count`,
          }),
      );

      const { result, capturedRequest } = await callWrapModelCall(middleware, {
        messages,
      });

      expect(isCommand(result)).toBe(true);
      expect(capturedRequest).not.toBeNull();
      // Should have summary message + 2 preserved messages
      expect(capturedRequest!.messages).toHaveLength(3);
    });

    it("should not trigger fraction-based summarization when model has no profile", async () => {
      const mockBackend = createMockBackend();

      // Create a mock model WITHOUT a profile (no maxInputTokens)
      const mockModelWithoutProfile = {
        async invoke(_messages: any) {
          return {
            content: "This is a summary of the conversation.",
          };
        },
        // No profile property
      };

      const middleware = createSummarizationMiddleware({
        model: mockModelWithoutProfile as any,
        backend: mockBackend,
        trigger: { type: "fraction", value: 0.5 },
        keep: { type: "messages", value: 2 },
        // maxInputTokens is NOT provided and model has no profile
      });

      // Create messages with content
      const messages = Array.from(
        { length: 10 },
        (_, i) =>
          new HumanMessage({
            content: `Message ${i} with some extra content`,
          }),
      );

      const { result } = await callWrapModelCall(middleware, { messages });

      // Without maxInputTokens (no explicit option and no model profile), fraction trigger should not fire
      // Result should be a pass-through AIMessage, not a Command
      expect(AIMessage.isInstance(result)).toBe(true);
      expect(isCommand(result)).toBe(false);
    });

    it("should not trigger when token count is below fraction threshold", async () => {
      const mockBackend = createMockBackend();

      // Create a mock model with high maxInputTokens in profile
      const mockModelWithHighLimit = {
        profile: {
          maxInputTokens: 100000, // Very high threshold
        },
        async invoke(_messages: any) {
          return {
            content: "This is a summary of the conversation.",
          };
        },
      };

      const middleware = createSummarizationMiddleware({
        model: mockModelWithHighLimit as any,
        backend: mockBackend,
        trigger: { type: "fraction", value: 0.9 }, // 90% of maxInputTokens
        keep: { type: "messages", value: 2 },
      });

      // Create just a few short messages
      const messages = [
        new HumanMessage({ content: "Hello" }),
        new AIMessage({ content: "Hi" }),
      ];

      const { result } = await callWrapModelCall(middleware, { messages });

      // Token count is far below 90% of 100000, so should not trigger
      expect(AIMessage.isInstance(result)).toBe(true);
      expect(isCommand(result)).toBe(false);
    });
  });

  describe("keep policy", () => {
    it("should preserve specified number of recent messages", async () => {
      const mockBackend = createMockBackend();
      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: mockBackend,
        trigger: { type: "messages", value: 5 },
        keep: { type: "messages", value: 3 },
      });

      const messages = Array.from(
        { length: 10 },
        (_, i) => new HumanMessage({ content: `Message ${i}` }),
      );

      const { result, capturedRequest } = await callWrapModelCall(middleware, {
        messages,
      });

      expect(isCommand(result)).toBe(true);
      expect(capturedRequest).not.toBeNull();
      // Summary message (1) + preserved messages (3) = 4
      expect(capturedRequest!.messages).toHaveLength(4);
      // Last 3 messages should be preserved (Message 7, 8, 9)
      expect(capturedRequest!.messages[1].content).toBe("Message 7");
      expect(capturedRequest!.messages[2].content).toBe("Message 8");
      expect(capturedRequest!.messages[3].content).toBe("Message 9");
    });
  });

  describe("backend offloading", () => {
    it("should write conversation history to backend", async () => {
      const writtenContent: string[] = [];
      const mockBackend = {
        ...createMockBackend(),
        async write(path: string, content: string): Promise<WriteResult> {
          writtenContent.push(content);
          return { path };
        },
      } as unknown as BackendProtocol;

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

      await callWrapModelCall(middleware, { messages });

      expect(writtenContent.length).toBe(1);
      expect(writtenContent[0]).toContain("Summarized at");
      // Should contain the older messages that were offloaded
      expect(writtenContent[0]).toContain("Message 0");
    });

    it("should pass through if backend write fails", async () => {
      const mockBackend = createMockBackend({ writeError: "Write failed" });

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

      const { result } = await callWrapModelCall(middleware, { messages });

      // Should pass through (no Command returned) if offloading fails
      expect(AIMessage.isInstance(result)).toBe(true);
      expect(isCommand(result)).toBe(false);
    });
  });

  describe("summary message", () => {
    it("should include file path reference in summary message", async () => {
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

      const { result, capturedRequest } = await callWrapModelCall(middleware, {
        messages,
      });

      expect(isCommand(result)).toBe(true);
      expect(capturedRequest).not.toBeNull();
      const summaryMessage = capturedRequest!.messages[0];
      expect(summaryMessage.content).toContain("/conversation_history/");
      expect(summaryMessage.content).toContain("saved to");
    });

    it("should mark summary message with lc_source", async () => {
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
      expect(summaryMessage.additional_kwargs?.lc_source).toBe("summarization");
    });
  });

  describe("argument truncation", () => {
    it("should truncate large tool call arguments", async () => {
      const mockBackend = createMockBackend();
      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: mockBackend,
        trigger: { type: "messages", value: 20 }, // High threshold so we only test truncation
        truncateArgsSettings: {
          trigger: { type: "messages", value: 3 },
          keep: { type: "messages", value: 1 },
          maxLength: 50,
          truncationText: "...(truncated)",
        },
      });

      const largeContent = "x".repeat(100);
      const messages = [
        new HumanMessage({ content: "Write a file" }),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_1",
              name: "write_file",
              args: { path: "/test.txt", content: largeContent },
            },
          ],
        }),
        new HumanMessage({ content: "Done" }),
        new HumanMessage({ content: "Recent message" }),
      ];

      const { result, capturedRequest } = await callWrapModelCall(middleware, {
        messages,
      });

      // Truncation only - should pass through (no Command)
      expect(AIMessage.isInstance(result)).toBe(true);
      expect(capturedRequest).not.toBeNull();
      // The truncated AI message should have truncated content
      const aiMessage = capturedRequest!.messages.find(AIMessage.isInstance);
      if (aiMessage?.tool_calls) {
        expect(aiMessage.tool_calls[0].args.content).toContain(
          "...(truncated)",
        );
        expect(aiMessage.tool_calls[0].args.content.length).toBeLessThan(
          largeContent.length,
        );
      }
    });
  });

  describe("multiple triggers", () => {
    it("should support array of triggers", async () => {
      const mockBackend = createMockBackend();
      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: mockBackend,
        trigger: [
          { type: "messages", value: 100 }, // Won't trigger
          { type: "tokens", value: 50 }, // Should trigger (low threshold)
        ],
        keep: { type: "messages", value: 2 },
      });

      const messages = Array.from(
        { length: 10 },
        (_, i) =>
          new HumanMessage({ content: `Message ${i} with some content` }),
      );

      const { result } = await callWrapModelCall(middleware, { messages });

      expect(isCommand(result)).toBe(true);
    });
  });

  describe("backend factory", () => {
    it("should work with backend factory function", async () => {
      const mockBackend = createMockBackend();
      const backendFactory = vi.fn().mockReturnValue(mockBackend);

      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: backendFactory,
        trigger: { type: "messages", value: 5 },
        keep: { type: "messages", value: 2 },
      });

      const messages = Array.from(
        { length: 10 },
        (_, i) => new HumanMessage({ content: `Message ${i}` }),
      );

      await callWrapModelCall(middleware, { messages });

      expect(backendFactory).toHaveBeenCalled();
    });
  });

  describe("custom history path", () => {
    it("should use custom history path prefix", async () => {
      let writtenPath = "";
      const mockBackend = {
        ...createMockBackend(),
        async write(path: string, _content: string): Promise<WriteResult> {
          writtenPath = path;
          return { path };
        },
        async downloadFiles(): Promise<FileDownloadResponse[]> {
          return [
            { path: writtenPath, error: "file_not_found", content: null },
          ];
        },
      } as unknown as BackendProtocol;

      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: mockBackend,
        trigger: { type: "messages", value: 5 },
        keep: { type: "messages", value: 2 },
        historyPathPrefix: "/custom/history",
      });

      const messages = Array.from(
        { length: 10 },
        (_, i) => new HumanMessage({ content: `Message ${i}` }),
      );

      await callWrapModelCall(middleware, { messages });

      expect(writtenPath).toContain("/custom/history/");
    });
  });

  describe("summarization event tracking", () => {
    it("should return Command with _summarizationEvent on summarization", async () => {
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

      const { result } = await callWrapModelCall(middleware, { messages });

      expect(isCommand(result)).toBe(true);
      const cmd = result as any;
      const event = cmd.update._summarizationEvent as SummarizationEvent;
      expect(event).toBeDefined();
      expect(event.cutoffIndex).toBe(8); // 10 messages - 2 kept = 8
      expect(HumanMessage.isInstance(event.summaryMessage)).toBe(true);
      expect(event.filePath).not.toBeNull();
    });

    it("should track session ID in Command update", async () => {
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

      const { result } = await callWrapModelCall(middleware, { messages });

      expect(isCommand(result)).toBe(true);
      const cmd = result as any;
      expect(cmd.update._summarizationSessionId).toBeDefined();
      expect(typeof cmd.update._summarizationSessionId).toBe("string");
    });
  });

  describe("chained summarization", () => {
    it("should compute cutoff index correctly across three chained summarizations", async () => {
      const mockBackend = createMockBackend();
      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: mockBackend,
        trigger: { type: "messages", value: 5 },
        keep: { type: "messages", value: 2 },
      });

      function makeStateMessages(n: number): BaseMessage[] {
        return Array.from({ length: n }, (_, i) =>
          i % 2 === 0
            ? new HumanMessage({ content: `S${i}`, id: `s${i}` })
            : new AIMessage({ content: `S${i}`, id: `s${i}` }),
        );
      }

      // --- Round 1: first summarization, no previous event ---
      // State: [S0..S7] (8 messages), cutoff = 8 - 2 = 6
      // Preserved: [S6, S7]. Event: cutoffIndex=6
      const { result: result1, capturedRequest: req1 } =
        await callWrapModelCall(middleware, {
          messages: makeStateMessages(8),
        });

      expect(isCommand(result1)).toBe(true);
      const event1 = (result1 as any).update
        ._summarizationEvent as SummarizationEvent;
      expect(event1.cutoffIndex).toBe(6);
      expect(req1).not.toBeNull();
      // Captured request should have [summary, S6, S7]
      expect(
        req1!.messages.slice(1).map((m: BaseMessage) => m.content),
      ).toEqual(["S6", "S7"]);

      // --- Round 2: second summarization, feed back event from round 1 ---
      // State: [S0..S13] (14 messages)
      // effective = [summary_1, S6..S13] (9 messages), effective cutoff = 9 - 2 = 7
      // state_cutoff = 6 + 7 - 1 = 12. Preserved: [S12, S13]
      const { result: result2, capturedRequest: req2 } =
        await callWrapModelCall(middleware, {
          messages: makeStateMessages(14),
          _summarizationEvent: event1,
        });

      expect(isCommand(result2)).toBe(true);
      const event2 = (result2 as any).update
        ._summarizationEvent as SummarizationEvent;
      expect(event2.cutoffIndex).toBe(12);
      expect(req2).not.toBeNull();
      expect(
        req2!.messages.slice(1).map((m: BaseMessage) => m.content),
      ).toEqual(["S12", "S13"]);

      // --- Round 3: third summarization, feed back event from round 2 ---
      // State: [S0..S19] (20 messages)
      // effective = [summary_2, S12..S19] (9 messages), effective cutoff = 9 - 2 = 7
      // state_cutoff = 12 + 7 - 1 = 18. Preserved: [S18, S19]
      const { result: result3, capturedRequest: req3 } =
        await callWrapModelCall(middleware, {
          messages: makeStateMessages(20),
          _summarizationEvent: event2,
        });

      expect(isCommand(result3)).toBe(true);
      const event3 = (result3 as any).update
        ._summarizationEvent as SummarizationEvent;
      expect(event3.cutoffIndex).toBe(18);
      expect(req3).not.toBeNull();
      expect(
        req3!.messages.slice(1).map((m: BaseMessage) => m.content),
      ).toEqual(["S18", "S19"]);
    });
  });
});
