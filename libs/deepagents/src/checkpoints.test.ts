import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Command, MemorySaver } from "@langchain/langgraph";
import type {
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { createDeepAgent } from "./agent.js";
import type { FileData } from "./backends/protocol.js";
import { createFileData } from "./backends/utils.js";

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
const seed = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([path, text]) => [path, createFileData(text)]),
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

describe("Checkpointed tool calls", () => {
  async function toolSendPayloads(
    checkpointer: MemorySaver,
    config: { configurable: { thread_id: string } },
  ): Promise<unknown[]> {
    const payloads: unknown[] = [];
    for await (const { checkpoint, pendingWrites } of checkpointer.list(
      config,
    )) {
      const queued = (checkpoint.channel_values.__pregel_tasks ?? []) as {
        node: string;
        args: unknown;
      }[];
      const written = (pendingWrites ?? [])
        .filter(([, channel]) => channel === "__pregel_tasks")
        .map(([, , value]) => value as { node: string; args: unknown });
      for (const task of [...queued, ...written]) {
        if (task.node === "tools") payloads.push(task.args);
      }
    }
    return payloads;
  }

  /**
   * Threads recorded with deepagents 1.16.0 on langchain 1.5.10, each stopped
   * at a tool approval (`testing/fixtures/record-trunk-approval-threads.mjs`).
   */
  async function savedThread(name: string): Promise<MemorySaver> {
    const checkpointer = new MemorySaver();
    const saved = JSON.parse(
      fs.readFileSync(
        new URL(
          "./testing/fixtures/trunk-approval-threads.json",
          import.meta.url,
        ),
        "utf8",
      ),
    )[name];
    const tuples: CheckpointTuple[] = await checkpointer.serde.loadsTyped(
      "json",
      JSON.stringify(saved),
    );
    for (const tuple of tuples) {
      const { thread_id, checkpoint_ns } = tuple.config.configurable ?? {};
      await checkpointer.put(
        tuple.parentConfig ?? { configurable: { thread_id, checkpoint_ns } },
        tuple.checkpoint,
        tuple.metadata!,
      );
      const byTask = new Map<string, PendingWrite[]>();
      for (const [taskId, channel, value] of tuple.pendingWrites ?? []) {
        byTask.set(taskId, [...(byTask.get(taskId) ?? []), [channel, value]]);
      }
      for (const [taskId, writes] of byTask) {
        await checkpointer.putWrites(tuple.config, writes, taskId);
      }
    }
    return checkpointer;
  }

  it("stores only the tool call for each tool task, and tools still read state files", async () => {
    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({
      model: scriptedModel(
        [{ name: "read_file", args: { file_path: "/notes.md" } }],
        "read",
      ),
      checkpointer,
    });
    const config = thread("compact-tool-send");

    const result = await agent.invoke(
      {
        messages: [new HumanMessage("Read the notes")],
        files: seed({ "/notes.md": "seeded in state" }),
      },
      config,
    );

    expect(result.messages.find(ToolMessage.isInstance)?.text).toContain(
      "seeded in state",
    );
    expect(result.messages.at(-1)?.text).toBe("done");
    const payloads = await toolSendPayloads(checkpointer, config);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).toEqual({
        lg_tool_call: expect.objectContaining({
          id: "read_0",
          name: "read_file",
        }),
      });
    }
  });

  it("resumes an approval that an earlier release saved", async () => {
    const config = thread("main-approval");
    const agent = createDeepAgent({
      model: replyingModel(() => new AIMessage("done")),
      checkpointer: await savedThread("main-approval"),
      interruptOn: { edit_file: true },
    });

    const result = await agent.invoke(approve, config);
    const state = (await agent.graph.getState(config)).values;

    expect(result.messages.map((m) => m.type)).toEqual([
      "human",
      "ai",
      "tool",
      "ai",
    ]);
    expect(result.messages.at(-1)?.text).toBe("done");
    expect(contents(result.files)).toEqual({ "/notes.md": "v1" });
    expect(ids(state.messages)).toEqual(ids(result.messages));
    expect(contents(state.files)).toEqual({ "/notes.md": "v1" });
  });

  it("resumes a subagent approval whose saved tool task carries the whole state", async () => {
    const config = thread("subagent-approval");
    const agent = createDeepAgent({
      model: replyingModel(
        (messages) =>
          new AIMessage(
            messages.some((m) => m.text.includes("SUBAGENT_WRITER"))
              ? "written"
              : "done",
          ),
      ),
      checkpointer: await savedThread("subagent-approval"),
      subagents: [
        {
          name: "writer",
          description: "Writes summaries.",
          systemPrompt: "SUBAGENT_WRITER: write the summary to /summary.md.",
          interruptOn: { write_file: true },
        },
      ],
    });

    const result = await agent.invoke(approve, config);
    const state = (await agent.graph.getState(config)).values;

    const toolMessage = result.messages.find(ToolMessage.isInstance);
    expect(toolMessage?.tool_call_id).toBe("call_task");
    expect(toolMessage?.text).toBe("written");
    expect(result.messages.at(-1)?.text).toBe("done");
    expect(contents(result.files)).toEqual({
      "/notes.md": "v0",
      "/summary.md": "summary v1",
    });
    expect(ids(state.messages)).toEqual(ids(result.messages));
    expect(contents(state.files)).toEqual(contents(result.files));
  });
});
