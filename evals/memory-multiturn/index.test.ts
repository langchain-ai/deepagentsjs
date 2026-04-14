import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner, getFinalText } from "@deepagents/evals";

const runner = getDefaultRunner();

const MEMORY_PATH = "/project/AGENTS.md";
const MEMORY_SEED = "# Project Memory\n\nUser preferences and project facts.\n";

ls.describe(
  "deepagents-js-memory-multiturn",
  () => {
    ls.test(
      "implicit preference remembered",
      {
        inputs: {
          query:
            "Conversation transcript:\n" +
            "User: How can I create a list?\n" +
            "Assistant: In Python, you define a list like this: nums = [1, 2, 3]\n" +
            "User: Sorry I only know how to write C++, can you show me in C++ instead?\n\n" +
            "Now answer: What language should you use for examples for me?",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({
            memory: [MEMORY_PATH],
          })
          .run({
            query: inputs.query,
            initialFiles: {
              [MEMORY_PATH]: MEMORY_SEED,
            },
          });

        expect(getFinalText(result).toLowerCase()).toContain("c++");

        const memoryText = result.files[MEMORY_PATH] ?? "";
        expect(memoryText.toLowerCase()).toContain("c++");
      },
    );

    ls.test(
      "explicit preference remembered",
      {
        inputs: {
          query:
            "Conversation transcript:\n" +
            "User: Write me a short congratulations message for a teammate.\n" +
            "Assistant: Congrats on the launch! 🎉🚀 Amazing work from the whole team!\n" +
            "User: No emojis please. Remember: never use emojis in anything you write for me.\n\n" +
            "Now answer: Write another short congratulations message.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({
            memory: [MEMORY_PATH],
          })
          .run({
            query: inputs.query,
            initialFiles: {
              [MEMORY_PATH]: MEMORY_SEED,
            },
          });

        const answer = getFinalText(result);
        expect(answer).not.toContain("🎉");
        expect(answer).not.toContain("🚀");

        const memoryText = (result.files[MEMORY_PATH] ?? "").toLowerCase();
        expect(memoryText).toContain("emoji");
      },
    );

    ls.test(
      "transient info not persisted",
      {
        inputs: {
          query:
            "Conversation transcript:\n" +
            "User: I'm exhausted today, barely slept last night.\n" +
            "Assistant: Sorry to hear that. How can I help?\n" +
            "User: Help me rename processData to process_data in the codebase.\n\n" +
            "Now answer two things briefly:\n" +
            "1) the renamed identifier\n" +
            "2) durable preferences you remember about me",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({
            memory: [MEMORY_PATH],
          })
          .run({
            query: inputs.query,
            initialFiles: {
              [MEMORY_PATH]: MEMORY_SEED,
            },
          });

        expect(getFinalText(result).toLowerCase()).toContain("process_data");
        const memoryText = (result.files[MEMORY_PATH] ?? "").toLowerCase();
        expect(memoryText).not.toContain("exhausted");
        expect(memoryText).not.toContain("slept last night");
      },
    );
  },
  { projectName: runner.name, upsert: true },
);
