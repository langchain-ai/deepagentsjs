/**
 * Regression tests for issue #646: the `task` tool forwarded a subagent's
 * whole final state to the parent, so identically-named middleware channels
 * collided on parallel delegation and overwrote each other on serial
 * delegation. `files` must keep propagating — it is shared on purpose.
 */

import { describe, it, expect } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  createMiddleware,
  modelCallLimitMiddleware,
  tool,
  toolCallLimitMiddleware,
} from "langchain";
import { z } from "zod/v3";

import { createDeepAgent } from "../agent.js";
import { filterStateForFork, filterStateForSubagent } from "./subagents.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Deterministic scripted model. `FakeListChatModel` restarts its response list
 * on `bindTools()`, which breaks multi-turn flows.
 */
class ScriptedChatModel extends BaseChatModel<any> {
  public calls = 0;

  constructor(
    private readonly script: (
      call: number,
      messages: BaseMessage[],
    ) => AIMessage,
  ) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  override bindTools(): any {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<any> {
    this.calls += 1;
    const message = this.script(this.calls, messages);
    return {
      generations: [
        {
          message,
          text: typeof message.content === "string" ? message.content : "",
        },
      ],
    };
  }
}

let toolCallSeq = 0;

/** One AIMessage carrying `count` parallel `task` calls to the same subagent. */
function parallelTaskCalls(
  count: number,
  subagentType = "explorer",
): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: Array.from({ length: count }, () => {
      toolCallSeq += 1;
      return {
        id: `call_${toolCallSeq}`,
        name: "task",
        args: {
          description: `investigate ${toolCallSeq}`,
          subagent_type: subagentType,
        },
        type: "tool_call" as const,
      };
    }),
  });
}

/** One AIMessage carrying a single `task` call to each named subagent. */
function taskCallsTo(...subagentTypes: string[]): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: subagentTypes.map((subagentType) => {
      toolCallSeq += 1;
      return {
        id: `call_${toolCallSeq}`,
        name: "task",
        args: {
          description: `investigate ${toolCallSeq}`,
          subagent_type: subagentType,
        },
        type: "tool_call" as const,
      };
    }),
  });
}

function singleToolCall(
  name: string,
  args: Record<string, unknown>,
): AIMessage {
  toolCallSeq += 1;
  return new AIMessage({
    content: "",
    tool_calls: [
      { id: `call_${toolCallSeq}`, name, args, type: "tool_call" as const },
    ],
  });
}

const finalMessage = (text: string) => new AIMessage({ content: text });

const noopTool = tool(async () => "ok", {
  name: "noop",
  description: "Does nothing.",
  schema: z.object({}) as any,
});

/** `modelCallLimitMiddleware` with a run-scoped cap. */
const withRunLimit = (limit: number) =>
  modelCallLimitMiddleware({ runLimit: limit, exitBehavior: "end" });

/** `modelCallLimitMiddleware` with a thread-scoped cap. */
const withThreadLimit = (limit: number) =>
  modelCallLimitMiddleware({ threadLimit: limit, exitBehavior: "end" });

function explorer(overrides: Record<string, unknown> = {}): any {
  return {
    name: "explorer",
    description: "Read-only investigator.",
    systemPrompt: "Search and report findings.",
    tools: [],
    model: new ScriptedChatModel(() => finalMessage("subagent done")),
    ...overrides,
  };
}

const invoke = (agent: any, recursionLimit = 40) =>
  agent.invoke(
    { messages: [new HumanMessage("go")] },
    { recursionLimit },
  ) as Promise<Record<string, unknown>>;

/** `task` results that made it back into the parent's messages. */
const completedDelegations = (state: Record<string, unknown>) =>
  ((state.messages ?? []) as BaseMessage[]).filter(ToolMessage.isInstance)
    .length;

// ─── tests ───────────────────────────────────────────────────────────────────

