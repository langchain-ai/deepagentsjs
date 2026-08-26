import { describe, it, expect, vi } from "vitest";
import { createDeepAgent } from "./agent.js";
import { isAnthropicModel } from "./utils.js";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { todoListMiddleware, tool } from "langchain";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver, StateSchema } from "@langchain/langgraph";
import { createFileData } from "./backends/utils.js";
import { ConfigurationError } from "./errors.js";
import { assertAllDeepAgentQualities } from "./testing/utils.js";
import { registerHarnessProfile } from "./profiles/harness/index.js";
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

describe("Legacy system prompt assembly", () => {
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

  it("supports deprecated structured system prompt configuration", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    try {
      const agent = createDeepAgent({
        model: new FakeListChatModel({ responses: ["Done"] }),
        systemPrompt: {
          prefix: "__prefix__",
          base: "__base__",
          suffix: "__suffix__",
        },
      });
      await agent.invoke({ messages: [new HumanMessage("Hello")] });

      expect(
        getLastSystemMessage(invokeSpy).text.replaceAll("\u200B", "").trim(),
      ).toBe("__prefix__\n\n__base__\n\n__suffix__");
    } finally {
      invokeSpy.mockRestore();
    }
  });

  it("does not append an authored base prompt", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");

    try {
      const agent = createDeepAgent({
        model: new FakeListChatModel({ responses: ["Done"] }),
        systemPrompt: "__custom_prompt__",
      });
      await agent.invoke({ messages: [new HumanMessage("Hello")] });

      const prompt = getLastSystemMessage(invokeSpy).text;
      expect(prompt.replaceAll("\u200B", "").trim()).toBe("__custom_prompt__");
    } finally {
      invokeSpy.mockRestore();
    }
  });

  it("does not inject a system prompt by default", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    try {
      const agent = createDeepAgent({
        model: new FakeListChatModel({ responses: ["Done"] }),
      });
      await agent.invoke({ messages: [new HumanMessage("Hello")] });

      const lastCall = invokeSpy.mock.calls[invokeSpy.mock.calls.length - 1];
      const messages = lastCall?.[0] as BaseMessage[] | undefined;
      expect(messages?.some(SystemMessage.isInstance)).toBe(false);
    } finally {
      invokeSpy.mockRestore();
    }
  });

  it("preserves SystemMessage content blocks without appending an authored base", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const customPrompt = new SystemMessage({
      content: [
        {
          type: "text",
          text: "__cached_custom_prompt__",
          cache_control: { type: "ephemeral" },
        },
      ],
    });

    try {
      const agent = createDeepAgent({
        model: new FakeListChatModel({ responses: ["Done"] }),
        systemPrompt: customPrompt,
      });
      await agent.invoke({ messages: [new HumanMessage("Hello")] });

      const blocks = getLastSystemMessage(invokeSpy).contentBlocks;
      const customIndex = blocks.findIndex(
        (block) =>
          block.type === "text" && block.text === "__cached_custom_prompt__",
      );
      expect(blocks[customIndex]?.cache_control).toEqual({
        type: "ephemeral",
      });
      expect(getLastSystemMessage(invokeSpy).text).not.toContain(
        "You are a Deep Agent",
      );
    } finally {
      invokeSpy.mockRestore();
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

  it("should cache the system prompt and memory independently", async () => {
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

    // Default agents no longer add the todo middleware's static prompt block.
    expect(blocks).toHaveLength(2);

    // The system prompt is now the final static block, so the cache breakpoint
    // is attached directly to it.
    const systemBlock = blocks[0];
    expect(systemBlock.cache_control).toEqual({ type: "ephemeral" });
    expect(systemBlock.text).toContain("You are a helpful assistant.");

    // Memory block (last) has its own cache control (set by memory middleware)
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

  it("rejects excluded calls while executing allowed calls", async () => {
    registerHarnessProfile("executiontest", {
      excludedTools: ["excluded_tool"],
    });
    const excludedHandler = vi.fn(() => "excluded");
    const excludedTool = tool(excludedHandler, {
      name: "excluded_tool",
      description: "Excluded tool",
      schema: z.object({}),
    });
    const allowedHandler = vi.fn(() => "allowed");
    const allowedTool = tool(allowedHandler, {
      name: "allowed_tool",
      description: "Allowed tool",
      schema: z.object({}),
    });
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            { name: "excluded_tool", args: {}, id: "excluded_call" },
            { name: "allowed_tool", args: {}, id: "allowed_call" },
          ],
        }) as unknown as string,
        "Done",
      ],
    });
    vi.spyOn(model, "getName").mockReturnValue("ConfigurableModel");
    (model as any)._defaultConfig = {
      modelProvider: "executiontest",
      model: "model",
    };

    const result = await createDeepAgent({
      model,
      tools: [excludedTool, allowedTool],
    }).invoke({ messages: [new HumanMessage("Run the tools")] });
    const toolMessages = result.messages.filter(ToolMessage.isInstance);

    expect(excludedHandler).not.toHaveBeenCalled();
    expect(allowedHandler).toHaveBeenCalledOnce();
    expect(toolMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "excluded_tool",
          status: "error",
          content: "Error: excluded_tool is not available.",
        }),
        expect.objectContaining({ name: "allowed_tool", content: "allowed" }),
      ]),
    );
  });
});

describe("Todo list middleware", () => {
  function getToolNames(agent: unknown): string[] {
    const tools = (agent as any).graph?.nodes?.tools?.bound?.tools ?? [];
    return tools.map((tool: { name: string }) => tool.name);
  }

  it("does not include todos by default", () => {
    const agent = createDeepAgent({
      model: new FakeListChatModel({ responses: ["Done"] }),
    });

    expect(getToolNames(agent)).not.toContain("write_todos");
    expect(Object.keys(agent.graph?.channels ?? {})).not.toContain("todos");
  });

  it("adds todos when explicitly opted in", () => {
    const agent = createDeepAgent({
      model: new FakeListChatModel({ responses: ["Done"] }),
      middleware: [todoListMiddleware()],
    });

    expect(getToolNames(agent)).toContain("write_todos");
    expect(Object.keys(agent.graph?.channels ?? {})).toContain("todos");
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

  it("should throw when colliding with the subagent tool name", () => {
    expect(() =>
      createDeepAgent({
        model,
        tools: [makeTool("task")],
      }),
    ).toThrow(ConfigurationError);
  });

  it("allows a custom write_todos tool without todo middleware", () => {
    expect(() =>
      createDeepAgent({ model, tools: [makeTool("write_todos")] }),
    ).not.toThrow();
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
