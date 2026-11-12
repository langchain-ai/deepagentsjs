import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createAgent, summarizationMiddleware, tool } from "langchain";
import {
  Annotation,
  Command,
  MemorySaver,
  MessagesValue,
  ReducedValue,
  StateSchema,
  type AnyStateSchema,
} from "@langchain/langgraph";
import { registry } from "@langchain/langgraph/zod";
import { isDeltaSnapshot } from "@langchain/langgraph-checkpoint";
import { z } from "zod/v4";
import { z as z3 } from "zod/v3";
import { createDeepAgent } from "./agent.js";
import type { FileData } from "./backends/protocol.js";
import { deepAgentStateSchema, filesValue } from "./values.js";

type ScriptedCall = { name: string; args: Record<string, unknown> };
type Reply = (messages: BaseMessage[]) => AIMessage;

const thread = (id: string) => ({ configurable: { thread_id: id } });
const approve = new Command({ resume: { decisions: [{ type: "approve" }] } });
const ids = (messages: BaseMessage[]) => messages.map((m) => m.id);
const contents = (files: unknown) =>
  Object.fromEntries(
    Object.entries(files as Record<string, FileData>).map(([path, file]) => [
      path,
      Array.isArray(file.content)
        ? file.content.join("\n")
        : String(file.content),
    ]),
  );

function replyingModel(reply: Reply) {
  let model = fakeModel();
  for (let n = 0; n < 500; n++) model = model.respond(reply);
  return model;
}

/**
 * Makes one turn of tool calls per entry (an array is several calls in one
 * turn), then answers "done".
 */
function scriptedModel(
  turns: (ScriptedCall | ScriptedCall[])[],
  callPrefix = "call",
) {
  let issued = 0;
  let calls = 0;
  return replyingModel((messages) => {
    if (
      messages.some((m) =>
        m.text.startsWith("You are a conversation summarizer"),
      )
    ) {
      return new AIMessage("summary");
    }
    if (issued === turns.length) return new AIMessage("done");
    const turn = turns[issued++];
    return new AIMessage({
      content: "",
      tool_calls: (Array.isArray(turn) ? turn : [turn]).map((call) => ({
        ...call,
        id: `${callPrefix}_${calls++}`,
      })),
    });
  });
}

const shape = (messages: BaseMessage[]) =>
  messages.map((m) => [m.type, m.text]);
const noop = tool(async ({ i }) => `ok ${i}`, {
  name: "noop",
  description: "Does nothing.",
  schema: z.object({ i: z.number() }),
});
const noopTurns = (turns: number, from = 0): ScriptedCall[] =>
  Array.from({ length: turns }, (_, i) => ({
    name: "noop",
    args: { i: from + i },
  }));

/** The full copies of `channel` stored in the checkpoints of one namespace. */
async function storedCopies(
  checkpointer: MemorySaver,
  config: { configurable: { thread_id: string } },
  channel: string,
  namespace = "",
): Promise<unknown[]> {
  const copies: unknown[] = [];
  for await (const { checkpoint } of checkpointer.list({
    configurable: { ...config.configurable, checkpoint_ns: namespace },
  })) {
    const stored = checkpoint.channel_values[channel];
    if (stored === undefined) continue;
    copies.push(isDeltaSnapshot(stored) ? stored.value : stored);
  }
  return copies;
}

async function subagentNamespace(
  checkpointer: MemorySaver,
  config: { configurable: { thread_id: string } },
): Promise<string> {
  const namespaces = new Set<string>();
  for await (const tuple of checkpointer.list(config)) {
    namespaces.add(tuple.config.configurable?.checkpoint_ns ?? "");
  }
  namespaces.delete("");
  expect(namespaces.size).toBe(1);
  return [...namespaces][0];
}

/**
 * A main agent that hands one task to the `looper` subagent, which makes
 * `turns` scripted tool calls and answers "looped".
 */
function subagentModel(turns: (i: number) => ScriptedCall | undefined) {
  let subTurns = 0;
  return replyingModel((messages) => {
    if (messages.some((m) => m.text.includes("SUBAGENT_LOOPER"))) {
      const call = turns(subTurns);
      if (call === undefined) return new AIMessage("looped");
      return new AIMessage({
        content: "",
        tool_calls: [{ ...call, id: `sub_${subTurns++}` }],
      });
    }
    if (ToolMessage.isInstance(messages.at(-1))) return new AIMessage("done");
    return new AIMessage({
      content: "",
      tool_calls: [
        {
          name: "task",
          args: { description: "Loop.", subagent_type: "looper" },
          id: "call_task",
        },
      ],
    });
  });
}
const looper = {
  name: "looper",
  description: "Loops.",
  systemPrompt: "SUBAGENT_LOOPER",
  tools: [noop],
};

