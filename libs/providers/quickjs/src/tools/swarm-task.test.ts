import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { FakeToolCallingModel } from "langchain";
import * as langchain from "langchain";

const SENTINEL_PATCH_TOOL_CALLS = { name: "PatchToolCallsMiddleware" };
const SENTINEL_SUMMARIZATION = { name: "SummarizationMiddleware" };
const SENTINEL_CACHE_BREAKPOINT = { name: "CacheBreakpointMiddleware" };
const SENTINEL_PROMPT_CACHING = { name: "AnthropicPromptCachingMiddleware" };

vi.mock("deepagents", () => ({
  isAnthropicModel: (model: unknown) => {
    if (typeof model === "string") {
      if (model.includes(":")) return model.split(":")[0] === "anthropic";
      return model.startsWith("claude");
    }
    return false;
  },
  createPatchToolCallsMiddleware: () => SENTINEL_PATCH_TOOL_CALLS,
  createSummarizationMiddleware: () => SENTINEL_SUMMARIZATION,
  createCacheBreakpointMiddleware: () => SENTINEL_CACHE_BREAKPOINT,
}));

vi.mock("langchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("langchain")>();
  return {
    ...actual,
    anthropicPromptCachingMiddleware: () => SENTINEL_PROMPT_CACHING,
    createAgent: vi.fn((_params: unknown) => {
      return RunnableLambda.from(async () => ({
        messages: [new AIMessage({ content: "agent response" })],
      }));
    }),
  };
});

import { createSwarmTaskTool, VariantCache } from "./swarm-task.js";

