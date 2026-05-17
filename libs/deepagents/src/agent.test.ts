import { describe, it, expect, vi } from "vitest";
import { createDeepAgent } from "./agent.js";
import { isAnthropicModel } from "./utils.js";
import { createMiddleware } from "langchain";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createFileData } from "./backends/utils.js";
import { ConfigurationError } from "./errors.js";
import type { SkillMetadata } from "./skills/discovery.js";
import type { LoadedSkill, SkillProvider } from "./skills/provider.js";

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

describe("Skill registry wiring", () => {
  const model = new FakeListChatModel({ responses: ["Done"] });

  const REGISTRY_SYMBOL = Symbol.for(
    "@langchain/quickjs.code-interpreter.injectSkillRegistry",
  );

  /**
   * Build a minimal in-memory `SkillProvider` for unit tests.
   */
  function stubProvider(
    skills: Array<{ name: string; description?: string }>,
    id = "stub",
  ): SkillProvider {
    return {
      id,
      async list(): Promise<SkillMetadata[]> {
        return skills.map((s) => ({
          name: s.name,
          description: s.description ?? `desc ${s.name}`,
          path: `<${id}>/${s.name}/SKILL.md`,
        }));
      },
      async load(name: string): Promise<LoadedSkill> {
        const match = skills.find((s) => s.name === name);
        if (match === undefined) {
          throw new Error(`unknown skill: ${name}`);
        }
        return {
          metadata: {
            name: match.name,
            description: match.description ?? `desc ${match.name}`,
            path: `<${id}>/${match.name}/SKILL.md`,
          },
          body: `body of ${match.name}`,
          files: new Map(),
        };
      },
    };
  }

  /**
   * Build a middleware that captures a registry injected via the symbol.
   */
  function makeCapturingMiddleware(): {
    middleware: ReturnType<typeof createMiddleware>;
    captured: { registry: unknown };
  } {
    const captured = { registry: undefined as unknown };
    const middleware = createMiddleware({ name: "CapturingMiddleware" });
    Object.defineProperty(middleware, REGISTRY_SYMBOL, {
      value: (registry: unknown) => {
        captured.registry = registry;
      },
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return { middleware, captured };
  }

  it("should inject the registry into custom middleware that opts in via the symbol", () => {
    const { middleware, captured } = makeCapturingMiddleware();
    const provider = stubProvider([{ name: "alpha" }]);

    createDeepAgent({
      model,
      skills: [provider],
      middleware: [middleware],
    });

    expect(captured.registry).not.toBeUndefined();
    const reg = captured.registry as Record<string, unknown>;
    expect(typeof reg.list).toBe("function");
    expect(typeof reg.load).toBe("function");
  });

  it("should not inject when no skills are configured", () => {
    const { middleware, captured } = makeCapturingMiddleware();

    createDeepAgent({
      model,
      middleware: [middleware],
    });

    expect(captured.registry).toBeUndefined();
  });

  it("should skip middleware that does not expose the symbol", () => {
    const plainMiddleware = createMiddleware({ name: "PlainMiddleware" });
    expect(() =>
      createDeepAgent({
        model,
        skills: [stubProvider([{ name: "beta" }])],
        middleware: [plainMiddleware],
      }),
    ).not.toThrow();
  });

  it("should accept a mixed array of strings and SkillProvider instances", () => {
    const { middleware, captured } = makeCapturingMiddleware();
    const provider = stubProvider([{ name: "custom" }], "custom-provider");

    createDeepAgent({
      model,
      skills: ["/skills/", provider],
      middleware: [middleware],
    });

    expect(captured.registry).not.toBeUndefined();
  });

  it("should accept an all-strings skills array (legacy path)", () => {
    const { middleware, captured } = makeCapturingMiddleware();

    createDeepAgent({
      model,
      skills: ["/skills/user/", "/skills/project/"],
      middleware: [middleware],
    });

    expect(captured.registry).not.toBeUndefined();
  });

  it("should accept an all-SkillProvider skills array", () => {
    const { middleware, captured } = makeCapturingMiddleware();
    const providerA = stubProvider([{ name: "a" }], "pa");
    const providerB = stubProvider([{ name: "b" }], "pb");

    createDeepAgent({
      model,
      skills: [providerA, providerB],
      middleware: [middleware],
    });

    expect(captured.registry).not.toBeUndefined();
  });

  it("should not inject when skills array is empty", () => {
    const { middleware, captured } = makeCapturingMiddleware();

    createDeepAgent({
      model,
      skills: [],
      middleware: [middleware],
    });

    expect(captured.registry).toBeUndefined();
  });

  it("should inject into multiple opt-in middleware instances", () => {
    const captured1 = { registry: undefined as unknown };
    const mw1 = createMiddleware({ name: "CapturingMiddlewareA" });
    Object.defineProperty(mw1, REGISTRY_SYMBOL, {
      value: (registry: unknown) => {
        captured1.registry = registry;
      },
      enumerable: false,
      writable: false,
      configurable: false,
    });

    const captured2 = { registry: undefined as unknown };
    const mw2 = createMiddleware({ name: "CapturingMiddlewareB" });
    Object.defineProperty(mw2, REGISTRY_SYMBOL, {
      value: (registry: unknown) => {
        captured2.registry = registry;
      },
      enumerable: false,
      writable: false,
      configurable: false,
    });

    createDeepAgent({
      model,
      skills: [stubProvider([{ name: "x" }])],
      middleware: [mw1, mw2],
    });

    expect(captured1.registry).not.toBeUndefined();
    expect(captured2.registry).not.toBeUndefined();
    expect(captured1.registry).toBe(captured2.registry);
  });
});
