import { describe, it, expect, vi } from "vitest";
import { createDeepAgent, isAnthropicModel } from "./agent.js";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createFileData } from "./backends/utils.js";

describe("isAnthropicModel", () => {
  it("should detect claude model strings", () => {
    expect(isAnthropicModel("claude-sonnet-4-5-20250929")).toBe(true);
    expect(isAnthropicModel("claude-3-opus")).toBe(true);
    expect(isAnthropicModel("claude-haiku")).toBe(true);
  });

  it("should detect anthropic: prefixed model strings", () => {
    expect(isAnthropicModel("anthropic:claude-3-opus")).toBe(true);
    expect(isAnthropicModel("anthropic:claude-sonnet")).toBe(true);
  });

  it("should reject non-Anthropic model strings", () => {
    expect(isAnthropicModel("gpt-4")).toBe(false);
    expect(isAnthropicModel("gemini-pro")).toBe(false);
    expect(isAnthropicModel("openai:gpt-4")).toBe(false);
    expect(isAnthropicModel("google:gemini-pro")).toBe(false);
  });

  it("should detect ChatAnthropic model objects", () => {
    const model = new FakeListChatModel({ responses: [] });
    vi.spyOn(model, "getName").mockReturnValue("ChatAnthropic");
    expect(isAnthropicModel(model)).toBe(true);
  });

  it("should reject non-Anthropic model objects", () => {
    const model = new FakeListChatModel({ responses: [] });
    vi.spyOn(model, "getName").mockReturnValue("ChatOpenAI");
    expect(isAnthropicModel(model)).toBe(false);
  });

  it("should detect ConfigurableModel wrapping an Anthropic provider", () => {
    const model = new FakeListChatModel({ responses: [] });
    vi.spyOn(model, "getName").mockReturnValue("ConfigurableModel");
    (model as any)._defaultConfig = { modelProvider: "anthropic" };
    expect(isAnthropicModel(model)).toBe(true);
  });

  it("should reject ConfigurableModel wrapping a non-Anthropic provider", () => {
    const model = new FakeListChatModel({ responses: [] });
    vi.spyOn(model, "getName").mockReturnValue("ConfigurableModel");
    (model as any)._defaultConfig = { modelProvider: "openai" };
    expect(isAnthropicModel(model)).toBe(false);
  });
});

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
    const blocks = systemMessage!.contentBlocks;
    expect(Array.isArray(blocks)).toBe(true);

    // Should have at least 3 blocks: system prompt + static middleware blocks + memory
    expect(blocks.length).toBeGreaterThanOrEqual(3);

    // System prompt block (first) should NOT have cache_control — the breakpoint
    // is placed on the last static block by createCacheBreakpointMiddleware
    const systemBlock = blocks[0];
    expect(systemBlock.cache_control).toBeUndefined();
    expect(systemBlock.text).toContain("You are a helpful assistant.");

    // Second-to-last block is the last static block — has cache_control
    const lastStaticBlock = blocks[blocks.length - 2];
    expect(lastStaticBlock.cache_control).toEqual({ type: "ephemeral" });

    // Memory block (last) should have its own cache_control (set by memory middleware)
    const memoryBlock = blocks[blocks.length - 1];
    expect(memoryBlock.cache_control).toEqual({ type: "ephemeral" });
    expect(memoryBlock.text).toContain("<agent_memory>");
    expect(memoryBlock.text).toContain("Remember this.");
    invokeSpy.mockRestore();
  });
});
