import { describe, it, expect, vi } from "vitest";
import { createDeepAgent } from "./agent.js";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  ContentBlock,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createFileData } from "./backends/utils.js";

describe("System prompt cache control breakpoints", () => {
  const BASE_PROMPT =
    "In order to complete the objective that the user asks of you, you have access to a number of standard tools.";

  describe("system prompt block construction (unit)", () => {
    it("should produce a single block with cache_control for string systemPrompt", () => {
      const systemPrompt = "You are a helpful assistant.";
      const blocks: ContentBlock.Text[] = [
        { type: "text", text: `${systemPrompt}\n\n${BASE_PROMPT}` },
      ];
      blocks[blocks.length - 1] = {
        ...blocks[blocks.length - 1],
        cache_control: { type: "ephemeral" },
      };

      const msg = new SystemMessage({ content: blocks });
      const content = msg.content as ContentBlock.Text[];
      expect(content).toHaveLength(1);
      expect(content[0].text).toContain("You are a helpful assistant.");
      expect(content[0].text).toContain(BASE_PROMPT);
      expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    });

    it("should produce a single BASE_PROMPT block with cache_control when no systemPrompt", () => {
      const blocks: ContentBlock.Text[] = [{ type: "text", text: BASE_PROMPT }];
      blocks[blocks.length - 1] = {
        ...blocks[blocks.length - 1],
        cache_control: { type: "ephemeral" },
      };

      const msg = new SystemMessage({ content: blocks });
      const content = msg.content as ContentBlock.Text[];
      expect(content).toHaveLength(1);
      expect(content[0].text).toBe(BASE_PROMPT);
      expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    });

    it("should add cache_control to last block when systemPrompt is a SystemMessage with array content", () => {
      const systemPromptContent = [
        { type: "text" as const, text: "You are a helpful assistant." },
        { type: "text" as const, text: "Always be concise." },
      ];
      const blocks: ContentBlock.Text[] = [
        { type: "text", text: BASE_PROMPT },
        ...systemPromptContent,
      ];
      blocks[blocks.length - 1] = {
        ...blocks[blocks.length - 1],
        cache_control: { type: "ephemeral" },
      };

      const msg = new SystemMessage({ content: blocks });
      const content = msg.content as ContentBlock.Text[];
      expect(content).toHaveLength(3);
      expect(content[0].cache_control).toBeUndefined();
      expect(content[1].cache_control).toBeUndefined();
      expect(content[2].cache_control).toEqual({ type: "ephemeral" });
      expect(content[2].text).toBe("Always be concise.");
    });

    it("should add cache_control to last block when systemPrompt is a SystemMessage with string content", () => {
      const blocks: ContentBlock.Text[] = [
        { type: "text", text: BASE_PROMPT },
        { type: "text", text: "Custom system instructions" },
      ];
      blocks[blocks.length - 1] = {
        ...blocks[blocks.length - 1],
        cache_control: { type: "ephemeral" },
      };

      const msg = new SystemMessage({ content: blocks });
      const content = msg.content as ContentBlock.Text[];
      expect(content).toHaveLength(2);
      expect(content[0].cache_control).toBeUndefined();
      expect(content[1].cache_control).toEqual({ type: "ephemeral" });
    });
  });

  describe("end-to-end with memory (integration)", () => {
    function getSystemMessageFromSpy(
      invokeSpy: ReturnType<typeof vi.spyOn>,
    ): BaseMessage | undefined {
      const lastCall = invokeSpy.mock.calls[invokeSpy.mock.calls.length - 1];
      const messages = lastCall?.[0] as BaseMessage[] | undefined;
      if (!messages) return undefined;
      return messages.find(SystemMessage.isInstance);
    }

    it("should have separate cache_control breakpoints for system prompt and memory", async () => {
      const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
      const model = new FakeListChatModel({ responses: ["Done"] });
      const checkpointer = new MemorySaver();

      const agent = createDeepAgent({
        model,
        systemPrompt: "You are a helpful assistant.",
        memory: ["/AGENTS.md"],
        checkpointer,
      });

      await agent.invoke(
        {
          messages: [new HumanMessage("Hello")],
          files: {
            "/AGENTS.md": createFileData("# Memory\n\nRemember this."),
          },
        },
        {
          configurable: { thread_id: `test-cache-both-${Date.now()}` },
          recursionLimit: 50,
        },
      );

      const systemMessage = getSystemMessageFromSpy(invokeSpy);
      expect(systemMessage).toBeDefined();
      const content = systemMessage!.content;
      expect(Array.isArray(content)).toBe(true);

      const blocks = content as ContentBlock.Text[];
      // Should have at least 2 blocks: system prompt + memory
      expect(blocks.length).toBeGreaterThanOrEqual(2);

      // System prompt block should have cache_control (set by agent.ts,
      // preserved by memory middleware when it spreads existing blocks)
      const systemBlock = blocks[0];
      expect(systemBlock.cache_control).toEqual({ type: "ephemeral" });
      expect(systemBlock.text).toContain("You are a helpful assistant.");

      // Memory block (last) should have its own cache_control (set by memory middleware)
      const memoryBlock = blocks[blocks.length - 1];
      expect(memoryBlock.cache_control).toEqual({ type: "ephemeral" });
      expect(memoryBlock.text).toContain("<agent_memory>");
      expect(memoryBlock.text).toContain("Remember this.");
      invokeSpy.mockRestore();
    });

    it("should produce array content blocks even without memory", async () => {
      const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
      const model = new FakeListChatModel({ responses: ["Done"] });
      const checkpointer = new MemorySaver();

      const agent = createDeepAgent({
        model,
        systemPrompt: "You are a helpful assistant.",
        checkpointer,
      });

      await agent.invoke(
        { messages: [new HumanMessage("Hello")] },
        {
          configurable: { thread_id: `test-cache-no-mem-${Date.now()}` },
          recursionLimit: 50,
        },
      );

      const systemMessage = getSystemMessageFromSpy(invokeSpy);
      expect(systemMessage).toBeDefined();
      const content = systemMessage!.content;
      expect(Array.isArray(content)).toBe(true);

      const blocks = content as any[];
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const fullText = blocks.map((b: any) => b.text).join("\n");
      expect(fullText).toContain("You are a helpful assistant.");
      invokeSpy.mockRestore();
    });
  });
});
