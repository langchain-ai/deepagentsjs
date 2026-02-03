import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { createSummarizationMiddleware } from "./summarization.js";
import type {
  BackendProtocol,
  FileDownloadResponse,
  WriteResult,
  EditResult,
} from "../backends/protocol.js";

// Mock the OpenAI module with a class constructor
vi.mock("@langchain/openai", () => {
  return {
    ChatOpenAI: class MockChatOpenAI {
      constructor(_config: any) {}
      async invoke(_messages: any) {
        return {
          content: "This is a summary of the conversation.",
        };
      }
    },
  };
});

// Create a mock backend
function createMockBackend(
  options: {
    files?: Record<string, string>;
    writeError?: string;
  } = {},
): BackendProtocol {
  const { files = {}, writeError } = options;
  const writtenFiles: Record<string, string> = { ...files };

  return {
    async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
      return paths.map((path) => {
        const content = writtenFiles[path];
        if (content === undefined) {
          return { path, error: "file_not_found", content: null };
        }
        return {
          path,
          content: new TextEncoder().encode(content),
          error: null,
        };
      });
    },
    async write(path: string, content: string): Promise<WriteResult> {
      if (writeError) {
        return { error: writeError };
      }
      writtenFiles[path] = content;
      return { path };
    },
    async edit(
      path: string,
      _oldString: string,
      newString: string,
    ): Promise<EditResult> {
      if (writeError) {
        return { error: writeError };
      }
      writtenFiles[path] = newString;
      return { path, occurrences: 1 };
    },
  } as unknown as BackendProtocol;
}

describe("createSummarizationMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("basic functionality", () => {
    it("should return undefined when no messages", async () => {
      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: createMockBackend(),
        trigger: { type: "messages", value: 5 },
      });

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages: [] });
      expect(result).toBeUndefined();
    });

    it("should return undefined when under trigger threshold", async () => {
      const middleware = createSummarizationMiddleware({
        model: "gpt-4o-mini",
        backend: createMockBackend(),
        trigger: { type: "messages", value: 10 },
      });

      const messages = [
        new HumanMessage({ content: "Hello" }),
        new AIMessage({ content: "Hi there!" }),
      ];

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });
      expect(result).toBeUndefined();
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });
      expect(result).toBeUndefined();
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      expect(result).toBeDefined();
      expect(result?.messages).toBeDefined();
      // Should have summary message + 2 preserved messages
      expect(result?.messages.length).toBe(3);
      // First message should be the summary
      expect(result?.messages[0]).toBeInstanceOf(HumanMessage);
      expect(result?.messages[0].content).toContain("summary");
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      expect(result).toBeDefined();
      expect(result?.messages).toBeDefined();
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      expect(result).toBeDefined();
      // Summary message (1) + preserved messages (3) = 4
      expect(result?.messages.length).toBe(4);
      // Last 3 messages should be preserved (Message 7, 8, 9)
      expect(result?.messages[1].content).toBe("Message 7");
      expect(result?.messages[2].content).toBe("Message 8");
      expect(result?.messages[3].content).toBe("Message 9");
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

      // @ts-expect-error - typing issue
      await middleware.beforeModel?.({ messages });

      expect(writtenContent.length).toBe(1);
      expect(writtenContent[0]).toContain("Summarized at");
      // Should contain the older messages that were offloaded
      expect(writtenContent[0]).toContain("Message 0");
    });

    it("should not proceed with summarization if backend write fails", async () => {
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      // Should return undefined if offloading fails
      expect(result).toBeUndefined();
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      expect(result).toBeDefined();
      const summaryMessage = result?.messages[0];
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      const summaryMessage = result?.messages[0];
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      expect(result).toBeDefined();
      expect(result?.messages).toBeDefined();
      // The truncated AI message should have truncated content
      const aiMessage = result?.messages.find(AIMessage.isInstance);
      if (aiMessage) {
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      expect(result).toBeDefined();
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

      // @ts-expect-error - typing issue
      await middleware.beforeModel?.({ messages });

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

      // @ts-expect-error - typing issue
      await middleware.beforeModel?.({ messages });

      expect(writtenPath).toContain("/custom/history/");
    });
  });
});
