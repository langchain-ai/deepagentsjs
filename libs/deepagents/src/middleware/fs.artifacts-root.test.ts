import { describe, it, expect, vi } from "vitest";
import { createFilesystemMiddleware, NUM_CHARS_PER_TOKEN } from "./fs.js";
import { HumanMessage, ToolMessage } from "langchain";
import { isCommand } from "@langchain/langgraph";
import { CompositeBackend } from "../backends/composite.js";
import { createMockBackend } from "./test.js";
import type { BackendProtocolV2 } from "../backends/protocol.js";

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getCurrentTaskInput: vi.fn(),
  };
});

function makeCompositeBackend(
  mockBackend: BackendProtocolV2,
  artifactsRoot: string,
): CompositeBackend {
  const composite = new CompositeBackend(mockBackend, {}, { artifactsRoot });
  return composite;
}

describe("FilesystemMiddleware artifactsRoot", () => {
  describe("tool result eviction", () => {
    it("should use default /large_tool_results/ prefix with plain backend", async () => {
      const mockBackend = createMockBackend();
      const mockWrite = vi.fn().mockResolvedValue({
        error: null,
        filesUpdate: {
          "/large_tool_results/test-id": {
            content: ["large content"],
            created_at: "2024-01-01T00:00:00Z",
            modified_at: "2024-01-01T00:00:00Z",
          },
        },
      });
      mockBackend.write = mockWrite;

      const middleware = createFilesystemMiddleware({
        backend: mockBackend,
        toolTokenLimitBeforeEvict: 100,
      });

      const largeContent = "x".repeat(100 * NUM_CHARS_PER_TOKEN + 1000);
      const mockMessage = new ToolMessage({
        content: largeContent,
        tool_call_id: "test-id",
        name: "some_tool",
      });
      const mockHandler = vi.fn().mockResolvedValue(mockMessage);
      const request = {
        toolCall: { id: "test-id", name: "some_tool" },
        state: {},
        config: {},
      };

      const result = await middleware.wrapToolCall!(
        request as any,
        mockHandler,
      );

      expect(mockWrite).toHaveBeenCalledWith(
        "/large_tool_results/test-id",
        largeContent,
      );
      expect(isCommand(result)).toBe(true);
      if (isCommand(result)) {
        const update = result.update as any;
        expect(update.messages[0].content).toContain(
          "/large_tool_results/test-id",
        );
      }
    });

    it("should use custom artifactsRoot prefix for tool result eviction", async () => {
      const mockBackend = createMockBackend();
      const mockWrite = vi.fn().mockResolvedValue({
        error: null,
        filesUpdate: {
          "/workspace/large_tool_results/test-id": {
            content: ["large content"],
            created_at: "2024-01-01T00:00:00Z",
            modified_at: "2024-01-01T00:00:00Z",
          },
        },
      });
      mockBackend.write = mockWrite;

      const composite = makeCompositeBackend(mockBackend, "/workspace");
      const middleware = createFilesystemMiddleware({
        backend: composite,
        toolTokenLimitBeforeEvict: 100,
      });

      const largeContent = "x".repeat(100 * NUM_CHARS_PER_TOKEN + 1000);
      const mockMessage = new ToolMessage({
        content: largeContent,
        tool_call_id: "test-id",
        name: "some_tool",
      });
      const mockHandler = vi.fn().mockResolvedValue(mockMessage);
      const request = {
        toolCall: { id: "test-id", name: "some_tool" },
        state: {},
        config: {},
      };

      const result = await middleware.wrapToolCall!(
        request as any,
        mockHandler,
      );

      expect(mockWrite).toHaveBeenCalledWith(
        "/workspace/large_tool_results/test-id",
        largeContent,
      );
      expect(isCommand(result)).toBe(true);
      if (isCommand(result)) {
        const update = result.update as any;
        expect(update.messages[0].content).toContain(
          "/workspace/large_tool_results/test-id",
        );
      }
    });

    it("should normalize trailing slash in artifactsRoot", async () => {
      const mockBackend = createMockBackend();
      const mockWrite = vi.fn().mockResolvedValue({
        error: null,
        filesUpdate: {},
      });
      mockBackend.write = mockWrite;

      const composite = makeCompositeBackend(mockBackend, "/workspace/");
      const middleware = createFilesystemMiddleware({
        backend: composite,
        toolTokenLimitBeforeEvict: 100,
      });

      const largeContent = "x".repeat(100 * NUM_CHARS_PER_TOKEN + 1000);
      const mockMessage = new ToolMessage({
        content: largeContent,
        tool_call_id: "test-id",
        name: "some_tool",
      });
      const mockHandler = vi.fn().mockResolvedValue(mockMessage);
      const request = {
        toolCall: { id: "test-id", name: "some_tool" },
        state: {},
        config: {},
      };

      await middleware.wrapToolCall!(request as any, mockHandler);

      expect(mockWrite).toHaveBeenCalledWith(
        "/workspace/large_tool_results/test-id",
        largeContent,
      );
    });
  });

  describe("HumanMessage eviction", () => {
    it("should use default /conversation_history/ prefix with plain backend", async () => {
      const mockBackend = createMockBackend();
      const mockWrite = vi.fn().mockResolvedValue({
        error: undefined,
        filesUpdate: null,
      });
      mockBackend.write = mockWrite;

      const threshold = 100;
      const middleware = createFilesystemMiddleware({
        backend: mockBackend,
        humanMessageTokenLimitBeforeEvict: threshold,
      });

      const largeContent = "x".repeat(threshold * NUM_CHARS_PER_TOKEN + 1);
      const state = {
        messages: [new HumanMessage({ content: largeContent })],
      };

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.(state);
      expect(result).toBeDefined();

      const writePath = mockWrite.mock.calls[0][0] as string;
      expect(writePath).toMatch(/^\/conversation_history\/[a-f0-9]{12}$/);
    });

    it("should use custom artifactsRoot prefix for HumanMessage eviction", async () => {
      const mockBackend = createMockBackend();
      const mockWrite = vi.fn().mockResolvedValue({
        error: undefined,
        filesUpdate: null,
      });
      mockBackend.write = mockWrite;

      const composite = makeCompositeBackend(mockBackend, "/workspace");
      const threshold = 100;
      const middleware = createFilesystemMiddleware({
        backend: composite,
        humanMessageTokenLimitBeforeEvict: threshold,
      });

      const largeContent = "x".repeat(threshold * NUM_CHARS_PER_TOKEN + 1);
      const state = {
        messages: [new HumanMessage({ content: largeContent })],
      };

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.(state);
      expect(result).toBeDefined();

      const writePath = mockWrite.mock.calls[0][0] as string;
      expect(writePath).toMatch(
        /^\/workspace\/conversation_history\/[a-f0-9]{12}$/,
      );
    });
  });
});
