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

  describe("orphaned ToolMessages (should remove)", () => {
    it("should remove orphaned ToolMessages at the start of the message array", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new ToolMessage({
          content: "orphaned result 1",
          name: "ls",
          tool_call_id: "orphan_1",
        }),
        new ToolMessage({
          content: "orphaned result 2",
          name: "read_file",
          tool_call_id: "orphan_2",
        }),
        new HumanMessage({ content: "List files in /workspace" }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });

      expect(result).toBeDefined();
      // RemoveMessage + 1 HumanMessage (orphaned ToolMessages removed)
      expect(result?.messages.length).toBe(2);

      const firstMsg = result?.messages[0];
      expect(firstMsg).toBeInstanceOf(RemoveMessage);

      // No ToolMessages should remain
      const toolMessages = result?.messages.filter((m: any) =>
        ToolMessage.isInstance(m),
      );
      expect(toolMessages?.length).toBe(0);
    });

    it("should remove orphaned ToolMessages in the middle of the message array", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new HumanMessage({ content: "Hello" }),
        new ToolMessage({
          content: "orphaned result",
          name: "some_tool",
          tool_call_id: "orphan_mid",
        }),
        new AIMessage({ content: "Hi there!" }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });

      expect(result).toBeDefined();
      // RemoveMessage + HumanMessage + AIMessage (orphaned ToolMessage removed)
      expect(result?.messages.length).toBe(3);

      const toolMessages = result?.messages.filter((m: any) =>
        ToolMessage.isInstance(m),
      );
      expect(toolMessages?.length).toBe(0);
    });

    it("should keep ToolMessages that have a matching AIMessage tool_call", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new ToolMessage({
          content: "orphaned - should be removed",
          name: "rogue_tool",
          tool_call_id: "no_match",
        }),
        new HumanMessage({ content: "Read file" }),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_valid",
              name: "read_file",
              args: { path: "/test.txt" },
            },
          ],
        }),
        new ToolMessage({
          content: "File contents",
          name: "read_file",
          tool_call_id: "call_valid",
        }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });

      expect(result).toBeDefined();
      // RemoveMessage + HumanMessage + AIMessage + valid ToolMessage
      expect(result?.messages.length).toBe(4);

      // The valid ToolMessage should remain
      const validToolMsg = result?.messages.find(
        (m: any) =>
          ToolMessage.isInstance(m) && m.tool_call_id === "call_valid",
      );
      expect(validToolMsg).toBeDefined();
      expect(validToolMsg?.content).toBe("File contents");

      // The orphaned ToolMessage should be gone
      const orphanedToolMsg = result?.messages.find(
        (m: any) => ToolMessage.isInstance(m) && m.tool_call_id === "no_match",
      );
      expect(orphanedToolMsg).toBeUndefined();
    });
  });

  describe("combined orphaned ToolMessages + dangling tool_calls (Gemini issue #314)", () => {
    it("should handle the exact scenario from the GitHub issue checkpoint dump", async () => {
      const middleware = createPatchToolCallsMiddleware();
      // Reproduces the checkpoint state reported in deepagentsjs#314:
      //   Message 1 [ToolMessage]: no preceding AI call
      //   Message 2 [ToolMessage]: no preceding AI call
      //   Message 3 [AIMessage]: 2 tool calls: ['ls', 'ls']
      //   Message 4 [AIMessage]: 1 tool call: ['write_todos']
      //   Message 5 [ToolMessage]: 1 response (for ls call_ls_1 only)
      const messages = [
        new ToolMessage({
          content: "orphaned response 1",
          name: "some_init_tool",
          tool_call_id: "orphan_1",
        }),
        new ToolMessage({
          content: "orphaned response 2",
          name: "some_init_tool",
          tool_call_id: "orphan_2",
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call_ls_1", name: "ls", args: { path: "/" } },
            { id: "call_ls_2", name: "ls", args: { path: "/workspace" } },
          ],
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call_todos", name: "write_todos", args: { todos: [] } },
          ],
        }),
        new ToolMessage({
          content: "file1.txt\nfile2.txt",
          name: "ls",
          tool_call_id: "call_ls_1",
        }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });

      expect(result).toBeDefined();

      // Filter out the RemoveMessage to inspect the patched content
      const patched = result?.messages.filter(
        (m: any) => !RemoveMessage.isInstance(m),
      );

      // Orphaned ToolMessages (orphan_1, orphan_2) should be removed
      const orphanedMsgs = patched?.filter(
        (m: any) =>
          ToolMessage.isInstance(m) &&
          (m.tool_call_id === "orphan_1" || m.tool_call_id === "orphan_2"),
      );
      expect(orphanedMsgs?.length).toBe(0);

      // Valid ToolMessage for call_ls_1 should be preserved
      const validLsMsg = patched?.find(
        (m: any) => ToolMessage.isInstance(m) && m.tool_call_id === "call_ls_1",
      );
      expect(validLsMsg).toBeDefined();
      expect(validLsMsg?.content).toBe("file1.txt\nfile2.txt");

      // Synthetic ToolMessage for dangling call_ls_2 should be injected
      const syntheticLs2 = patched?.find(
        (m: any) =>
          ToolMessage.isInstance(m) &&
          m.tool_call_id === "call_ls_2" &&
          typeof m.content === "string" &&
          m.content.includes("cancelled"),
      );
      expect(syntheticLs2).toBeDefined();

      // Synthetic ToolMessage for dangling call_todos should be injected
      const syntheticTodos = patched?.find(
        (m: any) =>
          ToolMessage.isInstance(m) &&
          m.tool_call_id === "call_todos" &&
          typeof m.content === "string" &&
          m.content.includes("cancelled"),
      );
      expect(syntheticTodos).toBeDefined();

      // Every AIMessage tool_call should have exactly one ToolMessage response
      const aiMessages = patched?.filter((m: any) => AIMessage.isInstance(m));
      for (const aiMsg of aiMessages!) {
        for (const tc of (aiMsg as AIMessage).tool_calls ?? []) {
          const responses = patched?.filter(
            (m: any) => ToolMessage.isInstance(m) && m.tool_call_id === tc.id,
          );
          expect(responses?.length).toBe(1);
        }
      }

      // No ToolMessage should exist without a matching tool_call
      const allToolCallIds = new Set<string>();
      for (const msg of patched!) {
        if (AIMessage.isInstance(msg) && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            allToolCallIds.add(tc.id!);
          }
        }
      }
      const allToolMsgs = patched?.filter((m: any) =>
        ToolMessage.isInstance(m),
      );
      for (const tm of allToolMsgs!) {
        expect(allToolCallIds.has((tm as ToolMessage).tool_call_id)).toBe(true);
      }
    });

    it("should not patch when there are no orphaned ToolMessages and no dangling tool_calls", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new HumanMessage({ content: "Hello" }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call_1", name: "ls", args: {} },
            { id: "call_2", name: "read_file", args: {} },
          ],
        }),
        new ToolMessage({
          content: "result 1",
          name: "ls",
          tool_call_id: "call_1",
        }),
        new ToolMessage({
          content: "result 2",
          name: "read_file",
          tool_call_id: "call_2",
        }),
        new AIMessage({ content: "Done!" }),
      ];

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({ messages });
      expect(result).toBeUndefined();
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

    it("should remove orphaned ToolMessages in wrapModelCall", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new ToolMessage({
          content: "orphaned",
          name: "rogue",
          tool_call_id: "no_match",
        }),
        new HumanMessage({ content: "Hello" }),
      ];

      const handler = vi.fn().mockResolvedValue({ content: "AI response" });

      await (middleware.wrapModelCall as MiddlewareHandler)(
        { messages, systemPrompt: "test" },
        handler,
      );

      expect(handler).toHaveBeenCalledTimes(1);
      const calledRequest = handler.mock.calls[0][0];

      // Orphaned ToolMessage should be removed
      expect(calledRequest.messages.length).toBe(1);
      expect(calledRequest.messages[0]).toBeInstanceOf(HumanMessage);
    });

    it("should handle both orphaned ToolMessages and dangling tool_calls in wrapModelCall", async () => {
      const middleware = createPatchToolCallsMiddleware();
      const messages = [
        new ToolMessage({
          content: "orphaned",
          name: "rogue",
          tool_call_id: "no_match",
        }),
        new HumanMessage({ content: "Hello" }),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "tool_a", args: {} }],
        }),
        // No ToolMessage for call_1
      ];

      const handler = vi.fn().mockResolvedValue({ content: "AI response" });

      await (middleware.wrapModelCall as MiddlewareHandler)(
        { messages, systemPrompt: "test" },
        handler,
      );

      expect(handler).toHaveBeenCalledTimes(1);
      const calledRequest = handler.mock.calls[0][0];

      // Should have: HumanMessage + AIMessage + synthetic ToolMessage (orphan removed)
      expect(calledRequest.messages.length).toBe(3);

      // No orphaned ToolMessages
      const orphaned = calledRequest.messages.find(
        (m: any) => ToolMessage.isInstance(m) && m.tool_call_id === "no_match",
      );
      expect(orphaned).toBeUndefined();

      // Synthetic ToolMessage for dangling call_1
      const synthetic = calledRequest.messages.find(
        (m: any) =>
          ToolMessage.isInstance(m) &&
          m.tool_call_id === "call_1" &&
          typeof m.content === "string" &&
          m.content.includes("cancelled"),
      );
      expect(synthetic).toBeDefined();
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

    it("should remove orphaned ToolMessages", () => {
      const messages = [
        new ToolMessage({
          content: "orphaned",
          name: "rogue",
          tool_call_id: "no_match",
        }),
        new HumanMessage({ content: "Test" }),
      ];

      const result = patchDanglingToolCalls(messages);

      expect(result.needsPatch).toBe(true);
      expect(result.patchedMessages.length).toBe(1);
      expect(result.patchedMessages[0]).toBeInstanceOf(HumanMessage);
    });

    it("should handle both orphaned ToolMessages and dangling tool_calls", () => {
      const messages = [
        new ToolMessage({
          content: "orphaned",
          name: "rogue",
          tool_call_id: "no_match",
        }),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call_1", name: "tool_a", args: {} }],
        }),
        // No ToolMessage for call_1
      ];

      const result = patchDanglingToolCalls(messages);

      expect(result.needsPatch).toBe(true);
      // AIMessage + synthetic ToolMessage (orphan removed)
      expect(result.patchedMessages.length).toBe(2);

      // No orphaned messages
      const orphaned = result.patchedMessages.find(
        (m) => ToolMessage.isInstance(m) && m.tool_call_id === "no_match",
      );
      expect(orphaned).toBeUndefined();

      // Synthetic ToolMessage injected
      const synthetic = result.patchedMessages.find(
        (m) => ToolMessage.isInstance(m) && m.tool_call_id === "call_1",
      );
      expect(synthetic).toBeDefined();
    });

    it("should produce strict 1:1 parity for multi-tool-call AIMessages", () => {
      const messages = [
        new HumanMessage({ content: "Test" }),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call_1", name: "ls", args: {} },
            { id: "call_2", name: "ls", args: {} },
            { id: "call_3", name: "read_file", args: {} },
          ],
        }),
        // Only call_1 has a response
        new ToolMessage({
          content: "result",
          name: "ls",
          tool_call_id: "call_1",
        }),
      ];

      const result = patchDanglingToolCalls(messages);

      expect(result.needsPatch).toBe(true);

      // Count ToolMessages per tool_call_id
      const toolMsgCounts = new Map<string, number>();
      for (const m of result.patchedMessages) {
        if (ToolMessage.isInstance(m)) {
          const count = toolMsgCounts.get(m.tool_call_id) || 0;
          toolMsgCounts.set(m.tool_call_id, count + 1);
        }
      }

      // Each tool_call should have exactly one ToolMessage
      expect(toolMsgCounts.get("call_1")).toBe(1);
      expect(toolMsgCounts.get("call_2")).toBe(1);
      expect(toolMsgCounts.get("call_3")).toBe(1);
    });
  });
});
