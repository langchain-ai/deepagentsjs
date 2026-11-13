import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createAgent, createMiddleware, tool } from "langchain";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { createDeepAgent } from "./agent.js";
import {
  _resetRegistryForTesting,
  registerHarnessProfile,
} from "./profiles/harness/index.js";
import type { SubAgent } from "./middleware/subagents.js";

class DelegatingModel extends FakeListChatModel {
  readonly prompts: BaseMessage[][] = [];
  readonly bindings: string[][] = [];

  constructor(private readonly replies: AIMessage[] = []) {
    super({ responses: [] });
  }

  override bindTools(tools: { name?: string }[]) {
    this.bindings.push(
      tools.flatMap((entry) => (entry.name ? [entry.name] : [])),
    );
    return this;
  }

  override async _generate(messages: BaseMessage[]) {
    this.prompts.push(messages);
    return {
      generations: [
        { text: "", message: this.replies.shift() ?? new AIMessage("done") },
      ],
    };
  }
}

class ProfiledModel extends DelegatingModel {
  _defaultConfig = { modelProvider: "hooktest", model: "model" };

  override getName() {
    return "ConfigurableModel";
  }
}

const task = (name: string) =>
  new AIMessage({
    content: "",
    tool_calls: [
      {
        name: "task",
        args: { subagent_type: name, description: "Help." },
        id: "task",
      },
    ],
  });

afterEach(() => {
  _resetRegistryForTesting();
  vi.restoreAllMocks();
});

it("calls the factory once per declarative child, including forks and native GP, but not compiled or async children", () => {
  const factory = vi.fn((_spec: SubAgent) => []);
  const model = new DelegatingModel();
  const authored = {
    name: "helper",
    description: "Help.",
    systemPrompt: "Help.",
  };
  createDeepAgent({
    model,
    subagentMiddleware: factory,
    subagents: [
      authored,
      { name: "fork", description: "Fork.", mode: "fork" },
      {
        name: "compiled",
        description: "Compiled.",
        runnable: createAgent({ model }),
      },
      { name: "remote", description: "Remote.", graphId: "remote" },
    ],
  });
  expect(factory.mock.calls.map(([spec]: [SubAgent]) => spec.name)).toEqual([
    "helper",
    "fork",
    "general-purpose",
  ]);
  expect(factory.mock.calls[0][0]).toEqual(authored);
  expect(factory.mock.calls[0][0]).not.toBe(authored);
});

it.each(["string", "instance"])(
  "preserves native GP profile prompt and description for %s models",
  (kind) => {
    registerHarnessProfile("hooktest:model", {
      generalPurposeSubagent: {
        systemPrompt: "Profile prompt",
        description: "Profile description",
      },
    });
    const factory = vi.fn((_spec: SubAgent) => []);
    createDeepAgent({
      model: kind === "string" ? "hooktest:model" : new ProfiledModel(),
      subagentMiddleware: factory,
    });
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "general-purpose",
        systemPrompt: "Profile prompt",
        description: "Profile description",
      }),
    );
  },
);

it.each(["string", "instance"])(
  "does not create a disabled native GP or invoke its factory for %s models",
  (kind) => {
    registerHarnessProfile("hooktest:model", {
      generalPurposeSubagent: { enabled: false },
    });
    const factory = vi.fn((_spec: SubAgent) => []);
    createDeepAgent({
      model: kind === "string" ? "hooktest:model" : new ProfiledModel(),
      subagentMiddleware: factory,
    });
    expect(factory).not.toHaveBeenCalled();
  },
);

it.each(["general-purpose", "helper", "fork"])(
  "injects dynamic tools into %s without leaking application middleware and keeps named factory overrides",
  async (name) => {
    const model = new DelegatingModel([
      task(name),
      new AIMessage({
        content: "",
        tool_calls: [{ name: "child_tool", args: {}, id: "child" }],
      }),
      new AIMessage("child done"),
      new AIMessage("parent done"),
    ]);
    const parentHook = vi.fn();
    const staleHook = vi.fn();
    const factoryHook = vi.fn();
    const execute = vi.fn(() => "result");
    const childTool = tool(execute, {
      name: "child_tool",
      description: "A child tool.",
      schema: z.object({}),
    });
    const agent = createDeepAgent({
      model,
      middleware: [
        createMiddleware({
          name: "ApplicationLifecycle",
          beforeAgent: parentHook,
        }),
        createMiddleware({ name: "ChildSlot", beforeAgent: staleHook }),
      ],
      subagents:
        name === "general-purpose"
          ? []
          : [
              {
                name,
                description: "Help.",
                ...(name === "fork"
                  ? { mode: "fork" as const }
                  : { systemPrompt: "Help." }),
              },
            ],
      subagentMiddleware: () => [
        createMiddleware({
          name: "ChildSlot",
          beforeAgent: factoryHook,
          wrapModelCall: (request, handler) =>
            handler({ ...request, tools: [...request.tools, childTool] }),
          wrapToolCall: (request, handler) =>
            handler(
              request.toolCall.name === childTool.name
                ? { ...request, tool: childTool }
                : request,
            ),
        }),
      ],
    });
    await agent.invoke({ messages: [new HumanMessage("Go.")] });
    expect(execute).toHaveBeenCalledOnce();
    expect(factoryHook).toHaveBeenCalledOnce();
    expect(staleHook).toHaveBeenCalledOnce();
    expect(parentHook).toHaveBeenCalledTimes(name === "fork" ? 2 : 1);
    expect(model.bindings[0]).not.toContain("child_tool");
    expect(model.bindings[1]).toContain("child_tool");
  },
);

it("keeps profile exclusions authoritative over factory middleware and injected tools", async () => {
  registerHarnessProfile("hooktest:model", {
    excludedMiddleware: ["ExcludedHook"],
    excludedTools: ["hidden_tool"],
  });
  const excludedHook = vi.fn();
  const execute = vi.fn(() => "must not run");
  const hidden = tool(execute, {
    name: "hidden_tool",
    description: "Hidden.",
    schema: z.object({}),
  });
  const model = new ProfiledModel([
    task("general-purpose"),
    new AIMessage({
      content: "",
      tool_calls: [{ name: hidden.name, args: {}, id: "hidden" }],
    }),
    new AIMessage("child done"),
    new AIMessage("parent done"),
  ]);
  const agent = createDeepAgent({
    model,
    subagentMiddleware: () => [
      createMiddleware({ name: "ExcludedHook", beforeAgent: excludedHook }),
      createMiddleware({
        name: "DynamicTools",
        wrapModelCall: (request, handler) =>
          handler({ ...request, tools: [...request.tools, hidden] }),
        wrapToolCall: (request, handler) =>
          handler(
            request.toolCall.name === hidden.name
              ? { ...request, tool: hidden }
              : request,
          ),
      }),
    ],
  });
  await agent.invoke({ messages: [new HumanMessage("Go.")] });
  expect(excludedHook).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(model.bindings.every((names) => !names.includes(hidden.name))).toBe(
    true,
  );
});