describe("Messages channel", () => {
  const toolLoopModel = (turns: number, callPrefix?: string) =>
    scriptedModel(noopTurns(turns), callPrefix);

  it("stores a full copy of the messages once every 50 updates", async () => {
    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: toolLoopModel(30),
      tools: [noop],
      checkpointer,
    });
    const config = thread("delta-snapshots");

    const result = await agent.invoke(
      { messages: [new HumanMessage("go")] },
      config,
    );

    expect(result.messages).toHaveLength(62);
    const copies = await storedCopies(checkpointer, config, "messages");
    expect(copies.map((copy) => (copy as unknown[]).length)).toEqual([50]);
  });

  it("returns the same messages from getState as MessagesValue, each with a stable id", async () => {
    const config = thread("parity");
    const deltaAgent = createDeepAgent({
      model: toolLoopModel(3),
      tools: [noop],
      checkpointer: new MemorySaver(),
    });
    const fullAgent = createDeepAgent({
      model: toolLoopModel(3),
      tools: [noop],
      checkpointer: new MemorySaver(),
      stateSchema: new StateSchema({ messages: MessagesValue }),
    });

    const input = { messages: [{ role: "user", content: "go" }] };

    const result = await deltaAgent.invoke(input, config);
    await fullAgent.invoke(input, config);
    const first: BaseMessage[] = (await deltaAgent.graph.getState(config))
      .values.messages;
    const second: BaseMessage[] = (await deltaAgent.graph.getState(config))
      .values.messages;
    const full: BaseMessage[] = (await fullAgent.graph.getState(config)).values
      .messages;

    expect(shape(first)).toEqual(shape(full));
    expect(ids(first)).not.toContain(undefined);
    expect(new Set(ids(first)).size).toBe(first.length);
    expect(ids(first)).toEqual(ids(result.messages));
    expect(ids(second)).toEqual(ids(first));
  });

  it("returns parallel tool results in call order after a reload", async () => {
    const config = thread("parallel-calls");
    const agent = createDeepAgent({
      model: scriptedModel([noopTurns(6)]),
      tools: [noop],
      checkpointer: new MemorySaver(),
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage("go")] },
      config,
    );
    const state: BaseMessage[] = (await agent.graph.getState(config)).values
      .messages;

    expect(
      result.messages.filter(ToolMessage.isInstance).map((m) => m.tool_call_id),
    ).toEqual(["call_0", "call_1", "call_2", "call_3", "call_4", "call_5"]);
    expect(shape(state)).toEqual(shape(result.messages));
    expect(ids(state)).toEqual(ids(result.messages));
  });

  it("reads and continues a thread written with MessagesValue", async () => {
    const checkpointer = new MemorySaver();
    const config = thread("upgrade");
    const before = createDeepAgent({
      model: toolLoopModel(5, "before"),
      tools: [noop],
      checkpointer,
      stateSchema: new StateSchema({ messages: MessagesValue }),
    });
    const written = await before.invoke(
      { messages: [new HumanMessage("first")] },
      config,
    );
    const after = createDeepAgent({
      model: toolLoopModel(2, "after"),
      tools: [noop],
      checkpointer,
    });

    const read: BaseMessage[] = (await after.graph.getState(config)).values
      .messages;
    const continued = await after.invoke(
      { messages: [new HumanMessage("again")] },
      config,
    );
    const reread: BaseMessage[] = (await after.graph.getState(config)).values
      .messages;

    expect(ids(read)).toEqual(ids(written.messages));
    expect(ids(continued.messages.slice(0, written.messages.length))).toEqual(
      ids(written.messages),
    );
    expect(continued.messages).toHaveLength(written.messages.length + 6);
    expect(continued.messages.at(-1)?.text).toBe("done");
    expect(ids(reread)).toEqual(ids(continued.messages));
  });

  it("leaves its threads readable by an agent using MessagesValue", async () => {
    const checkpointer = new MemorySaver();
    const config = thread("rollback");
    const current = createDeepAgent({
      model: toolLoopModel(30),
      tools: [noop],
      checkpointer,
    });
    const written = await current.invoke(
      { messages: [new HumanMessage("go")] },
      config,
    );
    const earlier = createDeepAgent({
      model: toolLoopModel(1, "earlier"),
      tools: [noop],
      checkpointer,
      stateSchema: new StateSchema({ messages: MessagesValue }),
    });

    const read: BaseMessage[] = (await earlier.graph.getState(config)).values
      .messages;
    const continued = await earlier.invoke(
      { messages: [new HumanMessage("again")] },
      config,
    );

    expect(ids(read)).toEqual(ids(written.messages));
    expect(ids(continued.messages.slice(0, written.messages.length))).toEqual(
      ids(written.messages),
    );
    expect(continued.messages.at(-1)?.text).toBe("done");
  });

  it("resumes a tool approval made after a full copy of the messages", async () => {
    const config = thread("approval-past-snapshot");
    const turns = [
      ...noopTurns(30),
      { name: "write_file", args: { file_path: "/out.md", content: "ok" } },
    ];
    const run = async (stateSchema?: AnyStateSchema) => {
      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        model: scriptedModel(turns),
        tools: [noop],
        checkpointer,
        interruptOn: { write_file: true },
        ...(stateSchema && { stateSchema }),
      });
      const stopped = await agent.invoke(
        { messages: [new HumanMessage("go")] },
        config,
      );
      const copies = await storedCopies(checkpointer, config, "messages");
      const result = await agent.invoke(approve, config);
      const state = (await agent.graph.getState(config)).values;
      return { stopped, copies, result, state };
    };

    const delta = await run();
    const full = await run(
      new StateSchema({ messages: MessagesValue, files: filesValue }),
    );

    expect(delta.stopped.__interrupt__).toHaveLength(1);
    expect(delta.copies).toHaveLength(1);
    expect(delta.result.messages.at(-1)?.text).toBe("done");
    expect(shape(delta.state.messages)).toEqual(shape(full.state.messages));
    expect(ids(delta.state.messages)).toEqual(ids(delta.result.messages));
    expect(contents(delta.state.files)).toEqual({ "/out.md": "ok" });
  });

  it("keeps summarization that removes messages working", async () => {
    const config = thread("summarized");
    const summarizer = () =>
      summarizationMiddleware({
        model: new FakeListChatModel({ responses: ["summary"] }),
        trigger: { messages: 6 },
        keep: { messages: 2 },
      });
    const deltaAgent = createDeepAgent({
      model: toolLoopModel(6),
      tools: [noop],
      middleware: [summarizer()],
      checkpointer: new MemorySaver(),
    });
    const fullAgent = createDeepAgent({
      model: toolLoopModel(6),
      tools: [noop],
      middleware: [summarizer()],
      checkpointer: new MemorySaver(),
      stateSchema: new StateSchema({ messages: MessagesValue }),
    });

    await deltaAgent.invoke({ messages: [new HumanMessage("go")] }, config);
    await fullAgent.invoke({ messages: [new HumanMessage("go")] }, config);
    const delta: BaseMessage[] = (await deltaAgent.graph.getState(config))
      .values.messages;
    const full: BaseMessage[] = (await fullAgent.graph.getState(config)).values
      .messages;

    expect(delta.length).toBeLessThan(14);
    expect(shape(delta)).toEqual(shape(full));
    expect(delta.at(-1)?.text).toBe("done");
  });

  it("replays summarization that removes messages across full copies", async () => {
    const config = thread("summarized-past-snapshots");
    const run = async (stateSchema?: AnyStateSchema) => {
      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        model: toolLoopModel(60),
        tools: [noop],
        middleware: [
          summarizationMiddleware({
            model: new FakeListChatModel({ responses: ["summary"] }),
            trigger: { messages: 30 },
            keep: { messages: 4 },
          }),
        ],
        checkpointer,
        ...(stateSchema && { stateSchema }),
      });
      const result = await agent.invoke(
        { messages: [new HumanMessage("go")] },
        config,
      );
      const copies = await storedCopies(checkpointer, config, "messages");
      const state: BaseMessage[] = (await agent.graph.getState(config)).values
        .messages;
      return { result, copies, state };
    };

    const delta = await run();
    const full = await run(new StateSchema({ messages: MessagesValue }));

    expect(delta.copies.length).toBeGreaterThan(1);
    expect(delta.state.length).toBeLessThan(40);
    expect(shape(delta.state)).toEqual(shape(full.state));
    expect(ids(delta.state)).toEqual(ids(delta.result.messages));
  });

  it("keeps messages as deltas when a stateSchema leaves them out", async () => {
    const checkpointer = new MemorySaver();
    const config = thread("custom-schema");
    const agent = createDeepAgent({
      model: toolLoopModel(30),
      tools: [noop],
      checkpointer,
      stateSchema: new StateSchema({ author: z.string().default("me") }),
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage("go")] },
      config,
    );

    expect(result.author).toBe("me");
    const copies = await storedCopies(checkpointer, config, "messages");
    expect(copies.map((copy) => (copy as unknown[]).length)).toEqual([50]);
  });

  it("keeps messages as deltas, and the schema's reducers, for a zod stateSchema", async () => {
    const checkpointer = new MemorySaver();
    const config = thread("zod-schema");
    const agent = createDeepAgent({
      model: toolLoopModel(30),
      tools: [noop],
      checkpointer,
      stateSchema: z.object({
        author: z.string().default("me"),
        tally: z.number().register(registry, {
          reducer: { fn: (total: number, add: number) => total + add },
          default: () => 0,
        }),
      }),
    });

    const first = await agent.invoke(
      { messages: [new HumanMessage("go")], tally: 2 },
      config,
    );
    const copies = await storedCopies(checkpointer, config, "messages");
    const second = await agent.invoke(
      { messages: [new HumanMessage("again")], tally: 3 },
      config,
    );

    expect(first.author).toBe("me");
    expect(copies.map((copy) => (copy as unknown[]).length)).toEqual([50]);
    expect(second.tally).toBe(5);
  });

  it("reads a stateSchema as createAgent does, apart from messages", async () => {
    const zodSchema = z.object({
      author: z.string().default("me"),
      _note: z.string().default("private"),
      tally: z.number().register(registry, {
        reducer: { fn: (total: number, add: number) => total + add },
        default: () => 0,
      }),
      letters: z.number().register(registry, {
        reducer: {
          schema: z.string(),
          fn: (total: number, word: string) => total + word.length,
        },
        default: () => 0,
      }),
    });
    const stateSchema = new StateSchema({
      author: z.string().default("me"),
      tally: new ReducedValue(z.number().default(0), {
        reducer: (total: number, add: number) => total + add,
      }),
      letters: new ReducedValue(z.number().default(0), {
        inputSchema: z.string(),
        reducer: (total: number, word: string) => total + word.length,
      }),
    });
    const zod3Schema = z3.object({
      author: z3.string().default("me"),
      tally: z3.number().optional(),
    });
    // The caller's messages channel replaces the built-in one in createAgent.
    const ownMessages = z.object({
      messages: z.array(z.any()).default(() => []),
      tally: z.number().optional(),
    });
    const ignored = [
      null,
      z.string(),
      Annotation.Root({ author: Annotation<string> }),
    ];
    const run = async (stateSchema: unknown) => {
      const agent = createAgent({
        model: replyingModel(
          (messages) =>
            new AIMessage({ content: "done", id: `done-${messages.length}` }),
        ),
        checkpointer: new MemorySaver(),
        stateSchema: stateSchema as AnyStateSchema,
      });
      const states = [];
      for (const [tally, letters] of [
        [2, "abc"],
        [3, "de"],
      ]) {
        await agent.invoke(
          {
            messages: [new HumanMessage({ content: "go", id: `go-${tally}` })],
            tally,
            letters,
          } as never,
          thread("parity"),
        );
        // getState, unlike invoke's output, includes private channels.
        const { messages, ...rest } = (
          await agent.graph.getState(thread("parity"))
        ).values as Record<string, unknown> & { messages: BaseMessage[] };
        states.push({ messages: ids(messages), ...rest });
      }
      return states;
    };

    for (const input of [
      zodSchema,
      stateSchema,
      zod3Schema,
      ownMessages,
      ...ignored,
    ]) {
      expect(await run(deepAgentStateSchema(input as never))).toEqual(
        await run(input),
      );
    }
    expect((await run(zodSchema)).at(-1)).toMatchObject({
      author: "me",
      _note: "private",
      tally: 5,
    });
    expect((await run(ownMessages)).at(-1)?.messages).toHaveLength(1);
  });

  it("keeps a subagent's messages as deltas", async () => {
    const checkpointer = new MemorySaver();
    const config = thread("subagent-messages");
    const agent = createDeepAgent({
      model: subagentModel((i) =>
        i < 30 ? { name: "noop", args: { i } } : undefined,
      ),
      checkpointer,
      subagents: [looper],
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage("go")] },
      config,
    );

    expect(result.messages.at(-1)?.text).toBe("done");
    const namespace = await subagentNamespace(checkpointer, config);
    const copies = await storedCopies(
      checkpointer,
      config,
      "messages",
      namespace,
    );
    expect(copies.map((copy) => (copy as unknown[]).length)).toEqual([50]);
  });
});
