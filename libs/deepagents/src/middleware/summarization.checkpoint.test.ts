import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createDeepAgent } from "../agent.js";
import { createSummarizationMiddleware } from "./summarization.js";
import { createMockBackend } from "./test.js";

describe("summarization checkpoint resume", () => {
  it("rehydrates a nested summary message from a SQLite checkpoint after restart", async () => {
    const databasePath = join(
      tmpdir(),
      `deepagents-summarization-${crypto.randomUUID()}.sqlite`,
    );
    const config = {
      configurable: {
        thread_id: `summarization-resume-${crypto.randomUUID()}`,
      },
      recursionLimit: 50,
    };

    const createAgent = (checkpointer: SqliteSaver) =>
      createDeepAgent({
        model: new FakeListChatModel({
          responses: ["first response", "second response", "resumed response"],
        }),
        checkpointer,
        middleware: [
          createSummarizationMiddleware({
            model: new FakeListChatModel({
              responses: ["conversation summary", "updated summary"],
            }),
            backend: createMockBackend(),
            trigger: { type: "messages", value: 3 },
            keep: { type: "messages", value: 1 },
          }),
        ],
      });

    let originalCheckpointer: SqliteSaver | undefined;
    let resumedCheckpointer: SqliteSaver | undefined;
    try {
      originalCheckpointer = SqliteSaver.fromConnString(databasePath);
      const originalAgent = createAgent(originalCheckpointer);
      await originalAgent.invoke(
        { messages: [new HumanMessage("first user request")] },
        config,
      );
      await originalAgent.invoke(
        { messages: [new HumanMessage("second user request")] },
        config,
      );

      const stateBeforeRestart: any = await originalAgent.getState(config);
      const eventBeforeRestart = (
        stateBeforeRestart.values as Record<string, unknown>
      )._summarizationEvent as { summaryMessage: unknown };
      expect(HumanMessage.isInstance(eventBeforeRestart.summaryMessage)).toBe(
        true,
      );

      // Close the original SQLite connection. The next saver must deserialize
      // persisted data rather than reusing in-memory checkpoint state.
      originalCheckpointer.db.close();
      originalCheckpointer = undefined;

      resumedCheckpointer = SqliteSaver.fromConnString(databasePath);
      const resumedAgent = createAgent(resumedCheckpointer);
      const restoredState: any = await resumedAgent.getState(config);
      const restoredEvent = (restoredState.values as Record<string, unknown>)
        ._summarizationEvent as { summaryMessage: unknown };

      expect(HumanMessage.isInstance(restoredEvent.summaryMessage)).toBe(true);

      await expect(
        resumedAgent.invoke(
          { messages: [new HumanMessage("third user request after restart")] },
          config,
        ),
      ).resolves.toBeDefined();
    } finally {
      originalCheckpointer?.db.close();
      resumedCheckpointer?.db.close();
      await Promise.all(
        [databasePath, `${databasePath}-shm`, `${databasePath}-wal`].map(
          async (path) => unlink(path).catch(() => undefined),
        ),
      );
    }
  });
});
