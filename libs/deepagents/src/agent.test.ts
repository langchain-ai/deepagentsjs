import { beforeEach, describe, it, expect, vi } from "vitest";
import { createDeepAgent } from "./agent.js";
import { isAnthropicModel } from "./utils.js";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createFileData } from "./backends/utils.js";
import { ConfigurationError } from "./errors.js";
import { createMiddleware } from "langchain";
import type { AgentMiddleware } from "langchain";

const { createAgentMock, createSubAgentMiddlewareMock } = vi.hoisted(() => ({
  createAgentMock: vi.fn(),
  createSubAgentMiddlewareMock: vi.fn(),
}));

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  createAgentMock.mockImplementation(actual.createAgent as any);
  return {
    ...actual,
    createAgent: createAgentMock,
  };
});

vi.mock("./middleware/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./middleware/index.js")>();
  createSubAgentMiddlewareMock.mockImplementation(
    actual.createSubAgentMiddleware,
  );
  return {
    ...actual,
    createSubAgentMiddleware: createSubAgentMiddlewareMock,
  };
});

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

describe("createDeepAgent middleware replacement", () => {
  beforeEach(() => {
    createAgentMock.mockClear();
    createSubAgentMiddlewareMock.mockClear();
  });

  it("replaces root middleware by name in place instead of appending", () => {
    createAgentMock.mockImplementationOnce(
      () =>
        ({
          withConfig: vi.fn().mockReturnValue({
            graph: { nodes: { tools: { bound: { tools: [] } } } },
          }),
        }) as any,
    );

    const replacementSummarization = createMiddleware({
      name: "SummarizationMiddleware",
    });
    const customTail = createMiddleware({
      name: "CustomTailMiddleware",
    });

    createDeepAgent({
      model: "openai:gpt-5",
      middleware: [replacementSummarization, customTail],
    });

    const createAgentCall = createAgentMock.mock.calls.at(-1);
    expect(createAgentCall).toBeDefined();
    const middleware = (
      createAgentCall![0] as {
        middleware: AgentMiddleware[];
      }
    ).middleware;
    const names = middleware.map((m: AgentMiddleware) => m.name);

    expect(
      names.filter((n: string) => n === "SummarizationMiddleware"),
    ).toHaveLength(1);

    const summarizationIdx = names.indexOf("SummarizationMiddleware");
    const patchIdx = names.indexOf("patchToolCallsMiddleware");
    const customIdx = names.indexOf("CustomTailMiddleware");

    expect(summarizationIdx).toBeGreaterThanOrEqual(0);
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    expect(customIdx).toBeGreaterThanOrEqual(0);
    expect(summarizationIdx).toBeLessThan(patchIdx);
    expect(customIdx).toBeGreaterThan(patchIdx);
  });

  it("applies same-name replacement for declarative subagent middleware", () => {
    createAgentMock.mockImplementationOnce(
      () =>
        ({
          withConfig: vi.fn().mockReturnValue({
            graph: { nodes: { tools: { bound: { tools: [] } } } },
          }),
        }) as any,
    );

    const replacementSummarization = createMiddleware({
      name: "SummarizationMiddleware",
    });
    const customTail = createMiddleware({
      name: "SubagentCustomTailMiddleware",
    });

    createDeepAgent({
      model: "openai:gpt-5",
      subagents: [
        {
          name: "specialist",
          description: "Specialist agent",
          systemPrompt: "Handle specialist tasks.",
          middleware: [replacementSummarization, customTail],
        },
      ],
    });

    const createSubAgentCall = createSubAgentMiddlewareMock.mock.calls.at(-1);
    expect(createSubAgentCall).toBeDefined();
    const { subagents } = createSubAgentCall![0] as {
      subagents: Array<{ name: string; middleware?: AgentMiddleware[] }>;
    };
    const specialist = subagents.find(
      (s: { name: string }) => s.name === "specialist",
    );
    expect(specialist).toBeDefined();

    const names = (specialist!.middleware ?? []).map(
      (m: AgentMiddleware) => m.name,
    );
    expect(
      names.filter((n: string) => n === "SummarizationMiddleware"),
    ).toHaveLength(1);

    const summarizationIdx = names.indexOf("SummarizationMiddleware");
    const patchIdx = names.indexOf("patchToolCallsMiddleware");
    const customIdx = names.indexOf("SubagentCustomTailMiddleware");

    expect(summarizationIdx).toBeGreaterThanOrEqual(0);
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    expect(customIdx).toBeGreaterThanOrEqual(0);
    expect(summarizationIdx).toBeLessThan(patchIdx);
    expect(customIdx).toBeGreaterThan(patchIdx);
  });
});
