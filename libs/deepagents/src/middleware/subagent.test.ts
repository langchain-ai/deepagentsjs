import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("langchain", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createAgent: vi.fn(actual.createAgent as (...args: unknown[]) => unknown),
  };
});

import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  createAgent,
  todoListMiddleware,
  tool,
  type AgentMiddleware,
} from "langchain";
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
import { StateBackend } from "../backends/state.js";
import { createSkillsMiddleware } from "./skills.js";
import {
  createSummarizationMiddleware,
  getEffectiveMessages,
} from "./summarization.js";
import { mergeMiddleware } from "./utils.js";
import { createFileData } from "../backends/utils.js";
import { createMockBackend } from "./test.js";
import {
  createSubAgent,
  createSubAgentMiddleware,
  filterStateForSubagent,
  filterStateForFork,
} from "./subagents.js";
import { registerHarnessProfile } from "../profiles/index.js";

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

// FakeListChatModel replays its first response across a subagent's own
// multiple calls; this shares a counter across bound instances instead.
class SequentialFakeChatModel extends FakeListChatModel {
  private sharedCounter: { i: number };

  constructor(params: {
    responses: (string | AIMessage)[];
    counter?: { i: number };
  }) {
    super({ responses: params.responses as unknown as string[] });
    this.sharedCounter = params.counter ?? { i: 0 };
  }

  private currentResponse(): unknown {
    return (this.responses as unknown[])[this.sharedCounter.i];
  }

  private incrementResponse(): void {
    if (this.sharedCounter.i < this.responses.length - 1) {
      this.sharedCounter.i += 1;
    } else {
      this.sharedCounter.i = 0;
    }
  }

  override bindTools(tools: Parameters<FakeListChatModel["bindTools"]>[0]) {
    const bound = super.bindTools(tools) as unknown as {
      bound?: SequentialFakeChatModel;
    } & SequentialFakeChatModel;
    const inner = bound.bound ?? bound;
    inner.sharedCounter = this.sharedCounter;
    (inner as any)._currentResponse = this.currentResponse.bind(inner);
    (inner as any)._incrementResponse = this.incrementResponse.bind(inner);
    return bound;
  }
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
    const mainAgentPrompt = systemPrompts[0];
    expect(mainAgentPrompt).toContain("Skills System");
    expect(mainAgentPrompt).toContain("test-skill");

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
    const mainAgentPrompt = systemPrompts[0];
    expect(mainAgentPrompt).toContain("Skills System");

    // GP subagent should also have skills.
    const gpSubagentPrompts = systemPrompts
      .slice(1)
      .filter((p) => p.includes("test-skill"));
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

describe("Subagent summarization state isolation", () => {
  const summarizationEvent = {
    cutoffIndex: 40,
    summaryMessage: new HumanMessage({ content: "STALE_PARENT_SUMMARY" }),
    filePath: null,
  };

  it("should exclude _summarizationEvent and _summarizationSessionId from subagent input", () => {
    const parentState = {
      messages: [new HumanMessage("irrelevant")],
      files: { "/foo.txt": "data" },
      _summarizationEvent: summarizationEvent,
      _summarizationSessionId: "thread-abc",
    };

    const filtered = filterStateForSubagent(parentState);

    expect(filtered).not.toHaveProperty("_summarizationEvent");
    expect(filtered).not.toHaveProperty("_summarizationSessionId");
    expect(filtered.files).toEqual(parentState.files);
  });

  it("should exclude a subagent's own _summarizationEvent from its return update", () => {
    const subagentResult = {
      messages: [new AIMessage({ content: "Subagent done" })],
      _summarizationEvent: {
        cutoffIndex: 99,
        summaryMessage: new HumanMessage({ content: "SUBAGENT_SUMMARY" }),
        filePath: null,
      },
      _summarizationSessionId: "subagent-thread-xyz",
    };

    const filtered = filterStateForSubagent(subagentResult);

    expect(filtered).not.toHaveProperty("_summarizationEvent");
    expect(filtered).not.toHaveProperty("_summarizationSessionId");
  });
});

describe("ForkedSubAgent", () => {
  let invokeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
  });

  afterEach(() => {
    invokeSpy.mockRestore();
  });