function makeMockModel(response: string = "model response"): any {
  return {
    invoke: vi.fn(async () => new AIMessage({ content: response })),
    withStructuredOutput: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Subagent validation
// ---------------------------------------------------------------------------

describe("subagent validation", () => {
  it("throws when subagent_type is not in the configured list", async () => {
    const swarmTask = createSwarmTaskTool({
      subagents: [
        {
          name: "screener",
          description: "A screener",
          systemPrompt: "Screen.",
        },
      ],
      defaultModel: makeMockModel(),
    });

    await expect(
      swarmTask.invoke({
        description: "do work",
        subagent_type: "nonexistent",
      }),
    ).rejects.toThrow('Unknown swarm subagent type "nonexistent"');
  });

  it("includes available subagent names in the error message", async () => {
    const swarmTask = createSwarmTaskTool({
      subagents: [
        { name: "alpha", description: "A", systemPrompt: "A." },
        { name: "beta", description: "B", systemPrompt: "B." },
      ],
      defaultModel: makeMockModel(),
    });

    await expect(
      swarmTask.invoke({
        description: "do work",
        subagent_type: "gamma",
      }),
    ).rejects.toThrow("alpha, beta");
  });
});

// ---------------------------------------------------------------------------
// Agent mode (default)
// ---------------------------------------------------------------------------

describe("agent mode", () => {
  it("dispatches to the correct subagent by name", async () => {
    const alphaAgent = RunnableLambda.from(async () => ({
      messages: [new AIMessage({ content: "alpha result" })],
    }));
    const betaAgent = RunnableLambda.from(async () => ({
      messages: [new AIMessage({ content: "beta result" })],
    }));

    let callCount = 0;
    vi.mocked(langchain.createAgent).mockImplementation(() => {
      callCount++;
      return callCount === 1 ? (alphaAgent as any) : (betaAgent as any);
    });

    const swarmTask = createSwarmTaskTool({
      subagents: [
        { name: "alpha", description: "A", systemPrompt: "A." },
        { name: "beta", description: "B", systemPrompt: "B." },
      ],
      defaultModel: makeMockModel(),
    });

    const result = await swarmTask.invoke({
      description: "do work",
      subagent_type: "beta",
    });
    expect(result).toBe("beta result");
  });

  it("passes description as the HumanMessage content", async () => {
    const invokedWith: unknown[] = [];
    vi.mocked(langchain.createAgent).mockImplementation(() => {
      return RunnableLambda.from(async (state: Record<string, unknown>) => {
        invokedWith.push(state);
        return { messages: [new AIMessage({ content: "done" })] };
      }) as any;
    });

    const swarmTask = createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
    });

    await swarmTask.invoke({
      description: "classify this trace",
      subagent_type: "worker",
    });

    const state = invokedWith[invokedWith.length - 1] as Record<
      string,
      unknown
    >;
    const messages = state.messages as HumanMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("classify this trace");
  });

  it("returns structuredResponse as JSON string when present", async () => {
    vi.mocked(langchain.createAgent).mockImplementation(() => {
      return RunnableLambda.from(async () => ({
        structuredResponse: { label: "positive", score: 0.95 },
        messages: [new AIMessage({ content: "ignored" })],
      })) as any;
    });

    const swarmTask = createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
    });

    const result = await swarmTask.invoke({
      description: "classify",
      subagent_type: "worker",
    });
    expect(JSON.parse(result)).toEqual({ label: "positive", score: 0.95 });
  });

  it("returns last message content when no structured response", async () => {
    vi.mocked(langchain.createAgent).mockImplementation(() => {
      return RunnableLambda.from(async () => ({
        messages: [
          new AIMessage({ content: "first" }),
          new AIMessage({ content: "last message" }),
        ],
      })) as any;
    });

    const swarmTask = createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
    });

    const result = await swarmTask.invoke({
      description: "work",
      subagent_type: "worker",
    });
    expect(result).toBe("last message");
  });

  it('returns "Task completed" when no messages in result', async () => {
    vi.mocked(langchain.createAgent).mockImplementation(() => {
      return RunnableLambda.from(async () => ({
        messages: [],
      })) as any;
    });

    const swarmTask = createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
    });

    const result = await swarmTask.invoke({
      description: "work",
      subagent_type: "worker",
    });
    expect(result).toBe("Task completed");
  });

  it("compiles a new agent with responseFormat when response_schema is provided", async () => {
    const swarmTask = createSwarmTaskTool({
      subagents: [
        { name: "worker", description: "W", systemPrompt: "Analyze." },
      ],
      defaultModel: makeMockModel(),
    });

    const schema = {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
    };

    await swarmTask.invoke({
      description: "classify",
      subagent_type: "worker",
      response_schema: schema,
    });

    // One call at construction (pre-compiled), one for the schema variant
    expect(langchain.createAgent).toHaveBeenCalledTimes(2);
    expect(langchain.createAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        responseFormat: expect.objectContaining({
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        }),
      }),
    );
  });

  it("does not compile a new agent when response_schema is omitted", async () => {
    const swarmTask = createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
    });

    // createAgent called once at construction
    expect(langchain.createAgent).toHaveBeenCalledTimes(1);

    await swarmTask.invoke({
      description: "work",
      subagent_type: "worker",
    });

    // No additional calls — uses pre-compiled agent
    expect(langchain.createAgent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Invoke mode
// ---------------------------------------------------------------------------

describe("invoke mode", () => {
  it("calls defaultModel.invoke directly with a human message", async () => {
    const model = makeMockModel("classified: positive");

    const swarmTask = createSwarmTaskTool({
      subagents: [],
      defaultModel: model,
    });

    await swarmTask.invoke({
      description: "classify this",
      mode: "invoke",
    });

    expect(model.invoke).toHaveBeenCalledOnce();
    const [messages] = model.invoke.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[0].content).toBe("classify this");
  });

  it("does not call createAgent in invoke mode", async () => {
    const swarmTask = createSwarmTaskTool({
      subagents: [
        {
          name: "worker",
          description: "W",
          systemPrompt: "W.",
          model: makeMockModel(),
        },
      ],
      defaultModel: makeMockModel(),
    });

    const afterConstruction = vi.mocked(langchain.createAgent).mock.calls
      .length;

    await swarmTask.invoke({
      description: "work",
      mode: "invoke",
    });

    // No new createAgent calls beyond construction
    expect(langchain.createAgent).toHaveBeenCalledTimes(afterConstruction);
  });

  it("uses withStructuredOutput when response_schema is provided", async () => {
    const structuredResult = { label: "positive" };
    const schema = {
      type: "object",
      properties: { label: { type: "string" } },
    };
    const structuredRunnable = {
      invoke: vi.fn(async () => structuredResult),
    };
    const model = new FakeToolCallingModel({ toolCalls: [] });
    const withStructuredOutputSpy = vi
      .spyOn(model, "withStructuredOutput")
      .mockReturnValue(structuredRunnable as any);

    const swarmTask = createSwarmTaskTool({
      subagents: [],
      defaultModel: model,
    });

    const result = await swarmTask.invoke({
      description: "work",
      mode: "invoke",
      response_schema: schema,
    });

    expect(withStructuredOutputSpy).toHaveBeenCalledWith(schema);
    expect(structuredRunnable.invoke).toHaveBeenCalledOnce();
    expect(result).toBe(JSON.stringify(structuredResult));
  });

  it("returns string content from model response", async () => {
    const model = makeMockModel("the answer");

    const swarmTask = createSwarmTaskTool({
      subagents: [],
      defaultModel: model,
    });

    const result = await swarmTask.invoke({
      description: "work",
      mode: "invoke",
    });
    expect(result).toBe("the answer");
  });

  it("handles model responses that return a plain string", async () => {
    const model: any = {
      invoke: vi.fn(async () => "plain string response"),
    };

    const swarmTask = createSwarmTaskTool({
      subagents: [],
      defaultModel: model,
    });

    const result = await swarmTask.invoke({
      description: "work",
      mode: "invoke",
    });
    expect(result).toBe("plain string response");
  });

  it("works without response_schema", async () => {
    const model = makeMockModel("plain response");

    const swarmTask = createSwarmTaskTool({
      subagents: [],
      defaultModel: model,
    });

    const result = await swarmTask.invoke({
      description: "work",
      mode: "invoke",
    });

    expect(result).toBe("plain response");
    expect(model.invoke).toHaveBeenCalledOnce();
    expect(model.invoke.mock.calls[0]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mode defaulting
// ---------------------------------------------------------------------------

describe("mode defaulting", () => {
  it('defaults to "agent" mode when mode is not provided', async () => {
    const model = makeMockModel();

    const swarmTask = createSwarmTaskTool({
      subagents: [
        { name: "worker", description: "W", systemPrompt: "W.", model },
      ],
      defaultModel: makeMockModel(),
    });

    await swarmTask.invoke({
      description: "work",
      subagent_type: "worker",
    });

    // model.invoke should NOT have been called (that's invoke mode)
    expect(model.invoke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Multiple subagents
// ---------------------------------------------------------------------------

describe("multiple subagents", () => {
  it("uses the subagent's own model when specified", async () => {
    const screenerModel = makeMockModel();
    const defaultModel = makeMockModel();

    createSwarmTaskTool({
      subagents: [
        {
          name: "screener",
          description: "S",
          systemPrompt: "Screen.",
          model: screenerModel,
        },
      ],
      defaultModel,
    });

    // createAgent should have been called with the screener's model, not the default
    expect(langchain.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: screenerModel }),
    );
  });

  it("falls back to defaultModel when subagent has no model", async () => {
    const defaultModel = makeMockModel();

    createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel,
    });

    expect(langchain.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: defaultModel }),
    );
  });
});

// ---------------------------------------------------------------------------
// TTL variant cache
// ---------------------------------------------------------------------------

describe("TTL variant cache", () => {
  it("reuses the compiled agent on repeated calls with the same schema", async () => {
    const swarmTask = createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
    });

    const schema = {
      type: "object",
      properties: { label: { type: "string" } },
    };

    await swarmTask.invoke({
      description: "row 1",
      subagent_type: "worker",
      response_schema: schema,
    });
    await swarmTask.invoke({
      description: "row 2",
      subagent_type: "worker",
      response_schema: schema,
    });
    await swarmTask.invoke({
      description: "row 3",
      subagent_type: "worker",
      response_schema: schema,
    });

    // 1 at construction + 1 for the schema variant (reused for rows 2 and 3)
    expect(langchain.createAgent).toHaveBeenCalledTimes(2);
  });

  it("compiles separate variants for distinct schemas", async () => {
    const swarmTask = createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
    });

    await swarmTask.invoke({
      description: "work",
      subagent_type: "worker",
      response_schema: {
        type: "object",
        properties: { a: { type: "string" } },
      },
    });
    await swarmTask.invoke({
      description: "work",
      subagent_type: "worker",
      response_schema: {
        type: "object",
        properties: { b: { type: "number" } },
      },
    });

    // 1 at construction + 2 schema variants
    expect(langchain.createAgent).toHaveBeenCalledTimes(3);
  });

  it("evicts expired entries and recompiles after TTL", async () => {
    vi.useFakeTimers();

    try {
      const swarmTask = createSwarmTaskTool({
        subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
        defaultModel: makeMockModel(),
      });

      const schema = {
        type: "object",
        properties: { label: { type: "string" } },
      };

      // First call — cache miss, compiles
      await swarmTask.invoke({
        description: "row 1",
        subagent_type: "worker",
        response_schema: schema,
      });
      expect(langchain.createAgent).toHaveBeenCalledTimes(2); // 1 construction + 1 variant

      // Advance past TTL
      vi.advanceTimersByTime(61_000);

      // Next call — entry expired, recompiles
      await swarmTask.invoke({
        description: "row 2",
        subagent_type: "worker",
        response_schema: schema,
      });
      expect(langchain.createAgent).toHaveBeenCalledTimes(3); // 1 new compilation
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps entries alive when accessed within TTL", async () => {
    vi.useFakeTimers();

    try {
      const swarmTask = createSwarmTaskTool({
        subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
        defaultModel: makeMockModel(),
      });

      const schema = {
        type: "object",
        properties: { label: { type: "string" } },
      };

      await swarmTask.invoke({
        description: "row 1",
        subagent_type: "worker",
        response_schema: schema,
      });

      // Advance 30s (within TTL), access again
      vi.advanceTimersByTime(30_000);
      await swarmTask.invoke({
        description: "row 2",
        subagent_type: "worker",
        response_schema: schema,
      });

      // Advance another 30s (60s since last access is at 30s, so 30s more = within TTL)
      vi.advanceTimersByTime(30_000);
      await swarmTask.invoke({
        description: "row 3",
        subagent_type: "worker",
        response_schema: schema,
      });

      // Still only 1 construction + 1 variant — cache was refreshed each time
      expect(langchain.createAgent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// VariantCache (isolated unit tests)
// ---------------------------------------------------------------------------

describe("VariantCache", () => {
  it("returns the factory value on cache miss", () => {
    const cache = new VariantCache<string>(60_000);
    const value = cache.getOrCreate("key1", () => "created");
    expect(value).toBe("created");
    expect(cache.size).toBe(1);
  });

  it("returns the cached value on cache hit without calling factory", () => {
    const cache = new VariantCache<string>(60_000);
    cache.getOrCreate("key1", () => "first");

    const factory = vi.fn(() => "second");
    const value = cache.getOrCreate("key1", factory);

    expect(value).toBe("first");
    expect(factory).not.toHaveBeenCalled();
  });

  it("stores separate entries for different keys", () => {
    const cache = new VariantCache<string>(60_000);
    cache.getOrCreate("a", () => "alpha");
    cache.getOrCreate("b", () => "beta");

    expect(cache.size).toBe(2);
    expect(cache.getOrCreate("a", () => "unused")).toBe("alpha");
    expect(cache.getOrCreate("b", () => "unused")).toBe("beta");
  });

  it("evicts entries that exceed the TTL", () => {
    vi.useFakeTimers();
    try {
      const cache = new VariantCache<string>(1000);
      cache.getOrCreate("key1", () => "value1");

      vi.advanceTimersByTime(1500);

      const factory = vi.fn(() => "value2");
      const value = cache.getOrCreate("key1", factory);

      expect(value).toBe("value2");
      expect(factory).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps entries alive when accessed within TTL", () => {
    vi.useFakeTimers();
    try {
      const cache = new VariantCache<string>(1000);
      cache.getOrCreate("key1", () => "value1");

      vi.advanceTimersByTime(800);
      cache.getOrCreate("key1", () => "unused");

      vi.advanceTimersByTime(800);
      const factory = vi.fn(() => "replaced");
      const value = cache.getOrCreate("key1", factory);

      expect(value).toBe("value1");
      expect(factory).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps multiple expired entries in one call", () => {
    vi.useFakeTimers();
    try {
      const cache = new VariantCache<string>(1000);
      cache.getOrCreate("a", () => "1");
      cache.getOrCreate("b", () => "2");
      cache.getOrCreate("c", () => "3");
      expect(cache.size).toBe(3);

      vi.advanceTimersByTime(1500);

      cache.getOrCreate("d", () => "4");
      expect(cache.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only evicts expired entries, not active ones", () => {
    vi.useFakeTimers();
    try {
      const cache = new VariantCache<string>(1000);
      cache.getOrCreate("old", () => "stale");

      vi.advanceTimersByTime(800);
      cache.getOrCreate("new", () => "fresh");

      vi.advanceTimersByTime(300);

      cache.getOrCreate("trigger", () => "sweep");
      expect(cache.size).toBe(2);
      expect(cache.getOrCreate("new", () => "unused")).toBe("fresh");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Default middleware
// ---------------------------------------------------------------------------

describe("default middleware", () => {
  it("always includes patchToolCalls middleware", () => {
    createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
    });

    expect(langchain.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        middleware: expect.arrayContaining([SENTINEL_PATCH_TOOL_CALLS]),
      }),
    );
  });

  it("includes anthropic caching middleware for anthropic models", () => {
    createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: "anthropic:claude-haiku-4-5-20251001",
    });

    expect(langchain.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        middleware: expect.arrayContaining([
          SENTINEL_PROMPT_CACHING,
          SENTINEL_CACHE_BREAKPOINT,
        ]),
      }),
    );
  });

  it("excludes anthropic caching middleware for non-anthropic models", () => {
    createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
    });

    const mw = vi.mocked(langchain.createAgent).mock.calls[0][0].middleware!;
    expect(mw).not.toContain(SENTINEL_PROMPT_CACHING);
    expect(mw).not.toContain(SENTINEL_CACHE_BREAKPOINT);
  });

  it("includes summarization middleware when backend is provided", () => {
    createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
      backend: {} as any,
    });

    expect(langchain.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        middleware: expect.arrayContaining([SENTINEL_SUMMARIZATION]),
      }),
    );
  });

  it("excludes summarization middleware when backend is omitted", () => {
    createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
    });

    const mw = vi.mocked(langchain.createAgent).mock.calls[0][0].middleware!;
    expect(mw).not.toContain(SENTINEL_SUMMARIZATION);
  });

  it("appends per-subagent middleware after defaults", () => {
    const customMiddleware = { name: "CustomMiddleware" } as any;

    createSwarmTaskTool({
      subagents: [
        {
          name: "worker",
          description: "W",
          systemPrompt: "W.",
          middleware: [customMiddleware],
        },
      ],
      defaultModel: makeMockModel(),
    });

    const mw = vi.mocked(langchain.createAgent).mock.calls[0][0].middleware!;
    expect(mw).toContain(customMiddleware);
    const patchIdx = mw.indexOf(SENTINEL_PATCH_TOOL_CALLS);
    const customIdx = mw.indexOf(customMiddleware);
    expect(patchIdx).toBeLessThan(customIdx);
  });

  it("appends tool-level middleware after defaults but before per-subagent", () => {
    const toolMw = { name: "ToolMiddleware" } as any;
    const subMw = { name: "SubMiddleware" } as any;

    createSwarmTaskTool({
      subagents: [
        {
          name: "worker",
          description: "W",
          systemPrompt: "W.",
          middleware: [subMw],
        },
      ],
      defaultModel: makeMockModel(),
      middleware: [toolMw],
    });

    const mw = vi.mocked(langchain.createAgent).mock.calls[0][0].middleware!;
    const patchIdx = mw.indexOf(SENTINEL_PATCH_TOOL_CALLS);
    const toolIdx = mw.indexOf(toolMw);
    const subIdx = mw.indexOf(subMw);
    expect(patchIdx).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(subIdx);
  });

  it("uses per-subagent model for caching detection, not defaultModel", () => {
    createSwarmTaskTool({
      subagents: [
        {
          name: "worker",
          description: "W",
          systemPrompt: "W.",
          model: "anthropic:claude-haiku-4-5-20251001",
        },
      ],
      defaultModel: makeMockModel(),
    });

    expect(langchain.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        middleware: expect.arrayContaining([
          SENTINEL_PROMPT_CACHING,
          SENTINEL_CACHE_BREAKPOINT,
        ]),
      }),
    );
  });

  it("passes middleware through to schema-variant agents", async () => {
    createSwarmTaskTool({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: makeMockModel(),
    });

    const firstCall = vi.mocked(langchain.createAgent).mock.calls[0][0];
    expect(firstCall.middleware).toContain(SENTINEL_PATCH_TOOL_CALLS);
  });
});
