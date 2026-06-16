import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("langchain", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createAgent: vi.fn(actual.createAgent as (...args: unknown[]) => unknown),
  };
});

import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createAgent, tool, type AgentMiddleware } from "langchain";
import {
  AIMessage,
  BaseMessage,
  SystemMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { z } from "zod/v4";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import type { LangSmithTracingClientInterface } from "langsmith";
import type { Serialized } from "@langchain/core/load/serializable";
import type { ChainValues } from "@langchain/core/utils/types";

import { createDeepAgent } from "../agent.js";
import { createSkillsMiddleware } from "./skills.js";
import { createFileData } from "../backends/utils.js";
import { createMockBackend } from "./test.js";
import { createSubAgent } from "./subagents.js";

const createAgentMock = vi.mocked(createAgent);

/**
 * Helper to get all system prompts from model invoke spy calls.
 */
function getAllSystemPromptsFromSpy(
  invokeSpy: ReturnType<typeof vi.spyOn>,
): string[] {
  const systemPrompts: string[] = [];
  for (const call of invokeSpy.mock.calls) {
    const messages = call[0] as BaseMessage[] | undefined;
    if (!messages) continue;
    const systemMessage = messages.find(SystemMessage.isInstance);
    if (systemMessage) {
      systemPrompts.push(systemMessage.text);
    }
  }
  return systemPrompts;
}

const TEST_SKILL_MD = `---
name: test-skill
description: A test skill for subagent isolation tests
---

# Test Skill

Instructions for the test skill.
`;

/**
 * Subagent skills isolation tests.
 *
 * These tests verify that:
 * 1. Custom subagents do NOT inherit skills middleware from createDeepAgent
 * 2. skillsMetadata from subagent middleware doesn't bubble up to parent
 * 3. General-purpose subagent DOES inherit skills from main agent
 */
describe("Subagent skills isolation", () => {
  it("should NOT inherit skills for custom subagents", async () => {
    /**
     * Test that custom subagents do NOT inherit skills from the main agent.
     * Custom subagents must explicitly define their own `skills` property to get skills.
     */
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");

    const taskToolCallId = `call_${Date.now()}`;
    const model = new FakeListChatModel({
      responses: [
        // Main agent invokes custom-worker subagent
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: taskToolCallId,
              name: "task",
              args: {
                description: "Do some custom work",
                subagent_type: "custom-worker",
              },
            },
          ],
        }) as unknown as string,
        // Custom subagent completes
        "Custom work done",
        // Extra responses
        "Done",
        "Done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: model,
      skills: ["/skills/"],
      checkpointer,
      subagents: [
        {
          name: "custom-worker",
          description: "A custom worker agent without skills",
          systemPrompt: "You are a custom worker. This is your unique prompt.",
        },
      ],
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("Test custom subagent")],
        files: {
          "/skills/test-skill/SKILL.md": createFileData(TEST_SKILL_MD),
        },
      },
      {
        configurable: { thread_id: `test-custom-no-skills-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    const systemPrompts = getAllSystemPromptsFromSpy(invokeSpy);

    // Main agent should have skills
    const mainAgentPrompts = systemPrompts.filter((p) =>
      p.includes("`task` (subagent spawner)"),
    );
    expect(mainAgentPrompts.length).toBeGreaterThan(0);
    expect(mainAgentPrompts[0]).toContain("Skills System");
    expect(mainAgentPrompts[0]).toContain("test-skill");

    // Custom subagent should have been invoked
    const customSubagentPrompts = systemPrompts.filter((p) =>
      p.includes("You are a custom worker. This is your unique prompt."),
    );
    expect(customSubagentPrompts.length).toBeGreaterThan(0);
    // Custom subagent should NOT have skills
    expect(customSubagentPrompts[0]).not.toContain("Skills System");
    expect(customSubagentPrompts[0]).not.toContain("test-skill");

    invokeSpy.mockRestore();
  });

  it("should inherit skills for general-purpose subagent", async () => {
    /**
     * Test that the general-purpose subagent DOES inherit skills from main agent.
     * This is the intended behavior - GP subagent has access to everything the main agent has.
     */
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");

    const taskToolCallId = `call_${Date.now()}`;
    const model = new FakeListChatModel({
      responses: [
        // Main agent invokes general-purpose subagent
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: taskToolCallId,
              name: "task",
              args: {
                description: "Do something with skills",
                subagent_type: "general-purpose",
              },
            },
          ],
        }) as unknown as string,
        // GP subagent completes
        "Subagent done",
        // Extra responses
        "Done",
        "Done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model,
      skills: ["/skills/"],
      checkpointer,
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("Test GP subagent")],
        files: {
          "/skills/test-skill/SKILL.md": createFileData(TEST_SKILL_MD),
        },
      },
      {
        configurable: { thread_id: `test-gp-with-skills-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    const systemPrompts = getAllSystemPromptsFromSpy(invokeSpy);

    // Main agent should have skills
    const mainAgentPrompts = systemPrompts.filter(
      (p) =>
        p.includes("test-skill") && p.includes("`task` (subagent spawner)"),
    );
    expect(mainAgentPrompts.length).toBeGreaterThan(0);
    expect(mainAgentPrompts[0]).toContain("Skills System");

    // GP subagent should also have skills (no `task` tool in prompt)
    const gpSubagentPrompts = systemPrompts.filter(
      (p) =>
        p.includes("test-skill") && !p.includes("`task` (subagent spawner)"),
    );
    expect(gpSubagentPrompts.length).toBeGreaterThan(0);
    expect(gpSubagentPrompts[0]).toContain("Skills System");
    expect(gpSubagentPrompts[0]).toContain("test-skill");

    invokeSpy.mockRestore();
  });

  it("should not include skillsMetadata in parent agent final state", async () => {
    /**
     * Test that skillsMetadata from subagent middleware doesn't bubble up to parent.
     *
     * This test verifies that:
     * 1. A subagent with SkillsMiddleware loads skills and populates skillsMetadata in its state
     * 2. When the subagent completes, skillsMetadata is NOT included in the parent's state
     * 3. The EXCLUDED_STATE_KEYS correctly filters the field from subagent updates
     *
     * This works because skillsMetadata is in EXCLUDED_STATE_KEYS, which tells
     * the subagent middleware to exclude it from the returned state update.
     */
    const model = new FakeListChatModel({ responses: ["Done"] });

    // Create subagent with SkillsMiddleware
    const skillsMiddleware = createSkillsMiddleware({
      backend: createMockBackend({
        files: {
          "/skills/user/subagent-skill/SKILL.md": `---
name: subagent-skill
description: A skill for the subagent
---
# Subagent Skill`,
        },
        directories: {
          "/skills/user/": [{ name: "subagent-skill", type: "directory" }],
        },
      }),
      sources: ["/skills/user/"],
    });

    // Import createAgent for the subagent
    const { createAgent } = await import("langchain");
    const subagent = createAgent({
      model,
      middleware: [skillsMiddleware],
    });

    const checkpointer = new MemorySaver();
    const parentAgent = createDeepAgent({
      model,
      checkpointer,
      subagents: [
        {
          name: "skills-agent",
          description: "Agent with skills middleware.",
          runnable: subagent,
        },
      ],
    });

    const result = await parentAgent.invoke(
      {
        messages: [new HumanMessage("Hello")],
      },
      {
        configurable: { thread_id: `test-skills-isolation-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    // Verify skillsMetadata is NOT in the parent agent's final state
    // This confirms EXCLUDED_STATE_KEYS is working correctly
    expect(result).not.toHaveProperty("skillsMetadata");
  });
});

/**
 * Tests for filtering invalid content blocks from subagent response content.
 *
 * When using Anthropic models, AIMessage.content can be an array containing
 * block types that are invalid as ToolMessage content:
 * - tool_use: tool invocation blocks (#239)
 * - thinking / redacted_thinking: extended thinking blocks (#245)
 *
 * These must be filtered out before constructing the ToolMessage.
 */
describe("Subagent content block filtering", () => {
  it("should filter tool_use blocks from subagent response content", async () => {
    const mockSubagent = RunnableLambda.from(async () => ({
      messages: [
        new AIMessage({
          content: [
            { type: "text", text: "Here is the result" },
            {
              type: "tool_use",
              id: "call_inner",
              name: "some_tool",
              input: {},
            },
          ],
        }),
      ],
    }));

    const taskToolCallId = `call_${Date.now()}`;
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: taskToolCallId,
              name: "task",
              args: {
                description: "Do work",
                subagent_type: "worker",
              },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model,
      checkpointer,
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          runnable: mockSubagent,
        },
      ],
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage("Test")] },
      {
        configurable: { thread_id: `test-tool-use-filter-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    const toolMessages = result.messages.filter((msg: BaseMessage) =>
      ToolMessage.isInstance(msg),
    );
    expect(toolMessages.length).toBeGreaterThan(0);

    for (const msg of toolMessages) {
      if (Array.isArray(msg.content)) {
        const invalidBlocks = (msg.content as Array<{ type: string }>).filter(
          (block) => block.type === "tool_use",
        );
        expect(invalidBlocks).toHaveLength(0);
      }
    }

    const taskToolMessage = toolMessages.find(
      (msg: BaseMessage) => (msg as ToolMessage).name === "task",
    ) as ToolMessage;
    expect(taskToolMessage).toBeDefined();
    expect(taskToolMessage.content).toContainEqual({
      type: "text",
      text: "Here is the result",
    });
  });

  it("should filter thinking and redacted_thinking blocks from subagent response content", async () => {
    const mockSubagent = RunnableLambda.from(async () => ({
      messages: [
        new AIMessage({
          content: [
            { type: "thinking", thinking: "Let me reason about this..." },
            { type: "redacted_thinking", data: "..." },
            { type: "text", text: "Final answer" },
          ],
        }),
      ],
    }));

    const taskToolCallId = `call_${Date.now()}`;
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: taskToolCallId,
              name: "task",
              args: {
                description: "Do work",
                subagent_type: "worker",
              },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model,
      checkpointer,
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          runnable: mockSubagent,
        },
      ],
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage("Test")] },
      {
        configurable: {
          thread_id: `test-thinking-filter-${Date.now()}`,
        },
        recursionLimit: 50,
      },
    );

    const taskToolMessage = result.messages.find(
      (msg: BaseMessage) =>
        ToolMessage.isInstance(msg) && (msg as ToolMessage).name === "task",
    ) as ToolMessage;
    expect(taskToolMessage).toBeDefined();
    expect(taskToolMessage.content).toContainEqual({
      type: "text",
      text: "Final answer",
    });
    if (Array.isArray(taskToolMessage.content)) {
      const invalidBlocks = (
        taskToolMessage.content as Array<{ type: string }>
      ).filter(
        (block) =>
          block.type === "thinking" || block.type === "redacted_thinking",
      );
      expect(invalidBlocks).toHaveLength(0);
    }
  });

  it("should fall back to 'Task completed' when all content blocks are invalid", async () => {
    const mockSubagent = RunnableLambda.from(async () => ({
      messages: [
        new AIMessage({
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "tool_a",
              input: {},
            },
            { type: "thinking", thinking: "internal reasoning" },
            { type: "redacted_thinking", data: "..." },
          ],
        }),
      ],
    }));

    const taskToolCallId = `call_${Date.now()}`;
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: taskToolCallId,
              name: "task",
              args: {
                description: "Do work",
                subagent_type: "worker",
              },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model,
      checkpointer,
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          runnable: mockSubagent,
        },
      ],
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage("Test")] },
      {
        configurable: {
          thread_id: `test-invalid-blocks-fallback-${Date.now()}`,
        },
        recursionLimit: 50,
      },
    );

    const taskToolMessage = result.messages.find(
      (msg: BaseMessage) =>
        ToolMessage.isInstance(msg) && (msg as ToolMessage).name === "task",
    ) as ToolMessage;
    expect(taskToolMessage).toBeDefined();
    expect(taskToolMessage.content).toBe("Task completed");
  });

  it("should pass through string content unchanged", async () => {
    const mockSubagent = RunnableLambda.from(async () => ({
      messages: [
        new AIMessage({
          content: "Simple string result",
        }),
      ],
    }));

    const taskToolCallId = `call_${Date.now()}`;
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: taskToolCallId,
              name: "task",
              args: {
                description: "Do work",
                subagent_type: "worker",
              },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model,
      checkpointer,
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          runnable: mockSubagent,
        },
      ],
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage("Test")] },
      {
        configurable: {
          thread_id: `test-string-content-${Date.now()}`,
        },
        recursionLimit: 50,
      },
    );

    const taskToolMessage = result.messages.find(
      (msg: BaseMessage) =>
        ToolMessage.isInstance(msg) && (msg as ToolMessage).name === "task",
    ) as ToolMessage;
    expect(taskToolMessage).toBeDefined();
    expect(taskToolMessage.content).toBe("Simple string result");
  });
});

