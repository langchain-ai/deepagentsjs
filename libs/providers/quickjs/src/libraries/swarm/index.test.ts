import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockPatchToolCalls = { name: "patchToolCalls" };
const mockCacheBreakpoint = { name: "cacheBreakpoint" };
const mockPromptCaching = { name: "promptCaching" };
const mockSummarization = { name: "summarization" };

vi.mock("deepagents", () => ({
  isAnthropicModel: vi.fn(() => false),
  createPatchToolCallsMiddleware: vi.fn(() => mockPatchToolCalls),
  anthropicPromptCachingMiddleware: vi.fn(() => mockPromptCaching),
  createCacheBreakpointMiddleware: vi.fn(() => mockCacheBreakpoint),
}));

vi.mock("langchain", () => ({
  summarizationMiddleware: vi.fn(() => mockSummarization),
}));

const mockSwarmTaskTool = { name: "swarm_task" };
vi.mock("../../tools/swarm-task.js", () => ({
  createSwarmTaskTool: vi.fn(() => mockSwarmTaskTool),
}));

vi.mock("../../transform.js", () => ({
  stripTypeSyntax: vi.fn((source: string) => `/* stripped */ ${source}`),
}));

import {
  isAnthropicModel,
  createPatchToolCallsMiddleware,
  anthropicPromptCachingMiddleware,
  createCacheBreakpointMiddleware,
} from "deepagents";
import { summarizationMiddleware } from "langchain";
import { createSwarmTaskTool } from "../../tools/swarm-task.js";
import { swarm } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAnthropicModel).mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// normalizeSubagent — middleware injection
// ---------------------------------------------------------------------------

