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
    // Mock getName so isAnthropicModel detects this as an Anthropic model
    vi.spyOn(model, "getName").mockReturnValue("ChatAnthropic");
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
});