describe("subagent state isolation (issue #646)", () => {
  it("survives two parallel task calls when the parent and the subagent both cap model calls", async () => {
    const agent = createDeepAgent({
      model: new ScriptedChatModel((call) =>
        call === 1 ? parallelTaskCalls(2) : finalMessage("done"),
      ),
      middleware: [withRunLimit(500)],
      subagents: [explorer({ middleware: [withRunLimit(40)] })],
    } as any);

    expect(completedDelegations(await invoke(agent))).toBe(2);
  });

  it("survives two parallel task calls to a fork subagent when only the parent declares the middleware", async () => {
    const agent = createDeepAgent({
      model: new ScriptedChatModel((call) =>
        call === 1 ? parallelTaskCalls(2) : finalMessage("done"),
      ),
      middleware: [withRunLimit(500)],
      subagents: [
        {
          name: "explorer",
          description: "Continues the parent's conversation.",
          mode: "fork",
          model: new ScriptedChatModel(() => finalMessage("subagent done")),
        },
      ],
    } as any);

    expect(completedDelegations(await invoke(agent))).toBe(2);
  });

  it("survives two parallel task calls when the parent and the subagent both cap tool calls", async () => {
    const agent = createDeepAgent({
      model: new ScriptedChatModel((call) =>
        call === 1 ? parallelTaskCalls(2) : finalMessage("done"),
      ),
      middleware: [
        toolCallLimitMiddleware({ threadLimit: 100, exitBehavior: "continue" }),
      ],
      subagents: [
        explorer({
          middleware: [
            toolCallLimitMiddleware({
              threadLimit: 50,
              exitBehavior: "continue",
            }),
          ],
        }),
      ],
    } as any);

    expect(completedDelegations(await invoke(agent))).toBe(2);
  });

  it("keeps call-count bookkeeping out of both the inbound and outbound filters", () => {
    const state = {
      threadModelCallCount: 7,
      runModelCallCount: 3,
      threadToolCallCount: { __all__: 4 },
      runToolCallCount: { __all__: 2 },
      files: { "/kept.txt": "shared, reducer-backed" },
      customUserKey: "kept — not declared by any middleware",
    };

    for (const filtered of [
      filterStateForSubagent(state),
      filterStateForFork(state),
    ]) {
      expect(filtered).not.toHaveProperty("threadModelCallCount");
      expect(filtered).not.toHaveProperty("runModelCallCount");
      expect(filtered).not.toHaveProperty("threadToolCallCount");
      expect(filtered).not.toHaveProperty("runToolCallCount");
      expect(filtered.customUserKey).toBe(state.customUserKey);
    }

    // `files` is deliberately shared; only the isolated filter drops it.
    expect(filterStateForFork(state).files).toEqual(state.files);
  });

  it("survives one task call to each of two different subagents that declare the same state key", async () => {
    const agent = createDeepAgent({
      model: new ScriptedChatModel((call) =>
        call === 1 ? taskCallsTo("alpha", "beta") : finalMessage("done"),
      ),
      middleware: [withRunLimit(500)],
      subagents: [
        explorer({ name: "alpha", middleware: [withRunLimit(40)] }),
        explorer({ name: "beta", middleware: [withRunLimit(40)] }),
      ],
    } as any);

    expect(completedDelegations(await invoke(agent))).toBe(2);
  });

  /**
   * The next two tests assert current broken behaviour, not desired behaviour.
   * Excluding by key name misses other middleware with plain state; the
   * schema-driven follow-up closes it. Flip both to `resolves.toBeDefined()`
   * when it lands.
   */
  it("still leaks parent-declared middleware state into a fork (pending schema-driven filtering)", async () => {
    // Same shape as the opt-in createAgentMemoryMiddleware. A fork inherits
    // the parent's middleware, so this needs no subagent-side config.
    const memoryLike = createMiddleware({
      name: "MemoryLikeMw",
      stateSchema: z.object({ userMemory: z.string().optional() }) as any,
      // `as any` on stateSchema collapses the hook's inferred update type.
      beforeAgent: () => ({ userMemory: "user prefs" }) as any,
    });

    const agent = createDeepAgent({
      model: new ScriptedChatModel((call) =>
        call === 1 ? parallelTaskCalls(2) : finalMessage("done"),
      ),
      middleware: [memoryLike],
      subagents: [
        {
          name: "explorer",
          description: "Continues the parent's conversation.",
          mode: "fork",
          model: new ScriptedChatModel(() => finalMessage("subagent done")),
        },
      ],
    } as any);

    await expect(invoke(agent)).rejects.toMatchObject({
      lc_error_code: "INVALID_CONCURRENT_GRAPH_UPDATE",
    });
  });

  it("still leaks arbitrary user middleware state (pending schema-driven filtering)", async () => {
    // The subagent's middleware has no hooks: the colliding value is the
    // parent's own, copied in and handed back out.
    const parentCounter = createMiddleware({
      name: "ParentCounterMw",
      stateSchema: z.object({ isolationProbe: z.number().default(0) }) as any,
      afterModel: (state: any) => ({
        isolationProbe: (state.isolationProbe ?? 0) + 1,
      }),
    });
    const inertCounter = createMiddleware({
      name: "InertCounterMw",
      stateSchema: z.object({ isolationProbe: z.number().default(0) }) as any,
    });

    const agent = createDeepAgent({
      model: new ScriptedChatModel((call) =>
        call === 1 ? parallelTaskCalls(2) : finalMessage("done"),
      ),
      middleware: [parentCounter],
      subagents: [explorer({ middleware: [inertCounter] })],
    } as any);

    await expect(invoke(agent)).rejects.toMatchObject({
      lc_error_code: "INVALID_CONCURRENT_GRAPH_UPDATE",
    });
  });

  it("enforces the parent's run limit even though every turn delegates", async () => {
    // The subagent's `afterAgent` reset used to leak up and rewind the budget.
    const parentModel = new ScriptedChatModel((call) =>
      call <= 20 ? parallelTaskCalls(1) : finalMessage("done"),
    );

    const agent = createDeepAgent({
      model: parentModel,
      middleware: [withRunLimit(3)],
      subagents: [explorer({ middleware: [withRunLimit(40)] })],
    } as any);

    await invoke(agent);

    expect(parentModel.calls).toBe(3);
  });

  it("counts only the parent's own model calls in the parent's thread counter", async () => {
    const parentModel = new ScriptedChatModel((call) =>
      call === 1 ? parallelTaskCalls(1) : finalMessage("done"),
    );
    // Burns four model calls of its own via a plain tool loop.
    const subagentModel = new ScriptedChatModel((call) =>
      call <= 3 ? singleToolCall("noop", {}) : finalMessage("subagent done"),
    );

    const agent = createDeepAgent({
      model: parentModel,
      middleware: [withThreadLimit(100)],
      subagents: [
        explorer({
          model: subagentModel,
          tools: [noopTool],
          middleware: [withThreadLimit(100)],
        }),
      ],
    } as any);

    const result = await invoke(agent);

    expect(parentModel.calls).toBe(2);
    expect(subagentModel.calls).toBe(4);
    expect(result.threadModelCallCount).toBe(parentModel.calls);
  });

  it("gives a fresh subagent its own zeroed counters instead of the parent's", async () => {
    const observed: Array<{ thread: unknown; run: unknown }> = [];
    const counterProbe = createMiddleware({
      name: "CounterProbeMw",
      stateSchema: z.object({
        threadModelCallCount: z.number().default(0),
        runModelCallCount: z.number().default(0),
      }) as any,
      beforeModel: (state: any) => {
        observed.push({
          thread: state.threadModelCallCount,
          run: state.runModelCallCount,
        });
        return undefined;
      },
    });

    const agent = createDeepAgent({
      model: new ScriptedChatModel((call) =>
        call <= 2 ? parallelTaskCalls(1) : finalMessage("done"),
      ),
      middleware: [withThreadLimit(100)],
      subagents: [
        explorer({ middleware: [withThreadLimit(100), counterProbe] }),
      ],
    } as any);

    await invoke(agent);

    // Two sequential delegations, each a brand-new subagent run.
    expect(observed).toHaveLength(2);
    for (const seen of observed) {
      expect(seen).toEqual({ thread: 0, run: 0 });
    }
  });

  it("still propagates files written by parallel subagents to the parent", async () => {
    // `files` is a deliberately shared, reducer-backed channel. Isolating
    // private middleware state must not break it.
    const writerModel = new ScriptedChatModel((call, messages) => {
      const last = messages[messages.length - 1];
      if (ToolMessage.isInstance(last)) return finalMessage("wrote it");
      return singleToolCall("write_file", {
        file_path: `/report_${call}.txt`,
        content: `report ${call}`,
      });
    });

    const agent = createDeepAgent({
      model: new ScriptedChatModel((call) =>
        call === 1 ? parallelTaskCalls(2, "writer") : finalMessage("done"),
      ),
      subagents: [
        {
          name: "writer",
          description: "Writes files.",
          systemPrompt: "Write the requested file.",
          model: writerModel,
        },
      ],
    } as any);

    const result = await invoke(agent);

    const writtenPaths = Object.keys(
      (result.files as Record<string, unknown>) ?? {},
    ).sort();
    expect(writtenPaths).toHaveLength(2);
    for (const path of writtenPaths) {
      expect(path).toMatch(/^\/report_\d+\.txt$/);
    }
  });
});