  function findCallContaining(
    spy: ReturnType<typeof vi.spyOn>,
    marker: string,
  ): BaseMessage[] | undefined {
    for (const call of spy.mock.calls) {
      const messages = call[0] as BaseMessage[] | undefined;
      if (!messages) continue;
      const text = messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      if (text.includes(marker)) return messages;
    }
    return undefined;
  }

  // Seeded directly as the initial `messages` array (single invoke() call)
  // rather than built up across two separate invoke() calls — FakeListChatModel's
  // response-cycling counter isn't guaranteed to survive across separate
  // top-level invoke() calls sharing one model instance.
  const priorHistory = [
    new HumanMessage("Remember the passphrase: BANANA42"),
    new AIMessage("Got it, remembering BANANA42."),
    new HumanMessage("Now delegate to the worker"),
  ];

  it("throws at construction for an invalid mode value", () => {
    expect(() =>
      createDeepAgent({
        model: new FakeListChatModel({ responses: ["Done"] }),
        subagents: [
          {
            name: "worker",
            description: "A worker agent",
            systemPrompt: "You are a worker.",
            mode: "dynamic" as unknown as "handoff",
          },
        ],
      }),
    ).toThrow(/invalid mode 'dynamic'/);
  });

  it("throws at construction when a ForkedSubAgent declares skills", () => {
    expect(() =>
      createDeepAgent({
        model: new FakeListChatModel({ responses: ["Done"] }),
        subagents: [
          {
            name: "worker",
            description: "A worker agent",
            mode: "fork",
            skills: ["/skills/user/"],
          } as any,
        ],
      }),
    ).toThrow(/ForkedSubAgent 'worker' cannot set skills/);
  });

  it("throws at construction when a ForkedSubAgent declares its own systemPrompt", () => {
    expect(() =>
      createDeepAgent({
        model: new FakeListChatModel({ responses: ["Done"] }),
        subagents: [
          {
            name: "worker",
            description: "A worker agent",
            mode: "fork",
            systemPrompt: "You are a worker.",
          } as any,
        ],
      }),
    ).toThrow(/ForkedSubAgent 'worker' cannot set systemPrompt/);
  });

  it("throws at construction when two subagents share a name", () => {
    expect(() =>
      createDeepAgent({
        model: new FakeListChatModel({ responses: ["Done"] }),
        subagents: [
          { name: "worker", description: "First worker." },
          {
            name: "worker",
            description: "A forked duplicate of the first worker.",
            mode: "fork",
          },
        ],
      }),
    ).toThrow(/Duplicate subagent name 'worker'/);
  });