/**
 * Tests for structured response support in subagents.
 *
 * When a subagent produces a `structuredResponse`, the middleware should
 * JSON-serialize it as the ToolMessage content instead of extracting the
 * last message text. This gives the supervisor predictable, parseable data.
 */
describe("Subagent structured response", () => {
  it("should serialize structuredResponse as ToolMessage content", async () => {
    const structuredData = {
      findings: "Renewable energy adoption is accelerating",
      confidence: 0.92,
      sources: 3,
    };

    const mockSubagent = RunnableLambda.from(async () => ({
      messages: [
        new AIMessage({
          content: "Here are my findings about renewable energy.",
        }),
      ],
      structuredResponse: structuredData,
    }));

    const taskToolCallId = `call_${Date.now()}`;
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: taskToolCallId,
              name: "task",
              args: {
                description: "Analyze renewable energy trends",
                subagent_type: "analyzer",
              },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model,
      checkpointer,
      subagents: [
        {
          name: "analyzer",
          description: "An analysis agent",
          runnable: mockSubagent,
        },
      ],
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage("Analyze renewable energy")] },
      {
        configurable: {
          thread_id: `test-structured-response-${Date.now()}`,
        },
        recursionLimit: 50,
      },
    );

    const taskToolMessage = result.messages.find(
      (msg: BaseMessage) =>
        ToolMessage.isInstance(msg) && (msg as ToolMessage).name === "task",
    ) as ToolMessage;
    expect(taskToolMessage).toBeDefined();
    expect(taskToolMessage.content).toBe(JSON.stringify(structuredData));

    const parsed = JSON.parse(taskToolMessage.content as string);
    expect(parsed).toEqual(structuredData);
  });

  it("should fall back to last message when no structuredResponse is present", async () => {
    const mockSubagent = RunnableLambda.from(async () => ({
      messages: [
        new AIMessage({
          content: "Plain text result without structured response",
        }),
      ],
    }));

    const taskToolCallId = `call_${Date.now()}`;
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: taskToolCallId,
              name: "task",
              args: {
                description: "Do work",
                subagent_type: "worker",
              },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model,
      checkpointer,
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          runnable: mockSubagent,
        },
      ],
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage("Test")] },
      {
        configurable: {
          thread_id: `test-no-structured-response-${Date.now()}`,
        },
        recursionLimit: 50,
      },
    );

    const taskToolMessage = result.messages.find(
      (msg: BaseMessage) =>
        ToolMessage.isInstance(msg) && (msg as ToolMessage).name === "task",
    ) as ToolMessage;
    expect(taskToolMessage).toBeDefined();
    expect(taskToolMessage.content).toBe(
      "Plain text result without structured response",
    );
  });
});

