import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import {
  getDefaultRunner,
  getFinalText,
  parseTrajectory,
} from "@deepagents/evals";

const runner = getDefaultRunner();

const MEMORY_PATH = "/project/AGENTS.md";
const MEMORY_SEED = "# Project Memory\n\nUser preferences and project facts.\n";

function resolveModelFromEvalRunner(): string {
  const name = process.env.EVAL_RUNNER;
  if (name === "sonnet-4-5" || name === "sonnet-4-5-thinking") {
    return "claude-sonnet-4-5-20250929";
  }
  if (name === "sonnet-4-6") {
    return "claude-sonnet-4-6";
  }
  if (name === "opus-4-6") {
    return "claude-opus-4-6";
  }
  if (name === "gpt-4.1") {
    return "gpt-4.1";
  }
  if (name === "gpt-4.1-mini") {
    return "gpt-4.1-mini";
  }
  if (name === "o3-mini") {
    return "o3-mini";
  }
  return "claude-sonnet-4-6";
}

async function invoke(
  agent: ReturnType<typeof createDeepAgent>,
  threadId: string,
  query: string,
  initialFiles?: Record<string, string>,
) {
  const now = new Date().toISOString();
  const fileData: Record<
    string,
    { content: string[]; created_at: string; modified_at: string }
  > = {};
  for (const [path, content] of Object.entries(initialFiles ?? {})) {
    fileData[path] = {
      content: content.split("\n"),
      created_at: now,
      modified_at: now,
    };
  }

  const result = await agent.invoke(
    {
      messages: [{ role: "user", content: query }],
      ...(Object.keys(fileData).length > 0 ? { files: fileData } : {}),
    },
    { configurable: { thread_id: threadId } },
  );

  return parseTrajectory(
    result.messages as unknown[],
    result.files as Record<string, unknown>,
  );
}

ls.describe(
  runner.name,
  () => {
    ls.test(
      "implicit preference remembered",
      {
        inputs: {
          query: "implicit_language_preference",
        },
      },
      async () => {
        const agent = createDeepAgent({
          model: resolveModelFromEvalRunner(),
          memory: [MEMORY_PATH],
          checkpointer: new MemorySaver(),
        });

        const threadId = crypto.randomUUID();

        await invoke(agent, threadId, "How can I create a list?", {
          [MEMORY_PATH]: MEMORY_SEED,
        });
        await invoke(
          agent,
          threadId,
          "In Python, you define a list like this: nums = [1, 2, 3]",
        );
        await invoke(
          agent,
          threadId,
          "Sorry I only know how to write C++, can you show me in C++ instead?",
        );
        const finalRun = await invoke(
          agent,
          threadId,
          "What language should you use for examples for me?",
        );

        expect(getFinalText(finalRun).toLowerCase()).toContain("c++");

        const memoryText = finalRun.files[MEMORY_PATH] ?? "";
        expect(memoryText.toLowerCase()).toContain("c++");
      },
    );

    ls.test(
      "explicit preference remembered",
      {
        inputs: {
          query: "explicit_no_emojis",
        },
      },
      async () => {
        const agent = createDeepAgent({
          model: resolveModelFromEvalRunner(),
          memory: [MEMORY_PATH],
          checkpointer: new MemorySaver(),
        });

        const threadId = crypto.randomUUID();

        await invoke(
          agent,
          threadId,
          "Write me a short congratulations message for a teammate.",
          {
            [MEMORY_PATH]: MEMORY_SEED,
          },
        );
        await invoke(
          agent,
          threadId,
          "No emojis please. Remember: never use emojis in anything you write for me.",
        );
        const finalRun = await invoke(
          agent,
          threadId,
          "Write another short congratulations message.",
        );

        const answer = getFinalText(finalRun);
        expect(answer).not.toContain("🎉");
        expect(answer).not.toContain("🚀");

        const memoryText = (finalRun.files[MEMORY_PATH] ?? "").toLowerCase();
        expect(memoryText).toContain("emoji");
      },
    );

    ls.test(
      "transient info not persisted",
      {
        inputs: {
          query: "transient_mood",
        },
      },
      async () => {
        const agent = createDeepAgent({
          model: resolveModelFromEvalRunner(),
          memory: [MEMORY_PATH],
          checkpointer: new MemorySaver(),
        });

        const threadId = crypto.randomUUID();

        await invoke(
          agent,
          threadId,
          "I'm exhausted today, barely slept last night.",
          {
            [MEMORY_PATH]: MEMORY_SEED,
          },
        );
        const editRun = await invoke(
          agent,
          threadId,
          "Help me rename processData to process_data in the codebase.",
        );
        const finalRun = await invoke(
          agent,
          threadId,
          "What durable preferences do you remember about me?",
        );

        expect(getFinalText(editRun).toLowerCase()).toContain("process_data");
        const memoryText = (finalRun.files[MEMORY_PATH] ?? "").toLowerCase();
        expect(memoryText).not.toContain("exhausted");
        expect(memoryText).not.toContain("slept last night");
      },
    );
  },
  { projectName: "deepagents-js-memory-multiturn", upsert: true },
);
