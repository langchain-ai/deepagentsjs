// Records two deep agent threads stopped at a tool approval, as an earlier
// release saves them: one at the main agent's approval, one at a subagent's
// approval inside the `task` tool (its tool task still holds the whole state).
//
// Run against a build of deepagents 1.16.0 on langchain 1.5.10:
//   node record-trunk-approval-threads.mjs <checkout>/libs/deepagents <out.json>
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const [JSD, OUT] = process.argv.slice(2);
const nm = (p) => import(pathToFileURL(`${JSD}/node_modules/${p}`).href);
const { BaseChatModel } = await nm(
  "@langchain/core/dist/language_models/chat_models.js",
);
const { AIMessage, HumanMessage } = await nm(
  "@langchain/core/dist/messages/index.js",
);
const { MemorySaver } = await nm(
  "@langchain/langgraph-checkpoint/dist/index.js",
);
const { JsonPlusSerializer } = await nm(
  "@langchain/langgraph-checkpoint/dist/serde/jsonplus.js",
);
const { createDeepAgent } = await import(
  pathToFileURL(`${JSD}/dist/index.js`).href
);

const call = (name, args, id) =>
  new AIMessage({
    content: "",
    tool_calls: [{ name, args, id, type: "tool_call" }],
  });
class ScriptedModel extends BaseChatModel {
  _llmType() {
    return "scripted";
  }
  bindTools() {
    return this;
  }
  async _generate(messages) {
    const text = messages
      .map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
      .join("\n");
    const message = text.includes("SUBAGENT_WRITER")
      ? call(
          "write_file",
          { file_path: "/summary.md", content: "summary v1" },
          "call_write",
        )
      : text.includes("Edit the notes")
        ? call(
            "edit_file",
            { file_path: "/notes.md", old_string: "v0", new_string: "v1" },
            "call_edit",
          )
        : call(
            "task",
            { description: "Write the summary.", subagent_type: "writer" },
            "call_task",
          );
    return { generations: [{ text: "", message }] };
  }
}

const now = "2026-10-28T00:00:00.000Z";
const notes = {
  "/notes.md": {
    content: "v0",
    mimeType: "text/plain",
    created_at: now,
    modified_at: now,
  },
};
const serde = new JsonPlusSerializer();
const threads = {};

async function record(threadId, params, prompt) {
  const checkpointer = new MemorySaver();
  const agent = createDeepAgent({
    model: new ScriptedModel({}),
    checkpointer,
    ...params,
  });
  const config = { configurable: { thread_id: threadId } };
  const result = await agent.invoke(
    { messages: [new HumanMessage(prompt)], files: notes },
    config,
  );
  if (!result.__interrupt__?.length)
    throw new Error(`${threadId} did not stop at an approval`);
  const tuples = [];
  for await (const tuple of checkpointer.list(config)) tuples.push(tuple);
  const [, bytes] = await serde.dumpsTyped(tuples.reverse());
  threads[threadId] = JSON.parse(new TextDecoder().decode(bytes));
}

await record(
  "main-approval",
  { interruptOn: { edit_file: true } },
  "Edit the notes",
);
await record(
  "subagent-approval",
  {
    subagents: [
      {
        name: "writer",
        description: "Writes summaries.",
        systemPrompt: "SUBAGENT_WRITER: write the summary to /summary.md.",
        interruptOn: { write_file: true },
      },
    ],
  },
  "Summarize the notes",
);
fs.writeFileSync(OUT, `${JSON.stringify(threads, null, 2)}\n`);
for (const [id, tuples] of Object.entries(threads))
  console.log(id, tuples.length, "checkpoints", [
    ...new Set(tuples.map((t) => t.config.configurable.checkpoint_ns)),
  ]);
