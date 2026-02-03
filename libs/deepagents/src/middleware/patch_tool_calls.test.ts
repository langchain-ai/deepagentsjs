import { describe, it, expect, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { RemoveMessage } from "@langchain/core/messages";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";

import {
  createPatchToolCallsMiddleware,
  patchDanglingToolCalls,
} from "./patch_tool_calls.js";
import type { MiddlewareHandler } from "./types.js";

describe("createPatchToolCallsMiddleware", () => {
  describe("no patching needed (should return undefined)", () => {
    it("should return undefined when messages is empty", async () => {
      const middleware = createPatchToolCallsMiddleware();
      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages: [] });
      expect(result).toBeUndefined();
    });

    it("should return undefined when messages is undefined", async () => {
      const middleware = createPatchToolCallsMiddleware();
      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages: undefined });
      expect(result).toBeUndefined();
    });

    it("should return undefined when there are no AI messages with tool calls", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new HumanMessage({ content: "Hello" }),
        new AIMessage({ content: "Hi there!" }),
        new HumanMessage({ content: "How are you?" }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });
      expect(result).toBeUndefined();
    });

    it("should return undefined when all tool calls have corresponding ToolMessages", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new HumanMessage({ content: "Read a file" }),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_123",
              name: "read_file",
              args: { path: "/test.txt" },
            },
          ],
        }),
        new ToolMessage({
          content: "File contents here",
          name: "read_file",
          tool_call_id: "call_123",
        }),
        new AIMessage({ content: "Here's the file content" }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });
      expect(result).toBeUndefined();
    });

    it("should return undefined when AI message has empty tool_calls array", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new AIMessage({
          content: "No tools",
          tool_calls: [],
        }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });
      expect(result).toBeUndefined();
    });

    it("should return undefined when AI message has null tool_calls", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new AIMessage({
          content: "Also no tools",
          tool_calls: null as any,
        }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });
      expect(result).toBeUndefined();
    });
  });

  describe("dangling tool calls (should patch)", () => {
    it("should add synthetic ToolMessage for dangling tool call", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new HumanMessage({ content: "Read a file" }),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_123",
              name: "read_file",
              args: { path: "/test.txt" },
            },
          ],
        }),
        new HumanMessage({ content: "Never mind" }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });

      expect(result).toBeDefined();
      // Should have RemoveMessage + 3 original + 1 synthetic ToolMessage
      expect(result?.messages.length).toBe(5);

      // First message should be RemoveMessage
      const firstMsg = result?.messages[0];
      expect(firstMsg).toBeInstanceOf(RemoveMessage);
      expect((firstMsg as RemoveMessage).id).toBe(REMOVE_ALL_MESSAGES);

      // Find the synthetic ToolMessage and verify its content
      const toolMessage = result?.messages.find(
        (m: any) => ToolMessage.isInstance(m) && m.tool_call_id === "call_123",
      );
      expect(toolMessage).toBeDefined();
      expect(toolMessage?.content).toContain("cancelled");
      expect(toolMessage?.name).toBe("read_file");
    });

    it("should patch multiple dangling tool calls in a single AI message", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new HumanMessage({ content: "Do multiple things" }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call_1", name: "tool_a", args: {} },
            { id: "call_2", name: "tool_b", args: {} },
          ],
        }),
        // Both tool calls are dangling
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });

      expect(result).toBeDefined();
      // RemoveMessage + 2 original + 2 synthetic ToolMessages
      expect(result?.messages.length).toBe(5);

      // Should have synthetic ToolMessages for both dangling calls
      const syntheticMsgs = result?.messages.filter(
        (m: any) =>
          ToolMessage.isInstance(m) &&
          (m.tool_call_id === "call_1" || m.tool_call_id === "call_2"),
      );
      expect(syntheticMsgs?.length).toBe(2);
    });

    it("should handle multiple AI messages with dangling tool calls", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "tool_a", args: {} }],
        }),
        new HumanMessage({ content: "msg1" }),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_2", name: "tool_b", args: {} }],
        }),
        new HumanMessage({ content: "msg2" }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });

      expect(result).toBeDefined();
      // RemoveMessage + 4 original + 2 synthetic ToolMessages
      expect(result?.messages.length).toBe(7);

      // Both tool calls should have synthetic responses
      const toolMessage1 = result?.messages.find(
        (m: any) => ToolMessage.isInstance(m) && m.tool_call_id === "call_1",
      );
      const toolMessage2 = result?.messages.find(
        (m: any) => ToolMessage.isInstance(m) && m.tool_call_id === "call_2",
      );

      expect(toolMessage1).toBeDefined();
      expect(toolMessage2).toBeDefined();
    });

    it("should only patch dangling tool calls, not ones with responses", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new HumanMessage({ content: "Do two things" }),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_1",
              name: "read_file",
              args: { path: "/test1.txt" },
            },
            {
              id: "call_2",
              name: "write_file",
              args: { path: "/test2.txt" },
            },
          ],
        }),
        new ToolMessage({
          content: "File written successfully",
          name: "write_file",
          tool_call_id: "call_2",
        }),
        new HumanMessage({ content: "Thanks" }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });

      expect(result).toBeDefined();
      // RemoveMessage + 4 original + 1 synthetic ToolMessage for call_1
      expect(result?.messages.length).toBe(6);

      // Check synthetic ToolMessage for call_1 exists (dangling)
      const syntheticToolMessage = result?.messages.find(
        (m: any) =>
          ToolMessage.isInstance(m) &&
          m.tool_call_id === "call_1" &&
          typeof m.content === "string" &&
          m.content.includes("cancelled"),
      );
      expect(syntheticToolMessage).toBeDefined();

      // Check original ToolMessage for call_2 still exists
      const originalToolMessage = result?.messages.find(
        (m: any) =>
          ToolMessage.isInstance(m) &&
          m.tool_call_id === "call_2" &&
          m.content === "File written successfully",
      );
      expect(originalToolMessage).toBeDefined();
    });
  });

  describe("wrapModelCall (safety net for HITL rejections)", () => {
    it("should pass through when no patching needed", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new HumanMessage({ content: "Hello" }),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "tool_a", args: {} }],
        }),
        new ToolMessage({
          content: "Result",
          name: "tool_a",
          tool_call_id: "call_1",
        }),
      ];

      const handler = vi.fn().mockResolvedValue({ content: "AI response" });
      const request = { messages, systemPrompt: "test" };

      // @ts-expect-error - typing issue in LangChain
      await middleware.wrapModelCall?.(request, handler);

      // Handler should be called with original request (no patching needed)
      expect(handler).toHaveBeenCalledWith(request);
    });

    it("should patch dangling tool calls in wrapModelCall", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new HumanMessage({ content: "Hello" }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call_1", name: "tool_a", args: {} },
            { id: "call_2", name: "tool_b", args: {} },
          ],
        }),
        // Only call_2 has a response - call_1 is dangling
        new ToolMessage({
          content: "Result",
          name: "tool_b",
          tool_call_id: "call_2",
        }),
      ];

      const handler = vi.fn().mockResolvedValue({ content: "AI response" });

      await (middleware.wrapModelCall as MiddlewareHandler)(
        { messages, systemPrompt: "test" },
        handler,
      );

      // Handler should be called with patched messages
      expect(handler).toHaveBeenCalledTimes(1);
      const calledRequest = handler.mock.calls[0][0];

      // Should have patched messages with synthetic ToolMessage for call_1
      expect(calledRequest.messages.length).toBe(4); // original 3 + 1 synthetic

      // Find the synthetic ToolMessage
      const syntheticToolMessage = calledRequest.messages.find(
        (m: any) =>
          ToolMessage.isInstance(m) &&
          m.tool_call_id === "call_1" &&
          typeof m.content === "string" &&
          m.content.includes("cancelled"),
      );
      expect(syntheticToolMessage).toBeDefined();
    });

    it("should handle empty messages in wrapModelCall", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const handler = vi.fn().mockResolvedValue({ content: "AI response" });

      await (middleware.wrapModelCall as MiddlewareHandler)(
        { messages: [], systemPrompt: "test" },
        handler,
      );

      expect(handler).toHaveBeenCalledWith({
        messages: [],
        systemPrompt: "test",
      });
    });
  });

  describe("patchDanglingToolCalls utility function", () => {
    it("should return empty result for empty messages", () => {
      const result = patchDanglingToolCalls([]);
      expect(result.patchedMessages).toEqual([]);
      expect(result.needsPatch).toBe(false);
    });

    it("should detect and patch dangling tool calls", () => {
      const messages = [
        new HumanMessage({ content: "Test" }),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "tool_a", args: {} }],
        }),
        // No ToolMessage for call_1 - it's dangling
      ];

      const result = patchDanglingToolCalls(messages);

      expect(result.needsPatch).toBe(true);
      expect(result.patchedMessages.length).toBe(3); // 2 original + 1 synthetic

      // Verify synthetic ToolMessage was added
      const syntheticMsg = result.patchedMessages.find(
        (m) => ToolMessage.isInstance(m) && m.tool_call_id === "call_1",
      );
      expect(syntheticMsg).toBeDefined();
    });

    it("should not patch when all tool calls have responses", () => {
      const messages = [
        new HumanMessage({ content: "Test" }),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "tool_a", args: {} }],
        }),
        new ToolMessage({
          content: "Result",
          name: "tool_a",
          tool_call_id: "call_1",
        }),
      ];

      const result = patchDanglingToolCalls(messages);

      expect(result.needsPatch).toBe(false);
      expect(result.patchedMessages).toEqual(messages);
    });
  });
});
