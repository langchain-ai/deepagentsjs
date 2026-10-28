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
import { deepAgentStateSchema } from "./values.js";

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
  const go = { messages: [new HumanMessage("go")] };
  const copyLengths = async (
    checkpointer: MemorySaver,
    config: { configurable: { thread_id: string } },
    namespace?: string,
  ) =>
    (await storedCopies(checkpointer, config, "messages", namespace)).map(
      (copy) => (copy as unknown[]).length,
    );
  const fullMessages = new StateSchema({ messages: MessagesValue });

  it("stores a full copy of the messages once every 50 updates", async () => {
    const checkpointer = new MemorySaver();
    const config = thread("delta-snapshots");
    const agent = createDeepAgent({
      model: toolLoopModel(30),
      tools: [noop],
      checkpointer,
    });

    const result = await agent.invoke(go, config);

    expect(result.messages).toHaveLength(62);
    expect(await copyLengths(checkpointer, config)).toEqual([50]);
  });

  it("reloads the same messages as MessagesValue, with stable ids and parallel tool results in call order", async () => {
    const config = thread("parity");
    const turns = [noopTurns(3), ...noopTurns(2, 3)];
    const run = async (stateSchema?: AnyStateSchema) => {
      const agent = createDeepAgent({
        model: scriptedModel(turns),
        tools: [noop],
        checkpointer: new MemorySaver(),
        ...(stateSchema && { stateSchema }),
      });
      const result = await agent.invoke(
        { messages: [{ role: "user", content: "go" }] },
        config,
      );
      const read = async (): Promise<BaseMessage[]> =>
        (await agent.graph.getState(config)).values.messages;
      return { result, first: await read(), second: await read() };
    };

    const delta = await run();
    const full = await run(fullMessages);

    expect(
      delta.result.messages
        .filter(ToolMessage.isInstance)
        .map((m) => m.tool_call_id),
    ).toEqual(["call_0", "call_1", "call_2", "call_3", "call_4"]);
    expect(shape(delta.first)).toEqual(shape(full.first));
    expect(ids(delta.first)).not.toContain(undefined);
    expect(new Set(ids(delta.first)).size).toBe(delta.first.length);
    expect(ids(delta.first)).toEqual(ids(delta.result.messages));
    expect(ids(delta.second)).toEqual(ids(delta.first));
  });

  it("continues a MessagesValue thread, and leaves it readable by MessagesValue afterwards", async () => {
    const checkpointer = new MemorySaver();
    const config = thread("upgrade-and-rollback");
    const fullAgent = (callPrefix: string, turns: number) =>
      createDeepAgent({
        model: toolLoopModel(turns, callPrefix),
        tools: [noop],
        checkpointer,
        stateSchema: fullMessages,
      });
    const deltaAgent = createDeepAgent({
      model: toolLoopModel(30, "delta"),
      tools: [noop],
      checkpointer,
    });
    const readIds = async (
      state: Promise<{ values: { messages: BaseMessage[] } }>,
    ) => ids((await state).values.messages);
    const startsWith = (longer: BaseMessage[], shorter: BaseMessage[]) =>
      expect(ids(longer.slice(0, shorter.length))).toEqual(ids(shorter));

    const before = fullAgent("before", 5);
    const written = await before.invoke(
      { messages: [new HumanMessage("first")] },
      config,
    );
    expect(await readIds(deltaAgent.graph.getState(config))).toEqual(
      ids(written.messages),
    );

    const upgraded = await deltaAgent.invoke(
      { messages: [new HumanMessage("again")] },
      config,
    );
    startsWith(upgraded.messages, written.messages);
    expect(upgraded.messages.at(-1)?.text).toBe("done");
    expect(await readIds(deltaAgent.graph.getState(config))).toEqual(
      ids(upgraded.messages),
    );

    const after = fullAgent("after", 1);
    expect(await readIds(after.graph.getState(config))).toEqual(
      ids(upgraded.messages),
    );
    const rolledBack = await after.invoke(
      { messages: [new HumanMessage("once more")] },
      config,
    );
    startsWith(rolledBack.messages, upgraded.messages);
    expect(rolledBack.messages.at(-1)?.text).toBe("done");
  });

  it("resumes a tool approval made after a full copy of the messages", async () => {
    const checkpointer = new MemorySaver();
    const config = thread("approval-past-snapshot");
    const agent = createDeepAgent({
      model: scriptedModel([
        ...noopTurns(30),
        { name: "write_file", args: { file_path: "/out.md", content: "ok" } },
      ]),
      tools: [noop],
      checkpointer,
      interruptOn: { write_file: true },
    });

    const stopped = await agent.invoke(go, config);
    expect(stopped.__interrupt__).toHaveLength(1);
    expect(await copyLengths(checkpointer, config)).toHaveLength(1);

    const result = await agent.invoke(approve, config);
    const state = (await agent.graph.getState(config)).values;
    expect(result.messages.at(-1)?.text).toBe("done");
    expect(ids(state.messages)).toEqual(ids(result.messages));
    expect(contents(state.files)).toEqual({ "/out.md": "ok" });
  });

  it("replays summarization that removes messages across full copies as MessagesValue does", async () => {
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
      const result = await agent.invoke(go, config);
      const copies = await copyLengths(checkpointer, config);
      const state: BaseMessage[] = (await agent.graph.getState(config)).values
        .messages;
      return { result, copies, state };
    };

    const delta = await run();
    const full = await run(fullMessages);

    expect(delta.copies.length).toBeGreaterThan(1);
    expect(delta.state.length).toBeLessThan(40);
    expect(shape(delta.state)).toEqual(shape(full.state));
    expect(ids(delta.state)).toEqual(ids(delta.result.messages));
  });

  it("keeps messages as deltas when a StateSchema or zod stateSchema leaves them out", async () => {
    const schemas: AnyStateSchema[] = [
      new StateSchema({ author: z.string().default("me") }),
      z.object({ author: z.string().default("me") }) as never,
    ];
    for (const stateSchema of schemas) {
      const checkpointer = new MemorySaver();
      const config = thread("custom-schema");
      const agent = createDeepAgent({
        model: toolLoopModel(30),
        tools: [noop],
        checkpointer,
        stateSchema,
      });

      const result = (await agent.invoke(go, config)) as { author?: string };

      expect(result.author).toBe("me");
      expect(await copyLengths(checkpointer, config)).toEqual([50]);
    }
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

    const result = await agent.invoke(go, config);

    expect(result.messages.at(-1)?.text).toBe("done");
    const namespace = await subagentNamespace(checkpointer, config);
    expect(await copyLengths(checkpointer, config, namespace)).toEqual([50]);
  });
});