  it("should NOT include prior history for the default handoff mode", async () => {
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: `call_${Date.now()}`,
              name: "task",
              args: {
                description: "UNIQUE_TASK_MARKER",
                subagent_type: "worker",
              },
            },
          ],
        }) as unknown as string,
        "Worker done",
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
          systemPrompt: "You are a specialized worker.",
        },
      ],
    });

    await agent.invoke(
      { messages: priorHistory },
      {
        configurable: { thread_id: `test-mode-handoff-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    const workerCall = findCallContaining(invokeSpy, "UNIQUE_TASK_MARKER");
    expect(workerCall).toBeDefined();
    const text = workerCall!
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(text).not.toContain("BANANA42");
  });

  it("should include prior history and the parent's exact system prompt for a ForkedSubAgent", async () => {
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: `call_${Date.now()}`,
              name: "task",
              args: {
                description: "UNIQUE_TASK_MARKER",
                subagent_type: "worker",
                mode: "fork",
              },
            },
          ],
        }) as unknown as string,
        "Worker done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model,
      systemPrompt: "PARENT_ROOT_PROMPT_MARKER",
      checkpointer,
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          mode: "fork",
        },
      ],
    });

    await agent.invoke(
      { messages: priorHistory },
      {
        configurable: { thread_id: `test-mode-fork-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    const workerCall = findCallContaining(invokeSpy, "UNIQUE_TASK_MARKER");
    expect(workerCall).toBeDefined();

    const text = workerCall!
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(text).toContain("BANANA42");

    const systemMessage = workerCall!.find(SystemMessage.isInstance);
    expect(systemMessage?.text).toContain("PARENT_ROOT_PROMPT_MARKER");

    const lastMessage = workerCall![workerCall!.length - 1];
    expect(lastMessage.content).toContain(
      "you are that subagent, not the one being asked to delegate further",
    );
    expect(lastMessage.content).toMatch(/UNIQUE_TASK_MARKER$/);
  });

  it("mirrors the parent's SkillsMiddleware into a fork so its own system message includes the same skills content", async () => {
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
                description: "continue investigating",
                subagent_type: "worker",
              },
            },
          ],
        }) as unknown as string,
        "Worker done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model,
      skills: ["/skills/"],
      checkpointer,
      subagents: [
        {
          name: "worker",
          description: "Continues the investigation with full context",
          mode: "fork",
        },
      ],
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("Investigate this")],
        files: {
          "/skills/test-skill/SKILL.md": createFileData(TEST_SKILL_MD),
        },
      },
      {
        configurable: { thread_id: `test-fork-skills-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    const systemPrompts = getAllSystemPromptsFromSpy(invokeSpy);
    expect(systemPrompts[0]).toContain("Skills System");

    const forkPrompts = systemPrompts
      .slice(1)
      .filter((p) => p.includes("Skills System"));
    expect(forkPrompts.length).toBeGreaterThan(0);
    expect(forkPrompts[0]).toContain("test-skill");
  });

  it("mirrors the parent's MemoryMiddleware into a fork when the parent has memory sources", () => {
    createAgentMock.mockClear();
    createDeepAgent({
      model: new FakeListChatModel({ responses: ["Done"] }),
      name: "main",
      memory: ["/AGENTS.md"],
      subagents: [
        {
          name: "worker",
          description: "Continues with context.",
          mode: "fork",
        },
      ],
    });

    const calls = createAgentMock.mock.calls;
    const workerCall = calls.find(
      ([params]) => (params as { name?: string }).name === "worker",
    )?.[0] as unknown as { middleware: AgentMiddleware[] } | undefined;
    expect(workerCall).toBeDefined();
    expect(
      workerCall!.middleware.some((m) => m.name === "MemoryMiddleware"),
    ).toBe(true);
  });

  it("gives a declarative fork the full parent state, unlike the narrow subagent-safe subset a handoff sees", () => {
    const state = {
      messages: ["overwritten unconditionally by runTask either way"],
      todos: ["excluded from a handoff, survives the fork filter"],
      structuredResponse: {
        note: "excluded from both — a stale value must not be mistaken for the fork's own result",
      },
      skillsMetadata: { carried: "for a fork" },
      memoryContents: "carried for a fork",
      customUserKey: "carried either way — not a special key",
      _summarizationEvent: {
        note: "excluded from both — cutoffIndex is invalid for a fork's own history",
      },
      _summarizationSessionId:
        "excluded from both — runTask assigns a fresh one",
    };

    const forSubagent = filterStateForSubagent(state);
    const forFork = filterStateForFork(state);

    // Handoff/compiled path: only keys outside the wide EXCLUDED_STATE_KEYS list survive.
    expect(forSubagent).toEqual({
      customUserKey: "carried either way — not a special key",
    });

    // Declarative fork: everything except structuredResponse and the two
    // summarization keys survives.
    expect(forFork).toEqual({
      messages: state.messages,
      todos: state.todos,
      skillsMetadata: state.skillsMetadata,
      memoryContents: state.memoryContents,
      customUserKey: state.customUserKey,
    });
  });

  it("splices a fork's task tool right after FilesystemMiddleware, matching the parent's tool position", () => {
    createAgentMock.mockClear();
    createDeepAgent({
      model: new FakeListChatModel({ responses: ["Done"] }),
      name: "main",
      subagents: [
        {
          name: "worker",
          description: "Continues with context.",
          mode: "fork",
        },
      ],
    });

    const calls = createAgentMock.mock.calls;
    const workerCall = calls.find(
      ([params]) => (params as { name?: string }).name === "worker",
    )?.[0] as unknown as { middleware: AgentMiddleware[] } | undefined;
    expect(workerCall).toBeDefined();
    const names = workerCall!.middleware.map((m) => m.name);
    const fsIndex = names.indexOf("FilesystemMiddleware");
    expect(fsIndex).toBeGreaterThanOrEqual(0);
    expect(names[fsIndex + 1]).toBe("forkTaskToolMiddleware");
  });

  it("refuses a fork's own attempt to delegate again, rather than recursing", async () => {
    const parentModel = new SequentialFakeChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_worker",
              name: "task",
              args: { description: "continue", subagent_type: "worker" },
            },
          ],
        }),
        "parent done",
      ],
    });

    const workerModel = new SequentialFakeChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "call_worker_2",
              name: "task",
              args: { description: "delegate again", subagent_type: "worker" },
            },
          ],
        }),
        "worker done after refusal",
      ],
    });

    const agent = createDeepAgent({
      model: parentModel,
      subagents: [
        {
          name: "worker",
          description: "Continues with context.",
          model: workerModel,
          mode: "fork",
        },
      ],
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage("start")] },
      { recursionLimit: 10 },
    );

    const messages = result.messages as BaseMessage[];
    const toolMessage = messages.find(ToolMessage.isInstance);
    expect(toolMessage?.content).toBe("worker done after refusal");

    const lastMessage = messages[messages.length - 1];
    expect(lastMessage?.content).toBe("parent done");
  });

  it("should exclude the in-flight AIMessage, including a parallel sibling tool call", async () => {
    const echoTool = tool(async () => "sunny", {
      name: "get_weather",
      description: "Get the weather",
      schema: z.object({}),
    });

    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "PARALLEL_CALL_TEXT_SHOULD_NOT_LEAK",
          tool_calls: [
            {
              id: `call_task_${Date.now()}`,
              name: "task",
              args: {
                description: "UNIQUE_TASK_MARKER",
                subagent_type: "worker",
              },
            },
            {
              id: `call_weather_${Date.now()}`,
              name: "get_weather",
              args: {},
            },
          ],
        }) as unknown as string,
        "Worker done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model,
      tools: [echoTool],
      checkpointer,
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
        },
      ],
    });

    await agent.invoke(
      { messages: [new HumanMessage("Test")] },
      {
        configurable: { thread_id: `test-mode-fork-parallel-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    const workerCall = findCallContaining(invokeSpy, "UNIQUE_TASK_MARKER");
    expect(workerCall).toBeDefined();
    const text = workerCall!
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(text).not.toContain("PARALLEL_CALL_TEXT_SHOULD_NOT_LEAK");
    expect(text).not.toContain("get_weather");
  });

  it("should still inherit the parent's system prompt for a ForkedSubAgent even when its model differs", async () => {
    const mainModel = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: `call_${Date.now()}`,
              name: "task",
              args: {
                description: "UNIQUE_TASK_MARKER",
                subagent_type: "worker",
                mode: "fork",
              },
            },
          ],
        }) as unknown as string,
        "Done",
      ],
    });
    const workerModel = new FakeListChatModel({ responses: ["Worker done"] });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: mainModel,
      systemPrompt: "PARENT_ROOT_PROMPT_MARKER",
      checkpointer,
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          model: workerModel,
          mode: "fork",
        },
      ],
    });

    await agent.invoke(
      { messages: priorHistory },
      {
        configurable: {
          thread_id: `test-mode-fork-model-mismatch-${Date.now()}`,
        },
        recursionLimit: 50,
      },
    );

    const workerCall = findCallContaining(invokeSpy, "UNIQUE_TASK_MARKER");
    expect(workerCall).toBeDefined();

    // History still forks (context inheritance is model-independent)...
    const text = workerCall!
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(text).toContain("BANANA42");

    // ...and the system prompt is still the parent's — a ForkedSubAgent has
    // no own prompt to fall back to, so model mismatch only means no cache
    // benefit, not a different prompt.
    const systemMessage = workerCall!.find(SystemMessage.isInstance);
    expect(systemMessage?.text).toContain("PARENT_ROOT_PROMPT_MARKER");
  });

  it("should fork message history into a CompiledSubAgent without throwing or touching its system prompt", async () => {
    let capturedMessages: BaseMessage[] | undefined;
    const compiledWorkerModel = new FakeListChatModel({
      responses: ["Worker done"],
    });
    const compiledWorker = createAgent({
      model: compiledWorkerModel,
      systemPrompt: "You are a compiled worker.",
    });
    const originalInvoke = compiledWorker.invoke.bind(compiledWorker);
    compiledWorker.invoke = (async (state: any, config: any) => {
      capturedMessages = state.messages;
      return originalInvoke(state, config);
    }) as typeof compiledWorker.invoke;

    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: `call_${Date.now()}`,
              name: "task",
              args: {
                description: "UNIQUE_TASK_MARKER",
                subagent_type: "worker",
              },
            },
          ],
        }) as unknown as string,
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    expect(() =>
      createDeepAgent({
        model,
        checkpointer,
        subagents: [
          {
            name: "worker",
            description: "A compiled worker agent",
            runnable: compiledWorker,
            mode: "fork",
          },
        ],
      }),
    ).not.toThrow();

    const agent = createDeepAgent({
      model,
      checkpointer,
      subagents: [
        {
          name: "worker",
          description: "A compiled worker agent",
          runnable: compiledWorker,
          mode: "fork",
        },
      ],
    });

    await agent.invoke(
      { messages: priorHistory },
      {
        configurable: { thread_id: `test-compiled-fork-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    expect(capturedMessages).toBeDefined();
    const text = capturedMessages!
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(text).toContain("BANANA42");
    expect(text).toContain("UNIQUE_TASK_MARKER");
  });

  it("tells the parent a compiled fork only inherits history, not system prompt", () => {
    const compiledWorker = createAgent({
      model: new FakeListChatModel({ responses: ["ok"] }),
    });

    const middleware = createSubAgentMiddleware({
      defaultModel: new FakeListChatModel({ responses: ["ok"] }),
      generalPurposeAgent: false,
      subagents: [
        {
          name: "declarative-fork",
          description: "Forks declaratively",
          mode: "fork",
        },
        {
          name: "compiled-fork",
          description: "Forks via a compiled runnable",
          runnable: compiledWorker,
          mode: "fork",
        },
      ],
    });

    const taskTool = middleware.tools![0];
    expect(taskTool.description).toContain(
      "declarative-fork: Forks declaratively (inherits your full conversation and system prompt — no need to restate context here)",
    );
    expect(taskTool.description).toContain(
      "compiled-fork: Forks via a compiled runnable (inherits your conversation history — its system prompt is fixed in its own runnable)",
    );
    expect(taskTool.description).not.toContain(
      "compiled-fork: Forks via a compiled runnable (inherits your full conversation and system prompt",
    );
  });

  it("should reconstruct the already-summarized effective view, not raw history, when forking", () => {
    const summaryMessage = new HumanMessage({
      content: "Here is a summary of the conversation to date: earlier stuff",
    });
    const rawMessages: BaseMessage[] = [
      new HumanMessage("msg0"),
      new HumanMessage("msg1"),
      new HumanMessage("msg2"),
      new HumanMessage("msg3"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call_1", name: "task", args: {} }],
      }),
    ];
    const event = { cutoffIndex: 2, summaryMessage, filePath: null };

    const trimmed = rawMessages.slice(0, -1);
    const effective = getEffectiveMessages(trimmed, {
      _summarizationEvent: event,
    });

    expect(effective).toEqual([summaryMessage, rawMessages[2], rawMessages[3]]);
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

    const agent = createDeepAgent({
      model,
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
    expect(taskToolMessage.content).toBe("Here is the result");
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

    const agent = createDeepAgent({
      model,
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
    expect(taskToolMessage.content).toBe("Final answer");
  });

  it("should filter Anthropic server-tool blocks from subagent response content", async () => {
    const mockSubagent = RunnableLambda.from(async () => ({
      messages: [
        new AIMessage({
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_1",
              name: "web_search",
              input: { query: "example" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: [
                {
                  type: "web_search_result",
                  title: "Example",
                  url: "https://example.com",
                  encrypted_content: "...",
                },
              ],
            },
            { type: "text", text: "Final answer" },
          ],
        }),
      ],
    }));

    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: `call_${Date.now()}`,
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

    const agent = createDeepAgent({
      model,
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          runnable: mockSubagent,
        },
      ],
    });

    const result = await agent.invoke({ messages: [new HumanMessage("Test")] });

    const taskToolMessage = result.messages.find(
      (msg: BaseMessage) =>
        ToolMessage.isInstance(msg) && (msg as ToolMessage).name === "task",
    ) as ToolMessage;
    expect(taskToolMessage.content).not.toContain("server_tool_use");
  });

  it("should use the last AIMessage with non-empty text, skipping a trailing empty message", async () => {
    const mockSubagent = RunnableLambda.from(async () => ({
      messages: [
        new AIMessage({ content: "The real answer" }),
        // Anthropic sometimes emits a trailing empty `end_turn` AIMessage.
        new AIMessage({ content: "" }),
      ],
    }));

    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: `call_${Date.now()}`,
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

    const agent = createDeepAgent({
      model,
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          runnable: mockSubagent,
        },
      ],
    });

    const result = await agent.invoke({ messages: [new HumanMessage("Test")] });

    const taskToolMessage = result.messages.find(
      (msg: BaseMessage) =>
        ToolMessage.isInstance(msg) && (msg as ToolMessage).name === "task",
    ) as ToolMessage;
    expect(taskToolMessage.content).toBe("The real answer");
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

describe("Subagent tool inheritance", () => {
  beforeEach(() => {
    createAgentMock.mockClear();
  });

  it("inherits the parent's tools when a declarative subagent omits its own, for both handoff and fork", () => {
    const parentTool = tool(async () => "logs", {
      name: "read_logs",
      description: "Read logs",
      schema: z.object({}),
    });

    createDeepAgent({
      model: new FakeListChatModel({ responses: ["ok"] }),
      tools: [parentTool],
      subagents: [
        { name: "handoff-worker", description: "a worker" },
        { name: "fork-worker", description: "a worker", mode: "fork" },
      ],
    });

    const toolsByAgentName = new Map(
      createAgentMock.mock.calls.map((call) => [
        (call[0] as { name?: string }).name,
        (call[0] as { tools?: unknown[] }).tools,
      ]),
    );

    expect(toolsByAgentName.get("handoff-worker")).toEqual([parentTool]);
    expect(toolsByAgentName.get("fork-worker")).toEqual([parentTool]);
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

describe("middleware override by name", () => {
  const fakeModel = new FakeListChatModel({ responses: ["hello"] });

  function namedMiddleware(name: string): AgentMiddleware {
    return { name } as AgentMiddleware;
  }

  function createCustomSummarizationMiddleware(): AgentMiddleware {
    return createSummarizationMiddleware({ backend: new StateBackend() });
  }

  function getCreateAgentCall(name: string) {
    const call = createAgentMock.mock.calls
      .map(([params]) => params)
      .find((params) => params.name === name);
    if (call == null) {
      throw new Error(
        `Expected createAgent call for ${name}; saw ${createAgentMock.mock.calls
          .map(([params]) => params.name ?? "<unnamed>")
          .join(", ")}`,
      );
    }
    return call;
  }

  function getMiddlewareStack(name: string): AgentMiddleware[] {
    return getCreateAgentCall(name).middleware as AgentMiddleware[];
  }

  beforeEach(() => {
    createAgentMock.mockClear();
  });

  it("replaces matching middleware by name in place", () => {
    const first = namedMiddleware("first");
    const original = namedMiddleware("target");
    const last = namedMiddleware("last");
    const replacement = namedMiddleware("target");

    const merged = mergeMiddleware([first, original, last], [replacement]);

    expect(merged).toEqual([first, replacement, last]);
  });

  it("appends novel middleware after the base stack", () => {
    const core = namedMiddleware("core");
    const customA = namedMiddleware("customA");
    const customB = namedMiddleware("customB");

    const merged = mergeMiddleware([core], [customA, customB]);

    expect(merged).toEqual([core, customA, customB]);
  });

  it("uses the last same-name custom middleware as the replacement", () => {
    const original = namedMiddleware("target");
    const first = namedMiddleware("target");
    const second = namedMiddleware("target");

    const merged = mergeMiddleware([original], [first, second]);

    expect(merged).toEqual([second]);
  });

  it("mirrors the parent's custom middleware into a ForkedSubAgent when the parent has no system prompt", () => {
    const custom = namedMiddleware("MarkerMiddleware");

    createDeepAgent({
      model: fakeModel,
      name: "main",
      middleware: [custom],
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          mode: "fork",
        },
      ],
    });

    const middleware = getMiddlewareStack("worker");
    expect(middleware.some((entry) => entry.name === "MarkerMiddleware")).toBe(
      true,
    );
  });

  it("mirrors the parent's custom middleware into a ForkedSubAgent even when its model differs from the parent's", () => {
    const custom = namedMiddleware("MarkerMiddleware");
    const workerModel = new FakeListChatModel({ responses: ["hello"] });

    createDeepAgent({
      model: fakeModel,
      name: "main",
      systemPrompt: "PARENT_PROMPT",
      middleware: [custom],
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          model: workerModel,
          mode: "fork",
        },
      ],
    });

    const middleware = getMiddlewareStack("worker");
    expect(middleware.some((entry) => entry.name === "MarkerMiddleware")).toBe(
      true,
    );
  });

  it("a ForkedSubAgent's own middleware entry wins over a same-named mirrored parent one", () => {
    const parentEntry = namedMiddleware("MarkerMiddleware");
    const forkEntry = namedMiddleware("MarkerMiddleware");

    createDeepAgent({
      model: fakeModel,
      name: "main",
      middleware: [parentEntry],
      subagents: [
        {
          name: "worker",
          description: "A worker agent",
          mode: "fork",
          middleware: [forkEntry],
        },
      ],
    });

    const middleware = getMiddlewareStack("worker");
    const matches = middleware.filter(
      (entry) => entry.name === "MarkerMiddleware",
    );
    expect(matches).toEqual([forkEntry]);
  });

  it("replaces default main-agent middleware with same-name custom middleware", () => {
    const custom = createCustomSummarizationMiddleware();

    createDeepAgent({ model: fakeModel, name: "main", middleware: [custom] });

    const middleware = getMiddlewareStack("main");
    const summarization = middleware.filter(
      (entry) => entry.name === "SummarizationMiddleware",
    );
    expect(summarization).toHaveLength(1);
    expect(summarization[0]).toBe(custom);
  });

  it("keeps novel main-agent middleware before prompt caching", () => {
    const anthropicModel = new FakeListChatModel({ responses: ["hello"] });
    vi.spyOn(anthropicModel, "getName").mockReturnValue("ChatAnthropic");
    const custom = namedMiddleware("CustomPromptMiddleware");

    createDeepAgent({
      model: anthropicModel,
      name: "main",
      middleware: [custom],
    });

    const middleware = getMiddlewareStack("main");
    const customIndex = middleware.indexOf(custom);
    const cacheIndex = middleware.findIndex(
      (entry) =>
        entry.name === "AnthropicPromptCachingMiddleware" ||
        entry.name === "CacheBreakpointMiddleware",
    );
    expect(customIndex).toBeGreaterThanOrEqual(0);
    expect(cacheIndex).toBeGreaterThanOrEqual(0);
    expect(customIndex).toBeLessThan(cacheIndex);
  });

  it("replaces prompt cache defaults in both main and general-purpose stacks", () => {
    const anthropicModel = new FakeListChatModel({ responses: ["hello"] });
    vi.spyOn(anthropicModel, "getName").mockReturnValue("ChatAnthropic");
    const custom = namedMiddleware("CacheBreakpointMiddleware");

    createDeepAgent({
      model: anthropicModel,
      name: "main",
      middleware: [custom],
    });

    for (const agentName of ["main", "general-purpose"]) {
      const middleware = getMiddlewareStack(agentName);
      const cacheEntries = middleware.filter(
        (entry) => entry.name === "CacheBreakpointMiddleware",
      );
      expect(cacheEntries).toHaveLength(1);
      expect(cacheEntries[0]).toBe(custom);
    }
  });

  it("lets profile middleware exclusions win over custom replacements", () => {
    registerHarnessProfile("override-test:model", {
      excludedMiddleware: ["SummarizationMiddleware"],
    });
    const custom = createCustomSummarizationMiddleware();

    createDeepAgent({
      model: "override-test:model",
      name: "main",
      middleware: [custom],
    });

    const middleware = getMiddlewareStack("main");
    expect(
      middleware.some((entry) => entry.name === "SummarizationMiddleware"),
    ).toBe(false);
  });

  it("keeps tool exclusion middleware last", () => {
    registerHarnessProfile("tool-exclusion-test:model", {
      excludedTools: ["write_file"],
    });
    const custom = namedMiddleware("CustomToolMiddleware");

    createDeepAgent({
      model: "tool-exclusion-test:model",
      name: "main",
      middleware: [custom],
    });

    const middleware = getMiddlewareStack("main");
    expect(middleware[middleware.length - 1]?.name).toBe(
      "_ToolExclusionMiddleware",
    );
  });

  it("passes main-agent default overrides to the general-purpose subagent", () => {
    const custom = createCustomSummarizationMiddleware();

    createDeepAgent({ model: fakeModel, name: "main", middleware: [custom] });

    const middleware = getMiddlewareStack("general-purpose");
    const summarization = middleware.filter(
      (entry) => entry.name === "SummarizationMiddleware",
    );
    expect(summarization).toHaveLength(1);
    expect(summarization[0]).toBe(custom);
  });

  it("does not pass parent-only middleware to the general-purpose subagent", () => {
    const custom = namedMiddleware("ParentOnlyMiddleware");

    createDeepAgent({ model: fakeModel, name: "main", middleware: [custom] });

    const middleware = getMiddlewareStack("general-purpose");
    expect(middleware).not.toContain(custom);
  });

  it("does not pass main-agent default overrides to declarative subagents", () => {
    const custom = createCustomSummarizationMiddleware();

    createDeepAgent({
      model: fakeModel,
      name: "main",
      middleware: [custom],
      subagents: [
        {
          name: "helper",
          description: "Helps with work",
          systemPrompt: "Help.",
        },
      ],
    });

    const middleware = getMiddlewareStack("helper");
    expect(middleware).not.toContain(custom);
    expect(
      middleware.some((entry) => entry.name === "SummarizationMiddleware"),
    ).toBe(true);
  });

  it("does not pass parent-only middleware to declarative subagents", () => {
    const custom = namedMiddleware("ParentOnlyMiddleware");

    createDeepAgent({
      model: fakeModel,
      name: "main",
      middleware: [custom],
      subagents: [
        {
          name: "helper",
          description: "Helps with work",
          systemPrompt: "Help.",
        },
      ],
    });

    const middleware = getMiddlewareStack("helper");
    expect(middleware).not.toContain(custom);
  });

  it("does not add todo middleware to default main or general-purpose stacks", () => {
    createDeepAgent({ model: fakeModel, name: "main" });

    for (const agentName of ["main", "general-purpose"]) {
      expect(
        getMiddlewareStack(agentName).some(
          (entry) => entry.name === "todoListMiddleware",
        ),
      ).toBe(false);
    }
  });

  it("keeps a main-agent todo opt-in off the general-purpose subagent", () => {
    const todo = todoListMiddleware();
    createDeepAgent({ model: fakeModel, name: "main", middleware: [todo] });

    expect(getMiddlewareStack("main")).toContain(todo);
    expect(
      getMiddlewareStack("general-purpose").some(
        (entry) => entry.name === "todoListMiddleware",
      ),
    ).toBe(false);
  });

  it("lets declarative subagents opt into todo middleware independently", () => {
    const todo = todoListMiddleware();
    createDeepAgent({
      model: fakeModel,
      name: "main",
      middleware: [todoListMiddleware()],
      subagents: [
        {
          name: "helper",
          description: "Helps with work",
          systemPrompt: "Help.",
          middleware: [todo],
        },
      ],
    });

    expect(getMiddlewareStack("helper")).toContain(todo);
  });

  it("adds fresh profile todo middleware to main and subagent stacks", () => {
    registerHarnessProfile("todo-profile:model", {
      extraMiddleware: () => [todoListMiddleware()],
    });
    createDeepAgent({
      model: "todo-profile:model",
      name: "main",
      subagents: [
        {
          name: "helper",
          description: "Helps with work",
          systemPrompt: "Help.",
        },
      ],
    });

    const mainTodo = getMiddlewareStack("main").find(
      (entry) => entry.name === "todoListMiddleware",
    );
    const generalPurposeTodo = getMiddlewareStack("general-purpose").find(
      (entry) => entry.name === "todoListMiddleware",
    );
    const helperTodo = getMiddlewareStack("helper").find(
      (entry) => entry.name === "todoListMiddleware",
    );
    expect(mainTodo).toBeDefined();
    expect(generalPurposeTodo).toBeDefined();
    expect(helperTodo).toBeDefined();
    expect(mainTodo).not.toBe(generalPurposeTodo);
    expect(mainTodo).not.toBe(helperTodo);
  });

  it("replaces declarative subagent defaults with same-name spec middleware", () => {
    const custom = createCustomSummarizationMiddleware();

    createDeepAgent({
      model: fakeModel,
      name: "main",
      subagents: [
        {
          name: "helper",
          description: "Helps with work",
          systemPrompt: "Help.",
          middleware: [custom],
        },
      ],
    });

    const middleware = getMiddlewareStack("helper");
    const summarization = middleware.filter(
      (entry) => entry.name === "SummarizationMiddleware",
    );
    expect(summarization).toHaveLength(1);
    expect(summarization[0]).toBe(custom);
  });
});