/**
 * Tests for ls_agent_type tracing metadata on subagent runnables.
 *
 * Verifies that ls_agent_type: "subagent" is sent to LangSmith (tracer metadata)
 * for subagent runs, but is NOT leaked into the streamed callback metadata.
 * This mirrors the behavior tested in `langchain/agents/tests/reactAgent.test.ts`.
 */
describe("ls_agent_type tracing metadata", () => {
  it("should set ls_agent_type on the subagent's LangSmith run but not on streamed metadata", async () => {
    // Capture metadata passed to regular callbacks (i.e. streamed/user-visible metadata).
    const capturedCallbackMetadata: Array<{
      metadata?: Record<string, unknown>;
      tags?: string[];
    }> = [];

    class CaptureHandler extends BaseCallbackHandler {
      name = `capture-${Date.now()}-${Math.random()}`;

      async handleChainStart(
        _chain: Serialized,
        _inputs: ChainValues,
        _runId: string,
        _parentRunId?: string,
        tags?: string[],
        metadata?: Record<string, unknown>,
      ) {
        capturedCallbackMetadata.push({ tags, metadata });
      }
    }

    // Mock the LangSmith client to capture what gets posted to the tracer.
    const createRunMock = vi.fn().mockResolvedValue(undefined);
    const updateRunMock = vi.fn().mockResolvedValue(undefined);
    const mockClient = {
      createRun: createRunMock,
      updateRun: updateRunMock,
    } as LangSmithTracingClientInterface;

    const tracer = new LangChainTracer({ client: mockClient });
    const capture = new CaptureHandler();
    const callbacks = CallbackManager.configure([tracer, capture]);

    const mockSubagent = RunnableLambda.from(async () => ({
      messages: [new AIMessage({ content: "Subagent done" })],
    })).withConfig({ runName: "subagent-runnable" });

    const taskToolCallId = `call_${Date.now()}`;
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: taskToolCallId,
              name: "task",
              args: {
                description: "Do work",
                subagent_type: "worker",
              },
            },
          ],
        }) as unknown as string,
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model,
      checkpointer,
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          runnable: mockSubagent,
        },
      ],
    });

    await agent.invoke(
      { messages: [new HumanMessage("Test")] },
      {
        configurable: { thread_id: `test-ls-agent-type-${Date.now()}` },
        recursionLimit: 50,
        callbacks: callbacks!,
      },
    );

    // Allow any async callbacks/tracer calls to flush.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // ls_agent_type should NEVER appear in streamed callback metadata.
    expect(capturedCallbackMetadata.length).toBeGreaterThan(0);
    for (const { metadata } of capturedCallbackMetadata) {
      expect(metadata?.ls_agent_type).toBeUndefined();
    }

    // ls_agent_type SHOULD appear on the subagent's LangSmith-posted run.
    expect(createRunMock).toHaveBeenCalled();
    const postedRuns = createRunMock.mock.calls.map((call) => call[0]);
    const subagentRuns = postedRuns.filter(
      (run) => run?.extra?.metadata?.ls_agent_type === "subagent",
    );
    expect(subagentRuns.length).toBeGreaterThan(0);
  });
});

