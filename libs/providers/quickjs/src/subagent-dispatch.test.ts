import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  VariantCache,
  validateResponseSchema,
  SubagentDispatcher,
} from "./subagent-dispatch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRunnable(output: Record<string, unknown> = {}) {
  return { invoke: vi.fn().mockResolvedValue(output) } as any;
}

function makePayload(
  subagents: Array<{
    name: string;
    description: string;
    runnableBacked?: boolean;
    runnable?: any;
  }>,
) {
  return {
    subagents: subagents.map((s) => ({
      name: s.name,
      description: s.description,
      spec: {
        name: s.name,
        description: s.description,
        systemPrompt: `You are ${s.name}.`,
      },
      runnableBacked: s.runnableBacked ?? false,
      runnable: s.runnable,
    })),
    compileOptions: { defaultModel: "openai:gpt-4o", defaultTools: [] },
  };
}

// ---------------------------------------------------------------------------
// VariantCache
// ---------------------------------------------------------------------------

describe("VariantCache", () => {
  it("returns factory result on cache miss", () => {
    const cache = new VariantCache();
    const runnable = fakeRunnable();
    const result = cache.getOrCreate("key", () => runnable);
    expect(result).toBe(runnable);
    expect(cache.size).toBe(1);
  });

  it("returns cached value on cache hit", () => {
    const cache = new VariantCache();
    const runnable = fakeRunnable();
    cache.getOrCreate("key", () => runnable);

    let factoryCalled = false;
    const result = cache.getOrCreate("key", () => {
      factoryCalled = true;
      return fakeRunnable();
    });
    expect(result).toBe(runnable);
    expect(factoryCalled).toBe(false);
  });

  it("evicts expired entries on access", () => {
    const cache = new VariantCache(50, 64);
    cache.getOrCreate("old", () => fakeRunnable());

    vi.advanceTimersByTime(100);

    const fresh = fakeRunnable();
    cache.getOrCreate("new", () => fresh);

    expect(cache.size).toBe(1);
    // "old" was evicted, "new" is the only entry
    let factoryCalled = false;
    cache.getOrCreate("old", () => {
      factoryCalled = true;
      return fakeRunnable();
    });
    expect(factoryCalled).toBe(true);
  });

  it("evicts LRU when at max capacity", () => {
    const cache = new VariantCache(60_000, 2);
    const r1 = fakeRunnable();
    const r2 = fakeRunnable();
    cache.getOrCreate("a", () => r1);
    cache.getOrCreate("b", () => r2);
    expect(cache.size).toBe(2);

    // Adding a third should evict "a" (oldest)
    const r3 = fakeRunnable();
    cache.getOrCreate("c", () => r3);
    expect(cache.size).toBe(2);

    // "a" should be gone
    let factoryCalled = false;
    cache.getOrCreate("a", () => {
      factoryCalled = true;
      return fakeRunnable();
    });
    expect(factoryCalled).toBe(true);
  });

  it("refreshes last-accessed on cache hit", () => {
    const cache = new VariantCache(60_000, 3);
    cache.getOrCreate("a", () => fakeRunnable());
    vi.advanceTimersByTime(10);
    cache.getOrCreate("b", () => fakeRunnable());
    vi.advanceTimersByTime(10);
    cache.getOrCreate("c", () => fakeRunnable());
    vi.advanceTimersByTime(10);

    // Access "a" to refresh it — now "b" is LRU
    cache.getOrCreate("a", () => fakeRunnable());
    vi.advanceTimersByTime(10);

    // Inserting "d" should evict "b" (oldest unrefreshed) not "a"
    cache.getOrCreate("d", () => fakeRunnable());

    // Verify "a" survived (was refreshed) and "b" was evicted
    let aEvicted = false;
    cache.getOrCreate("a", () => {
      aEvicted = true;
      return fakeRunnable();
    });
    expect(aEvicted).toBe(false);
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
});

// ---------------------------------------------------------------------------
// validateResponseSchema
// ---------------------------------------------------------------------------

describe("validateResponseSchema", () => {
  it("accepts a simple valid schema", () => {
    expect(() =>
      validateResponseSchema({
        type: "object",
        properties: { name: { type: "string" } },
      }),
    ).not.toThrow();
  });

  it("rejects schema exceeding byte limit", () => {
    const huge: Record<string, unknown> = {
      type: "object",
      description: "x".repeat(4096),
    };
    expect(() => validateResponseSchema(huge)).toThrow("byte limit");
  });

  it("rejects schema exceeding max depth", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 7; i++) {
      schema = {
        type: "object",
        properties: { nested: schema },
      };
    }
    expect(() => validateResponseSchema(schema)).toThrow("nesting depth");
  });

  it("accepts schema at exactly max depth", () => {
    let schema: Record<string, unknown> = { type: "string" };
    // depth 5 means 5 levels of properties nesting is the limit
    for (let i = 0; i < 5; i++) {
      schema = {
        type: "object",
        properties: { nested: schema },
      };
    }
    expect(() => validateResponseSchema(schema)).not.toThrow();
  });

  it("rejects schema exceeding max properties", () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 33; i++) {
      props[`f${i}`] = { type: "string" };
    }
    expect(() =>
      validateResponseSchema({ type: "object", properties: props }),
    ).toThrow("properties");
  });

  it("counts properties across nested levels", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 31 }, (_, i) => [`f${i}`, { type: "string" }]),
          ),
        },
      },
    };
    // 2 top-level + 31 nested = 33 > 32
    expect(() => validateResponseSchema(schema)).toThrow("properties");
  });

  it("traverses items for array schemas", () => {
    let inner: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 7; i++) {
      inner = { type: "array", items: inner };
    }
    expect(() => validateResponseSchema(inner)).toThrow("nesting depth");
  });
});

