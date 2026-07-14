import { describe, it, expect, vi } from "vitest";
import { createDeepAgent } from "./agent.js";
import type { SystemPromptConfig } from "./types.js";
import { isAnthropicModel } from "./utils.js";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver, StateSchema } from "@langchain/langgraph";
import { createFileData } from "./backends/utils.js";
import { ConfigurationError } from "./errors.js";
import { assertAllDeepAgentQualities } from "./testing/utils.js";
import {
  _resetRegistryForTesting,
  registerHarnessProfile,
} from "./profiles/harness/index.js";
import { z } from "zod/v4";

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

describe("Structured system prompt configuration", () => {
  function getLastSystemMessage(
    invokeSpy: ReturnType<typeof vi.spyOn>,
  ): SystemMessage {
    const lastCall = invokeSpy.mock.calls[invokeSpy.mock.calls.length - 1];
    const messages = lastCall?.[0] as BaseMessage[] | undefined;
    const systemMessage = messages?.find(SystemMessage.isInstance);
    if (!SystemMessage.isInstance(systemMessage)) {
      throw new Error(
        "Expected the model invocation to include a system message",
      );
    }
    return systemMessage;
  }

  it("assembles configured prompt parts in order", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const cases: Array<{
      systemPrompt: string | SystemPromptConfig;
      ordered: string[];
      absent?: string[];
    }> = [
      {
        systemPrompt: {},
        ordered: ["You are a Deep Agent"],
      },
      {
        systemPrompt: { base: "__base__" },
        ordered: ["__base__"],
        absent: ["You are a Deep Agent"],
      },
      {
        systemPrompt: { prefix: "__prefix__" },
        ordered: ["__prefix__", "You are a Deep Agent"],
      },
      {
        systemPrompt: { suffix: "__suffix__" },
        ordered: ["You are a Deep Agent", "__suffix__"],
      },
      {
        systemPrompt: {
          prefix: "__prefix__",
          base: "__base__",
          suffix: "__suffix__",
        },
        ordered: ["__prefix__", "__base__", "__suffix__"],
        absent: ["You are a Deep Agent"],
      },
      {
        systemPrompt: { base: null, suffix: "__only__" },
        ordered: ["__only__"],
        absent: ["You are a Deep Agent"],
      },
      {
        systemPrompt: "__legacy__",
        ordered: ["__legacy__", "You are a Deep Agent"],
      },
    ];

    try {
      for (const testCase of cases) {
        const model = new FakeListChatModel({ responses: ["Done"] });
        const agent = createDeepAgent({
          model,
          systemPrompt: testCase.systemPrompt,
        });
        await agent.invoke({ messages: [new HumanMessage("Hello")] });

        const text = getLastSystemMessage(invokeSpy).text;
        const positions = testCase.ordered.map((fragment) =>
          text.indexOf(fragment),
        );
        expect(positions.every((position) => position >= 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        for (const fragment of testCase.absent ?? []) {
          expect(text).not.toContain(fragment);
        }
      }
    } finally {
      invokeSpy.mockRestore();
    }
  });

  it("preserves SystemMessage content blocks and cache control", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const cachedPrefix = new SystemMessage({
      content: [
        {
          type: "text",
          text: "__cached_prefix__",
          cache_control: { type: "ephemeral" },
        },
      ],
    });

    try {
      const model = new FakeListChatModel({ responses: ["Done"] });
      const agent = createDeepAgent({
        model,
        systemPrompt: { prefix: cachedPrefix, suffix: "__suffix__" },
      });
      await agent.invoke({ messages: [new HumanMessage("Hello")] });

      const blocks = getLastSystemMessage(invokeSpy).contentBlocks;
      const cachedBlock = blocks.find(
        (block) => block.type === "text" && block.text === "__cached_prefix__",
      );
      expect(cachedBlock?.cache_control).toEqual({ type: "ephemeral" });
      expect(blocks.filter((block) => block.type === "text")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "\n\n" }),
          expect.objectContaining({ text: "__suffix__" }),
        ]),
      );
      const text = getLastSystemMessage(invokeSpy).text;
      expect(text.indexOf("__cached_prefix__")).toBeLessThan(
        text.indexOf("You are a Deep Agent"),
      );
      expect(text.indexOf("You are a Deep Agent")).toBeLessThan(
        text.indexOf("__suffix__"),
      );
    } finally {
      invokeSpy.mockRestore();
    }
  });

  it("gives configured base precedence over the harness profile base", async () => {
    _resetRegistryForTesting();
    registerHarnessProfile("openai", {
      baseSystemPrompt: "__profile_base__",
      systemPromptSuffix: "__profile_suffix__",
    });
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");

    async function invokeWithPrompt(
      systemPrompt: SystemPromptConfig,
    ): Promise<string> {
      const model = new FakeListChatModel({ responses: ["Done"] });
      vi.spyOn(model, "getName").mockReturnValue("ChatOpenAI");
      const agent = createDeepAgent({ model, systemPrompt });
      await agent.invoke({ messages: [new HumanMessage("Hello")] });
      return getLastSystemMessage(invokeSpy).text;
    }

    try {
      const profileBaseText = await invokeWithPrompt({ suffix: "__suffix__" });
      expect(profileBaseText.indexOf("__profile_base__")).toBeLessThan(
        profileBaseText.indexOf("__suffix__"),
      );
      expect(profileBaseText.indexOf("__suffix__")).toBeLessThan(
        profileBaseText.indexOf("__profile_suffix__"),
      );

      const configuredBaseText = await invokeWithPrompt({
        base: "__configured_base__",
        suffix: "__suffix__",
      });
      expect(configuredBaseText).not.toContain("__profile_base__");
      expect(configuredBaseText.indexOf("__configured_base__")).toBeLessThan(
        configuredBaseText.indexOf("__suffix__"),
      );
      expect(configuredBaseText.indexOf("__suffix__")).toBeLessThan(
        configuredBaseText.indexOf("__profile_suffix__"),
      );

      const noBaseText = await invokeWithPrompt({
        base: null,
        suffix: "__suffix__",
      });
      expect(noBaseText).not.toContain("__profile_base__");
      expect(noBaseText.indexOf("__suffix__")).toBeLessThan(
        noBaseText.indexOf("__profile_suffix__"),
      );
    } finally {
      invokeSpy.mockRestore();
      _resetRegistryForTesting();
    }
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

describe("profile tool exclusions", () => {
  it("removes excluded filesystem tools before agent construction", () => {
    registerHarnessProfile("fstoolstest", { excludedTools: ["execute"] });

    const agent = createDeepAgent({ model: "fstoolstest:model" });
    const tools = (agent as any).graph?.nodes?.tools?.bound?.tools ?? [];
    const toolNames = tools.map((tool: { name: string }) => tool.name);

    expect(toolNames).toContain("read_file");
    expect(toolNames).not.toContain("execute");
  });
});

describe("Built-in tool name collision detection", () => {
  const model = new FakeListChatModel({ responses: ["Done"] });

  function makeTool(name: string) {
    return {
      name,
      description: `custom ${name}`,
      schema: {} as any,
      invoke: async () => "ok",
      batch: async () => ["ok"],
    } as any;
  }

  it("should throw ConfigurationError when a user-provided tool collides with a filesystem tool", () => {
    expect(() =>
      createDeepAgent({ model, tools: [makeTool("write_file")] }),
    ).toThrow(ConfigurationError);

    try {
      createDeepAgent({ model, tools: [makeTool("write_file")] });
    } catch (e) {
      expect(ConfigurationError.isInstance(e)).toBe(true);
      expect((e as ConfigurationError).code).toBe("TOOL_NAME_COLLISION");
      expect((e as ConfigurationError).message).toMatch(/write_file/);
    }
  });

  it("should list all colliding names in the error", () => {
    expect(() =>
      createDeepAgent({ model, tools: [makeTool("ls"), makeTool("grep")] }),
    ).toThrow(ConfigurationError);
  });

  it("should throw when colliding with subagent or todo tool names", () => {
    expect(() =>
      createDeepAgent({
        model,
        tools: [makeTool("task"), makeTool("write_todos")],
      }),
    ).toThrow(ConfigurationError);
  });

  it("should not throw when tool names do not collide", () => {
    expect(() =>
      createDeepAgent({ model, tools: [makeTool("my_custom_tool")] }),
    ).not.toThrow();
  });
});

describe("State schema propagation", () => {
  it("should add StateSchema channels to the compiled graph + ensure built-in channels", () => {
    const stateSchema = new StateSchema({
      foo: z.string().default("foo"),
    });
    const model = new FakeListChatModel({ responses: ["Done"] });
    const agent = createDeepAgent({ model, stateSchema });

    const channelNames = Object.keys(agent.graph?.channels ?? {});
    expect(channelNames).toContain("foo");
    assertAllDeepAgentQualities(agent);
  });
});
