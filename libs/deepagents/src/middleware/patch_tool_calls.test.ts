import { describe, it, expect } from "vitest";
import {
  HumanMessage,
  AIMessage,
  ToolMessage,
  RemoveMessage,
} from "@langchain/core/messages";
import { createPatchToolCallsMiddleware } from "./patch_tool_calls.js";

describe("createPatchToolCallsMiddleware", () => {
  describe("basic functionality", () => {
    it("should return undefined when empty (no state changes)", async () => {
      const middleware = createPatchToolCallsMiddleware();

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages: [] });
      expect(result).toBeUndefined();
    });

    it("should return undefined when no patching needed", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new HumanMessage({ content: "Hello" }),
        new AIMessage({ content: "Hi there!" }),
        new HumanMessage({ content: "How are you?" }),
      ];

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      // No dangling tool calls, so return undefined (no state changes)
      expect(result).toBeUndefined();
    });
  });

  describe("dangling tool calls", () => {
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      expect(result).toBeDefined();
      // Result includes RemoveMessage + patched messages
      // RemoveMessage + HumanMessage + AIMessage + ToolMessage(synthetic) + HumanMessage = 5
      expect(result?.messages.length).toBe(5);

      // First message should be RemoveMessage
      expect(RemoveMessage.isInstance(result?.messages[0])).toBe(true);

      // Filter out RemoveMessage to check the actual messages
      const actualMessages = result?.messages.filter(
        (m: any) => !RemoveMessage.isInstance(m),
      );

      // Find the synthetic ToolMessage
      const toolMessage = actualMessages.find(
        (m: any) => ToolMessage.isInstance(m) && m.tool_call_id === "call_123",
      );
      expect(toolMessage).toBeDefined();
      expect(toolMessage?.content).toContain("cancelled");
      expect(toolMessage?.name).toBe("read_file");

      // Verify the order: synthetic ToolMessage should be right after AIMessage
      const aiMsgIndex = actualMessages.findIndex(AIMessage.isInstance);
      const toolMsgIndex = actualMessages.findIndex(
        (m: any) => ToolMessage.isInstance(m) && m.tool_call_id === "call_123",
      );
      expect(toolMsgIndex).toBe(aiMsgIndex + 1);
    });

    it("should return undefined when corresponding ToolMessage already exists", async () => {
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      // No dangling tool calls, so return undefined (no state changes)
      expect(result).toBeUndefined();
    });

    it("should handle mixed scenario: some tool calls have responses, some don't", async () => {
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      expect(result).toBeDefined();
      // RemoveMessage + 4 original + 1 synthetic = 6
      expect(result?.messages.length).toBe(6);

      // First message should be RemoveMessage
      expect(RemoveMessage.isInstance(result?.messages[0])).toBe(true);

      // Filter out RemoveMessage to check the actual messages
      const actualMessages = result?.messages.filter(
        (m: any) => !RemoveMessage.isInstance(m),
      );

      // Check synthetic ToolMessage for call_1 exists (dangling)
      const syntheticToolMessage = actualMessages.find(
        (m: any) =>
          ToolMessage.isInstance(m) &&
          m.tool_call_id === "call_1" &&
          typeof m.content === "string" &&
          m.content.includes("cancelled"),
      );
      expect(syntheticToolMessage).toBeDefined();

      // Check original ToolMessage for call_2 still exists
      const originalToolMessage = actualMessages.find(
        (m: any) =>
          ToolMessage.isInstance(m) &&
          m.tool_call_id === "call_2" &&
          m.content === "File written successfully",
      );
      expect(originalToolMessage).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("should return undefined for AI message with empty or null tool_calls", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new AIMessage({
          content: "No tools",
          tool_calls: [],
        }),
        new AIMessage({
          content: "Also no tools",
          tool_calls: null as any,
        }),
      ];

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      // No dangling tool calls, so return undefined (no state changes)
      expect(result).toBeUndefined();
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

      // @ts-expect-error - typing issue
      const result = await middleware.beforeModel?.({ messages });

      expect(result).toBeDefined();
      // RemoveMessage + 4 original + 2 synthetic = 7
      expect(result?.messages.length).toBe(7);

      // First message should be RemoveMessage
      expect(RemoveMessage.isInstance(result?.messages[0])).toBe(true);

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
  });
});