describe("normalizeSubagent (via swarm factory)", () => {
  it("always injects patch-tool-calls middleware", () => {
    swarm({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: "openai:gpt-4o",
    });

    expect(createPatchToolCallsMiddleware).toHaveBeenCalled();
  });

  it("always injects summarization middleware with effective model", () => {
    swarm({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: "openai:gpt-4o",
    });

    expect(summarizationMiddleware).toHaveBeenCalledWith({
      model: "openai:gpt-4o",
    });
  });

  it("does not add Anthropic cache middleware for non-Anthropic models", () => {
    vi.mocked(isAnthropicModel).mockReturnValue(false);

    swarm({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: "openai:gpt-4o",
    });

    const call = vi.mocked(createSwarmTaskTool).mock.calls[0][0];
    const sub = call.subagents![0];
    expect(sub.middleware).toEqual([mockPatchToolCalls, mockSummarization]);
    expect(anthropicPromptCachingMiddleware).not.toHaveBeenCalled();
    expect(createCacheBreakpointMiddleware).not.toHaveBeenCalled();
  });

  it("adds Anthropic cache middleware when model is Anthropic", () => {
    vi.mocked(isAnthropicModel).mockReturnValue(true);

    swarm({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: "anthropic:claude-sonnet-4-20250514",
    });

    const call = vi.mocked(createSwarmTaskTool).mock.calls[0][0];
    const sub = call.subagents![0];
    expect(sub.middleware).toEqual([
      mockPatchToolCalls,
      mockSummarization,
      mockPromptCaching,
      mockCacheBreakpoint,
    ]);
    expect(anthropicPromptCachingMiddleware).toHaveBeenCalledWith({
      unsupportedModelBehavior: "ignore",
      minMessagesToCache: 1,
    });
  });

  it("checks the subagent model override, not the default", () => {
    const subModel = "anthropic:claude-haiku-4-5-20251001";
    vi.mocked(isAnthropicModel).mockImplementation(
      (m) => typeof m === "string" && m.startsWith("anthropic:"),
    );

    swarm({
      subagents: [
        {
          name: "worker",
          description: "W",
          systemPrompt: "W.",
          model: subModel,
        },
      ],
      defaultModel: "openai:gpt-4o",
    });

    expect(isAnthropicModel).toHaveBeenCalledWith(subModel);
    const call = vi.mocked(createSwarmTaskTool).mock.calls[0][0];
    const sub = call.subagents![0];
    expect(sub.middleware).toContainEqual(mockPromptCaching);
  });

  it("falls back to defaultModel when subagent has no model", () => {
    vi.mocked(isAnthropicModel).mockReturnValue(false);

    swarm({
      subagents: [{ name: "worker", description: "W", systemPrompt: "W." }],
      defaultModel: "openai:gpt-4o",
    });

    expect(isAnthropicModel).toHaveBeenCalledWith("openai:gpt-4o");
  });

  it("appends user-provided middleware after defaults", () => {
    vi.mocked(isAnthropicModel).mockReturnValue(true);
    const customMiddleware = { name: "custom" };

    swarm({
      subagents: [
        {
          name: "worker",
          description: "W",
          systemPrompt: "W.",
          middleware: [customMiddleware as any],
        },
      ],
      defaultModel: "anthropic:claude-sonnet-4-20250514",
    });

    const call = vi.mocked(createSwarmTaskTool).mock.calls[0][0];
    const sub = call.subagents![0];
    expect(sub.middleware).toEqual([
      mockPatchToolCalls,
      mockSummarization,
      mockPromptCaching,
      mockCacheBreakpoint,
      customMiddleware,
    ]);
  });

  it("normalizes multiple subagents independently", () => {
    vi.mocked(isAnthropicModel).mockImplementation(
      (m) => typeof m === "string" && m.startsWith("anthropic:"),
    );

    swarm({
      subagents: [
        {
          name: "anthropic-worker",
          description: "A",
          systemPrompt: "A.",
          model: "anthropic:claude-sonnet-4-20250514",
        },
        {
          name: "openai-worker",
          description: "O",
          systemPrompt: "O.",
          model: "openai:gpt-4o",
        },
      ],
      defaultModel: "openai:gpt-4o",
    });

    const call = vi.mocked(createSwarmTaskTool).mock.calls[0][0];
    const anthropicSub = call.subagents!.find(
      (s) => s.name === "anthropic-worker",
    )!;
    const openaiSub = call.subagents!.find((s) => s.name === "openai-worker")!;

    expect(anthropicSub.middleware).toHaveLength(4);
    expect(openaiSub.middleware).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// swarm() — InterpreterLibrary shape
// ---------------------------------------------------------------------------

describe("swarm() factory", () => {
  it("returns a valid InterpreterLibrary", () => {
    const lib = swarm({ defaultModel: "openai:gpt-4o" });

    expect(lib.name).toBe("swarm");
    expect(lib.description).toContain("table");
    expect(lib.source).toBeTruthy();
    expect(lib.instructions).toBeTruthy();
    expect(lib.files).toBeInstanceOf(Map);
  });

  it("includes swarm_task tool and standard file tools in ptcTools", () => {
    const lib = swarm({ defaultModel: "openai:gpt-4o" });

    expect(lib.ptcTools).toContain(mockSwarmTaskTool);
    expect(lib.ptcTools).toContain("read_file");
    expect(lib.ptcTools).toContain("write_file");
    expect(lib.ptcTools).toContain("edit_file");
    expect(lib.ptcTools).toContain("glob");
  });

  it("passes normalized subagents and defaultModel to createSwarmTaskTool", () => {
    const subagents = [
      { name: "worker", description: "W", systemPrompt: "W." },
    ];

    swarm({ subagents, defaultModel: "openai:gpt-4o" });

    expect(createSwarmTaskTool).toHaveBeenCalledWith({
      subagents: expect.arrayContaining([
        expect.objectContaining({
          name: "worker",
          middleware: expect.any(Array),
        }),
      ]),
      defaultModel: "openai:gpt-4o",
    });
  });

  it("defaults to empty subagents when none provided", () => {
    swarm({ defaultModel: "openai:gpt-4o" });

    expect(createSwarmTaskTool).toHaveBeenCalledWith({
      subagents: [],
      defaultModel: "openai:gpt-4o",
    });
  });
});

// ---------------------------------------------------------------------------
// Source and instructions loading
// ---------------------------------------------------------------------------

describe("source and instructions loading", () => {
  it("loads and strips swarm source files from disk", () => {
    const lib = swarm({ defaultModel: "openai:gpt-4o" });

    expect(lib.source).toContain("/* stripped */");
    expect(lib.source.length).toBeGreaterThan(0);
  });

  it("populates files map with non-entry source modules", () => {
    const lib = swarm({ defaultModel: "openai:gpt-4o" });

    expect(lib.files!.size).toBeGreaterThan(0);
    for (const [filename, content] of lib.files!) {
      expect(filename).toMatch(/\.(ts|js)$/);
      expect(content).toContain("/* stripped */");
    }
  });

  it("does not include .d.ts files in the files map", () => {
    const lib = swarm({ defaultModel: "openai:gpt-4o" });

    for (const filename of lib.files!.keys()) {
      expect(filename).not.toMatch(/\.d\.ts$/);
    }
  });

  it("loads LIBRARY.md as instructions", () => {
    const lib = swarm({ defaultModel: "openai:gpt-4o" });

    expect(lib.instructions).toContain("# Swarm");
    expect(lib.instructions).toContain("create");
    expect(lib.instructions).toContain("run");
    expect(lib.instructions).toContain("rows");
  });
});