// ---------------------------------------------------------------------------
// SubagentDispatcher
// ---------------------------------------------------------------------------

vi.mock("deepagents", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createSubAgent: vi.fn(),
  };
});

import { createSubAgent } from "deepagents";
const mockedCreateSubAgent = vi.mocked(createSubAgent);

describe("SubagentDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes subagent descriptions", () => {
    const dispatcher = new SubagentDispatcher(
      makePayload([
        { name: "researcher", description: "Researches things" },
        { name: "coder", description: "Writes code" },
      ]),
    );

    expect(dispatcher.subagentDescriptions).toEqual([
      { name: "researcher", description: "Researches things" },
      { name: "coder", description: "Writes code" },
    ]);
  });

  it("throws on unknown subagent type", async () => {
    const dispatcher = new SubagentDispatcher(
      makePayload([{ name: "researcher", description: "Researches" }]),
    );

    await expect(
      dispatcher.invoke("do something", "nonexistent"),
    ).rejects.toThrow('Unknown subagent type "nonexistent"');
  });

  it("invokes a declarative subagent and extracts text output", async () => {
    const mockRunnable = fakeRunnable({
      messages: [new AIMessage({ content: "result text" })],
    });
    mockedCreateSubAgent.mockReturnValue(mockRunnable);

    const dispatcher = new SubagentDispatcher(
      makePayload([{ name: "researcher", description: "Researches" }]),
    );

    const output = await dispatcher.invoke("find bugs", "researcher");

    expect(output).toBe("result text");
    expect(mockedCreateSubAgent).toHaveBeenCalledTimes(1);
    expect(mockRunnable.invoke).toHaveBeenCalledWith(
      { messages: [expect.any(HumanMessage)] },
      {
        configurable: { ls_agent_type: "subagent" },
        metadata: { lc_agent_name: "researcher" },
      },
    );
  });

  it("extracts structuredResponse when present", async () => {
    const structured = { bugs: ["bug1", "bug2"] };
    const mockRunnable = fakeRunnable({
      messages: [new AIMessage({ content: "ignored" })],
      structuredResponse: structured,
    });
    mockedCreateSubAgent.mockReturnValue(mockRunnable);

    const dispatcher = new SubagentDispatcher(
      makePayload([{ name: "researcher", description: "Researches" }]),
    );

    const output = await dispatcher.invoke("find bugs", "researcher");
    expect(output).toBe(structured);
  });

  it("returns 'Task completed' when no AI message has text", async () => {
    const mockRunnable = fakeRunnable({
      messages: [new AIMessage({ content: "" })],
    });
    mockedCreateSubAgent.mockReturnValue(mockRunnable);

    const dispatcher = new SubagentDispatcher(
      makePayload([{ name: "researcher", description: "Researches" }]),
    );

    const output = await dispatcher.invoke("do something", "researcher");
    expect(output).toBe("Task completed");
  });

  it("lazily compiles the runnable on first invoke", async () => {
    const mockRunnable = fakeRunnable({
      messages: [new AIMessage({ content: "ok" })],
    });
    mockedCreateSubAgent.mockReturnValue(mockRunnable);

    const dispatcher = new SubagentDispatcher(
      makePayload([{ name: "researcher", description: "Researches" }]),
    );

    expect(mockedCreateSubAgent).not.toHaveBeenCalled();
    await dispatcher.invoke("task 1", "researcher");
    expect(mockedCreateSubAgent).toHaveBeenCalledTimes(1);

    // Second invoke reuses the compiled runnable
    await dispatcher.invoke("task 2", "researcher");
    expect(mockedCreateSubAgent).toHaveBeenCalledTimes(1);
  });

  it("invokes a runnable-backed subagent directly", async () => {
    const precompiled = fakeRunnable({
      messages: [new AIMessage({ content: "precompiled result" })],
    });

    const dispatcher = new SubagentDispatcher(
      makePayload([
        {
          name: "custom",
          description: "Custom agent",
          runnableBacked: true,
          runnable: precompiled,
        },
      ]),
    );

    const output = await dispatcher.invoke("do it", "custom");
    expect(output).toBe("precompiled result");
    expect(mockedCreateSubAgent).not.toHaveBeenCalled();
    expect(precompiled.invoke).toHaveBeenCalled();
  });

  it("rejects responseSchema on runnable-backed subagents", async () => {
    const precompiled = fakeRunnable({
      messages: [new AIMessage({ content: "ok" })],
    });

    const dispatcher = new SubagentDispatcher(
      makePayload([
        {
          name: "custom",
          description: "Custom",
          runnableBacked: true,
          runnable: precompiled,
        },
      ]),
    );

    await expect(
      dispatcher.invoke("do it", "custom", {
        type: "object",
        properties: { x: { type: "string" } },
      }),
    ).rejects.toThrow("runnable-backed");
  });

  it("compiles a variant when responseSchema is provided", async () => {
    const variantRunnable = fakeRunnable({
      messages: [new AIMessage({ content: "variant" })],
      structuredResponse: { x: 1 },
    });
    mockedCreateSubAgent.mockReturnValue(variantRunnable);

    const dispatcher = new SubagentDispatcher(
      makePayload([{ name: "researcher", description: "Researches" }]),
    );

    const schema = {
      type: "object",
      properties: { x: { type: "number" } },
    };
    const output = await dispatcher.invoke("analyze", "researcher", schema);

    expect(output).toEqual({ x: 1 });
    expect(mockedCreateSubAgent).toHaveBeenCalledTimes(1);
    expect(mockedCreateSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ responseFormat: schema }),
      expect.any(Object),
    );
  });

  it("caches variant runnables across invocations", async () => {
    const variantRunnable = fakeRunnable({
      messages: [new AIMessage({ content: "variant" })],
      structuredResponse: { x: 1 },
    });
    mockedCreateSubAgent.mockReturnValue(variantRunnable);

    const dispatcher = new SubagentDispatcher(
      makePayload([{ name: "researcher", description: "Researches" }]),
    );

    const schema = {
      type: "object",
      properties: { x: { type: "number" } },
    };
    await dispatcher.invoke("task 1", "researcher", schema);
    await dispatcher.invoke("task 2", "researcher", schema);

    expect(mockedCreateSubAgent).toHaveBeenCalledTimes(1);
  });

  it("throws when result has no messages key", async () => {
    const mockRunnable = fakeRunnable({ noMessages: true });
    mockedCreateSubAgent.mockReturnValue(mockRunnable);

    const dispatcher = new SubagentDispatcher(
      makePayload([{ name: "researcher", description: "Researches" }]),
    );

    await expect(
      dispatcher.invoke("do something", "researcher"),
    ).rejects.toThrow("messages");
  });
});