describe("lc_agent_name propagation for subagents", () => {
  it("should pass subagent name for compiled subagents", async () => {
    let capturedSubagentAgentName: string | undefined;

    const identifyCaller = tool(
      (_input, config) => {
        capturedSubagentAgentName = config.metadata?.lc_agent_name as
          | string
          | undefined;
        return "captured";
      },
      {
        name: "identify_caller",
        description: "Capture lc_agent_name from metadata",
        schema: z.object({}),
      },
    );

    const compiledSubagentModel = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "compiled_tool_call",
              name: "identify_caller",
              args: {},
            },
          ],
        }) as unknown as string,
        "Subagent done",
      ],
    });

    const compiledSubagent = createAgent({
      model: compiledSubagentModel,
      systemPrompt:
        "Use identify_caller to capture who invoked this subagent, then finish.",
      tools: [identifyCaller],
      name: "compiled-worker-inner",
    });

    const parentModel = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "task_call_compiled",
              name: "task",
              args: {
                description: "Do work",
                subagent_type: "worker",
              },
            },
          ],
        }) as unknown as string,
        "Done",
      ],
    });

    const agent = createDeepAgent({
      model: parentModel,
      name: "main-agent",
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          runnable: compiledSubagent,
        },
      ],
    });

    await agent.invoke(
      { messages: [new HumanMessage("Test")] },
      {
        configurable: {
          thread_id: `test-lc-agent-name-compiled-${Date.now()}`,
        },
        recursionLimit: 50,
      },
    );

    expect(capturedSubagentAgentName).toBe("worker");
  });

  it("should pass subagent name for standard subagent specs", async () => {
    let capturedSubagentAgentName: string | undefined;

    const identifyCaller = tool(
      (_input, config) => {
        capturedSubagentAgentName = config.metadata?.lc_agent_name as
          | string
          | undefined;
        return "captured";
      },
      {
        name: "identify_caller",
        description: "Capture lc_agent_name from metadata",
        schema: z.object({}),
      },
    );

    const standardSubagentModel = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "standard_tool_call",
              name: "identify_caller",
              args: {},
            },
          ],
        }) as unknown as string,
        "Subagent done",
      ],
    });

    const parentModel = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "task_call_standard",
              name: "task",
              args: {
                description: "Do work",
                subagent_type: "worker",
              },
            },
          ],
        }) as unknown as string,
        "Done",
      ],
    });

    const agent = createDeepAgent({
      model: parentModel,
      name: "main-agent",
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          systemPrompt:
            "Use identify_caller to capture who invoked this subagent, then finish.",
          tools: [identifyCaller],
          model: standardSubagentModel,
        },
      ],
    });

    await agent.invoke(
      { messages: [new HumanMessage("Test")] },
      {
        configurable: {
          thread_id: `test-lc-agent-name-standard-${Date.now()}`,
        },
        recursionLimit: 50,
      },
    );

    expect(capturedSubagentAgentName).toBe("worker");
  });
});

