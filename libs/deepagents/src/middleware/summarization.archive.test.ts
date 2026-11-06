import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ContextOverflowError } from "@langchain/core/errors";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver, type StateSnapshot } from "@langchain/langgraph";
import { createDeepAgent } from "../agent.js";
import { FilesystemBackend } from "../backends/filesystem.js";
import { createSummarizationMiddleware } from "./summarization.js";

class ArchiveModel extends BaseChatModel {
  constructor() {
    super({});
  }

  _llmType() {
    return "archive-lifecycle-test";
  }

  bindTools() {
    return this;
  }

  async _generate(_messages: BaseMessage[]) {
    const message = new AIMessage("done");
    return { generations: [{ text: message.text, message }] };
  }
}

class OverflowOnceModel extends ArchiveModel {
  actorCalls = 0;

  async _generate(messages: BaseMessage[]) {
    if (
      messages.some(
        (message) =>
          SystemMessage.isInstance(message) &&
          message.text.includes("archive-lifecycle-actor"),
      )
    ) {
      this.actorCalls += 1;
      if (this.actorCalls === 1) {
        throw new ContextOverflowError("prompt is too long");
      }
    }
    return super._generate(messages);
  }
}

function makeAgent(
  backend: FilesystemBackend,
  checkpointer = new MemorySaver(),
  model = new ArchiveModel(),
) {
  return createDeepAgent({
    model,
    systemPrompt: "archive-lifecycle-actor",
    backend,
    checkpointer,
    middleware: [
      createSummarizationMiddleware({
        model: new ArchiveModel(),
        backend,
        trigger: { type: "messages", value: 4 },
        keep: { type: "messages", value: 2 },
      }),
    ],
  });
}

function history(marker: string) {
  return [
    new HumanMessage(marker),
    new AIMessage("recorded"),
    new HumanMessage("Keep the preceding evidence."),
    new AIMessage("ready"),
    new HumanMessage("Continue later."),
    new AIMessage("waiting"),
  ];
}

