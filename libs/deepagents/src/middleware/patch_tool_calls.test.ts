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
    it("should return undefined when no ToolMessages present (normal pre-execution flow)", async () => {
      const middleware = createPatchToolCallsMiddleware();
      // This represents normal flow where model called a tool but it hasn't executed yet
      // The middleware should NOT patch because this is expected behavior
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

      // No ToolMessages present, so this is normal flow - no patching needed
      expect(result).toBeUndefined();
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

    it("should handle mixed scenario: some tool calls have responses, some don't (HITL rejection)", async () => {
      const middleware = createPatchToolCallsMiddleware();
      // This represents HITL rejection scenario: one tool was rejected (has ToolMessage),
      // but another tool call from the same AIMessage doesn't have a response
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

    it("should NOT patch second AIMessage when its tool calls have no response", async () => {
      const middleware = createPatchToolCallsMiddleware();
      // Scenario: multiple AI messages with tool calls
      // First AIMessage has a complete response, second AIMessage has no response
      // The second AIMessage should NOT be patched because none of ITS tool_calls
      // have a partial response (the ToolMessage belongs to first AIMessage)
      const messages = [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "tool_a", args: {} }],
        }),
        new ToolMessage({
          content: "Result for tool_a",
          name: "tool_a",
          tool_call_id: "call_1",
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

      // Second AIMessage's tool_calls have no response yet - this is normal flow
      // Only patch when an AIMessage has PARTIAL responses (some responded, some didn't)
      expect(result).toBeUndefined();
    });

    it("should return undefined when no ToolMessages present (multiple dangling)", async () => {
      const middleware = createPatchToolCallsMiddleware();
      // Multiple AI messages with tool calls but no ToolMessages at all
      // This is normal pre-execution flow, should not patch
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

      // No ToolMessages present, so no patching needed
      expect(result).toBeUndefined();
    });
  });
});