describe("createSubAgent", () => {
  const fakeModel = new FakeListChatModel({ responses: ["hello"] });

  const getWeather = tool(async () => "sunny", {
    name: "get_weather",
    description: "Get the weather in a city",
    schema: z.object({ city: z.string() }),
  });

  beforeEach(() => {
    createAgentMock.mockClear();
  });

  it("compiles a declarative spec into a runnable via createAgent", () => {
    createSubAgent({
      name: "worker",
      description: "Does work",
      systemPrompt: "Work on the task.",
      model: fakeModel,
      tools: [getWeather],
    });

    expect(createAgentMock).toHaveBeenCalledOnce();
    const call = createAgentMock.mock.calls[0][0];
    expect(call.model).toBe(fakeModel);
    expect(call.systemPrompt).toBe("Work on the task.");
    expect(call.tools).toEqual([getWeather]);
    expect(call.name).toBe("worker");
  });

  it("throws when model is missing", () => {
    expect(() =>
      createSubAgent({
        name: "worker",
        description: "Does work",
        systemPrompt: "Work.",
        tools: [getWeather],
      }),
    ).toThrow("SubAgent 'worker' must specify 'model'");
  });

  it("throws when tools is missing", () => {
    expect(() =>
      createSubAgent({
        name: "worker",
        description: "Does work",
        systemPrompt: "Work.",
        model: fakeModel,
      }),
    ).toThrow("SubAgent 'worker' must specify 'tools'");
  });

  it("passes middleware through to createAgent", () => {
    const customMiddleware = { name: "custom" } as unknown as AgentMiddleware;

    createSubAgent({
      name: "worker",
      description: "Does work",
      systemPrompt: "Work.",
      model: fakeModel,
      tools: [getWeather],
      middleware: [customMiddleware],
    });

    const call = createAgentMock.mock.calls[0][0];
    const middleware = call.middleware as AgentMiddleware[];
    expect(middleware[0]).toBe(customMiddleware);
  });

  it("appends humanInTheLoopMiddleware when interruptOn is specified", () => {
    createSubAgent({
      name: "worker",
      description: "Does work",
      systemPrompt: "Work.",
      model: fakeModel,
      tools: [getWeather],
      interruptOn: { get_weather: true },
    });

    const call = createAgentMock.mock.calls[0][0];
    const middleware = call.middleware as AgentMiddleware[];
    expect(middleware.length).toBe(1);
    expect(middleware[0]).toHaveProperty("name");
  });

  it("forwards responseFormat when specified", () => {
    const schema = z.object({ answer: z.string() });

    createSubAgent({
      name: "worker",
      description: "Does work",
      systemPrompt: "Work.",
      model: fakeModel,
      tools: [getWeather],
      responseFormat: schema,
    });

    const call = createAgentMock.mock.calls[0][0];
    expect(call.responseFormat).toBe(schema);
  });

  it("does not set responseFormat when not specified", () => {
    createSubAgent({
      name: "worker",
      description: "Does work",
      systemPrompt: "Work.",
      model: fakeModel,
      tools: [],
    });

    const call = createAgentMock.mock.calls[0][0];
    expect(call.responseFormat).toBeUndefined();
  });
});