describe("summarization archive identity", () => {
  let root: string;
  let backend: FilesystemBackend;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "deepagents-archive-lifecycle-"));
    backend = new FilesystemBackend({ rootDir: root, virtualMode: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function archive(agent: ReturnType<typeof makeAgent>, thread: string) {
    const snapshot: StateSnapshot = await agent.getState({
      configurable: { thread_id: thread },
    });
    const state = snapshot.values;
    const filePath = state._summarizationEvent?.filePath;
    expect(filePath).toBeDefined();
    expect(filePath).toBe(
      `/conversation_history/${state._summarizationSessionId}.md`,
    );
    const text = await readFile(path.join(root, filePath!), "utf8");
    return { id: state._summarizationSessionId, filePath, text };
  }

  it("keeps independent checkpoint threads in separate archive files", async () => {
    const agent = makeAgent(backend);
    await agent.invoke(
      { messages: history("A_ONLY_FACT") },
      { configurable: { thread_id: "A" } },
    );
    await agent.invoke(
      { messages: history("B_ONLY_FACT") },
      { configurable: { thread_id: "B" } },
    );
    const a = await archive(agent, "A");
    const b = await archive(agent, "B");
    expect(a.id).not.toBe(b.id);
    expect(a.text).toContain("A_ONLY_FACT");
    expect(a.text).not.toContain("B_ONLY_FACT");
    expect(b.text).toContain("B_ONLY_FACT");
    expect(b.text).not.toContain("A_ONLY_FACT");
    expect(await readdir(path.join(root, "conversation_history"))).toHaveLength(
      2,
    );
  });

  it("appends repeated compactions within one thread to the same archive", async () => {
    const agent = makeAgent(backend);
    const config = { configurable: { thread_id: "same-thread" } };
    await agent.invoke({ messages: history("FIRST_FACT") }, config);
    const first = await archive(agent, "same-thread");
    await agent.invoke({ messages: history("LATER_FACT") }, config);
    const later = await archive(agent, "same-thread");
    expect(later.id).toBe(first.id);
    expect(later.filePath).toBe(first.filePath);
    expect(later.text).toContain("FIRST_FACT");
    expect(later.text).toContain("LATER_FACT");
    expect(later.text.length).toBeGreaterThan(first.text.length);
    expect(await readdir(path.join(root, "conversation_history"))).toHaveLength(
      1,
    );
  });

  it("reuses a checkpoint's archive after rebuilding the agent", async () => {
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: "restored-thread" } };
    const firstAgent = makeAgent(backend, checkpointer);
    await firstAgent.invoke({ messages: history("BEFORE_REBUILD") }, config);
    const first = await archive(firstAgent, "restored-thread");
    const rebuilt = makeAgent(backend, checkpointer);
    await rebuilt.invoke({ messages: history("AFTER_REBUILD") }, config);
    const later = await archive(rebuilt, "restored-thread");
    expect(later.id).toBe(first.id);
    expect(later.filePath).toBe(first.filePath);
    expect(later.text).toContain("BEFORE_REBUILD");
    expect(later.text).toContain("AFTER_REBUILD");
    expect(await readdir(path.join(root, "conversation_history"))).toHaveLength(
      1,
    );
  });

  it("preserves a legacy checkpoint ID and appends to its existing archive", async () => {
    const legacyId = "session_0123abcd";
    const legacyPath = `/conversation_history/${legacyId}.md`;
    const write = await backend.write(legacyPath, "LEGACY_FACT\n\n");
    expect(write.error).toBeUndefined();
    const agent = makeAgent(backend);
    const config = { configurable: { thread_id: "legacy-thread" } };
    await agent.invoke(
      { messages: [new HumanMessage("Start thread.")] },
      config,
    );
    await agent.updateState(config, { _summarizationSessionId: legacyId });
    const checkpoint: StateSnapshot = await agent.getState(config);
    expect(checkpoint.values._summarizationSessionId).toBe(legacyId);
    await agent.invoke({ messages: history("NEW_FACT") }, config);
    const result = await archive(agent, "legacy-thread");
    expect(result.id).toBe(legacyId);
    expect(result.filePath).toBe(legacyPath);
    expect(result.text).toContain("LEGACY_FACT");
    expect(result.text).toContain("NEW_FACT");
    expect(await readdir(path.join(root, "conversation_history"))).toHaveLength(
      1,
    );
  });

  it("keeps concurrently invoked fresh threads in separate archives", async () => {
    const agent = makeAgent(backend);
    await Promise.all([
      agent.invoke(
        { messages: history("CONCURRENT_A") },
        { configurable: { thread_id: "A" } },
      ),
      agent.invoke(
        { messages: history("CONCURRENT_B") },
        { configurable: { thread_id: "B" } },
      ),
    ]);
    const a = await archive(agent, "A");
    const b = await archive(agent, "B");
    expect(a.id).not.toBe(b.id);
    expect(a.text).toContain("CONCURRENT_A");
    expect(a.text).not.toContain("CONCURRENT_B");
    expect(b.text).toContain("CONCURRENT_B");
    expect(b.text).not.toContain("CONCURRENT_A");
    expect(await readdir(path.join(root, "conversation_history"))).toHaveLength(
      2,
    );
  });

  it("keeps one archive identity when overflow requires another summary attempt", async () => {
    const model = new OverflowOnceModel();
    const agent = makeAgent(backend, new MemorySaver(), model);
    await agent.invoke(
      { messages: history("OVERFLOW_FACT") },
      { configurable: { thread_id: "overflow-thread" } },
    );
    const result = await archive(agent, "overflow-thread");
    expect(model.actorCalls).toBe(2);
    expect(result.text).toContain("OVERFLOW_FACT");
    expect(await readdir(path.join(root, "conversation_history"))).toHaveLength(
      1,
    );
  });
});
