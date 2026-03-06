import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import { agent, createDeepAgent, runAgent, getFinalText } from "./index.js";

const getWeatherFake = tool(
  async (_input) => {
    return "It's sunny at 89 degrees F";
  },
  {
    name: "get_weather_fake",
    description: "Return a fixed weather response for eval scenarios.",
    schema: z.object({
      location: z.string(),
    }),
  },
);

ls.describe("deepagents-js-basic", () => {
  ls.test(
    "system prompt: custom system prompt",
    {
      inputs: { query: "what is your name" },
      referenceOutputs: { expectedText: "Foo Bar" },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        systemPrompt: "Your name is Foo Bar.",
      });
      const result = await runAgent(customAgent, { query: inputs.query });

      expect(result).toHaveAgentSteps(1);
      expect(result).toHaveToolCallRequests(0);
      expect(result).toHaveFinalTextContaining("Foo Bar");
    },
  );

  ls.test(
    "subagents: task calls weather subagent",
    {
      inputs: {
        query: "Use the weather_agent subagent to get the weather in Tokyo.",
      },
      referenceOutputs: { expectedText: "89" },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        subagents: [
          {
            name: "weather_agent",
            description: "Use this agent to get the weather",
            systemPrompt: "You are a weather agent.",
            tools: [getWeatherFake],
          },
        ],
      });
      const result = await runAgent(customAgent, { query: inputs.query });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveToolCallInStep(1, {
        name: "task",
        argsContains: { subagent_type: "weather_agent" },
      });
      expect(result).toHaveFinalTextContaining("89");
    },
  );

  ls.test(
    "subagents: task calls general-purpose subagent",
    {
      inputs: {
        query: "Use the general purpose subagent to get the weather in Tokyo.",
      },
      referenceOutputs: { expectedText: "89" },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({ tools: [getWeatherFake] });
      const result = await runAgent(customAgent, { query: inputs.query });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveToolCallInStep(1, {
        name: "task",
        argsContains: { subagent_type: "general-purpose" },
      });
      expect(result).toHaveFinalTextContaining("89");
    },
  );

  ls.test(
    "files: read file seeded state backend file",
    {
      inputs: {
        query: "Read /foo.md and tell me the 3rd word on the 2nd line.",
      },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: {
          "/foo.md": "alpha beta gamma\none two three four\n",
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveFinalTextContaining("three", true);
    },
  );

  ls.test(
    "files: write file simple",
    {
      inputs: {
        query:
          "Write your name to a file called /foo.md and then tell me your name.",
      },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        systemPrompt: "Your name is Foo Bar.",
      });
      const result = await runAgent(customAgent, { query: inputs.query });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result.files["/foo.md"]).toContain("Foo Bar");
      expect(getFinalText(result)).toContain("Foo Bar");
    },
  );

  ls.test(
    "files: write files in parallel",
    {
      inputs: {
        query:
          'Write "bar" to /a.md and "bar" to /b.md. Do the writes in parallel, then confirm you did it.',
      },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, { query: inputs.query });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(2);
      expect(result).toHaveToolCallInStep(1, {
        name: "write_file",
        argsContains: { file_path: "/a.md" },
      });
      expect(result).toHaveToolCallInStep(1, {
        name: "write_file",
        argsContains: { file_path: "/b.md" },
      });
      expect(result.files["/a.md"]).toBe("bar");
      expect(result.files["/b.md"]).toBe("bar");
    },
  );

  ls.test(
    "files: ls directory contains file yes/no",
    {
      inputs: {
        query:
          "Is there a file named c.md in /foo? Answer with [YES] or [NO] only.",
      },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: {
          "/foo/a.md": "a",
          "/foo/b.md": "b",
          "/foo/c.md": "c",
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveFinalTextContaining("[YES]");
    },
  );

  ls.test(
    "files: ls directory missing file yes/no",
    {
      inputs: {
        query:
          "Is there a file named c.md in /foo? Answer with [YES] or [NO] only.",
      },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: {
          "/foo/a.md": "a",
          "/foo/b.md": "b",
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveFinalTextContaining("[NO]", true);
    },
  );

  ls.test(
    "files: edit file replace text",
    {
      inputs: {
        query:
          "Replace all instances of 'cat' with 'dog' in /note.md, then tell me how many replacements you made. Do not read the file before editing it.",
      },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: { "/note.md": "cat cat cat\n" },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result.files["/note.md"]).toBe("dog dog dog\n");
    },
  );

  ls.test(
    "files: read then write derived output",
    {
      inputs: {
        query:
          "Read /data.txt and write the lines reversed (line order) to /out.txt.",
      },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: { "/data.txt": "alpha\nbeta\ngamma\n" },
      });

      expect(result).toHaveAgentSteps(3);
      expect(result).toHaveToolCallRequests(2);
      expect(result.files["/out.txt"].trimEnd().split("\n")).toEqual([
        "gamma",
        "beta",
        "alpha",
      ]);
    },
  );

  ls.test(
    "files: avoid unnecessary tool calls",
    {
      inputs: { query: "What is 2+2? Answer with just the number." },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, { query: inputs.query });

      expect(result).toHaveAgentSteps(1);
      expect(result).toHaveToolCallRequests(0);
      expect(getFinalText(result).trim()).toBe("4");
    },
  );

  ls.test(
    "files: read files in parallel",
    {
      inputs: {
        query:
          "Read /a.md and /b.md in parallel and tell me if they are identical. Answer with [YES] or [NO] only.",
      },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: {
          "/a.md": "same",
          "/b.md": "same",
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(2);
      expect(result).toHaveToolCallInStep(1, {
        name: "read_file",
        argsContains: { file_path: "/a.md" },
      });
      expect(result).toHaveToolCallInStep(1, {
        name: "read_file",
        argsContains: { file_path: "/b.md" },
      });
      expect(result).toHaveFinalTextContaining("[YES]");
    },
  );

  ls.test(
    "files: grep finds matching paths",
    {
      inputs: {
        query:
          "Using grep, find which files contain the word 'needle'. Answer with the matching file paths only.",
      },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: {
          "/a.txt": "haystack\nneedle\n",
          "/b.txt": "haystack\n",
          "/c.md": "needle\n",
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      const answer = getFinalText(result);
      expect(answer).toContain("/a.txt");
      expect(answer).toContain("/c.md");
      expect(answer).not.toContain("/b.txt");
    },
  );

  ls.test(
    "files: glob lists markdown files",
    {
      inputs: {
        query:
          "Using glob, list all markdown files under /foo. Answer with the file paths only.",
      },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: {
          "/foo/a.md": "a",
          "/foo/b.txt": "b",
          "/foo/c.md": "c",
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      const answer = getFinalText(result);
      expect(answer).toContain("/foo/a.md");
      expect(answer).toContain("/foo/c.md");
      expect(answer).not.toContain("/foo/b.txt");
    },
  );

  ls.test(
    "files: tool error recovery read file then ls",
    {
      inputs: {
        query:
          "First, try reading /docs/notes_for_release.md and tell me the MAGIC_TOKEN value.",
      },
      referenceOutputs: { expectedText: "SAPPHIRE-13" },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: {
          "/docs/readme.md": "hello\n",
          "/docs/release_notes.md":
            "Version: 1.2.3\n\nImportant: The MAGIC_TOKEN is SAPPHIRE-13.\n",
        },
      });

      expect(result).toHaveAgentSteps(4);
      expect(result).toHaveToolCallRequests(3);
      expect(result).toHaveToolCallInStep(1, {
        name: "read_file",
        argsContains: { file_path: "/docs/notes_for_release.md" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "ls",
        argsContains: { path: "/docs" },
      });
      expect(result).toHaveToolCallInStep(3, {
        name: "read_file",
        argsContains: { file_path: "/docs/release_notes.md" },
      });
      expect(result).toHaveFinalTextContaining("SAPPHIRE-13");
    },
  );

  ls.test(
    "files: write files in parallel with verification",
    {
      inputs: {
        query:
          'Write "bar" to /a.md and "bar" to /b.md in parallel. Then read both files in parallel to verify. Reply with DONE only.',
      },
      referenceOutputs: { expectedText: "DONE" },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, { query: inputs.query });

      expect(result).toHaveAgentSteps(3);
      expect(result).toHaveToolCallRequests(4);
      expect(result).toHaveToolCallInStep(1, {
        name: "write_file",
        argsContains: { file_path: "/a.md" },
      });
      expect(result).toHaveToolCallInStep(1, {
        name: "write_file",
        argsContains: { file_path: "/b.md" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/a.md" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/b.md" },
      });
      expect(result).toHaveFinalTextContaining("DONE");
      expect(result.files["/a.md"]).toBe("bar");
      expect(result.files["/b.md"]).toBe("bar");
    },
  );

  ls.test(
    "files: write files in parallel ambiguous confirmation",
    {
      inputs: {
        query:
          'Write "bar" to /a.md and "bar" to /b.md. Do the writes in parallel, then reply DONE.',
      },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, { query: inputs.query });

      expect(result).toHaveToolCallInStep(1, {
        name: "write_file",
        argsContains: { file_path: "/a.md" },
      });
      expect(result).toHaveToolCallInStep(1, {
        name: "write_file",
        argsContains: { file_path: "/b.md" },
      });
      expect(result.files["/a.md"]).toBe("bar");
      expect(result.files["/b.md"]).toBe("bar");
    },
  );

  ls.test(
    "files: find magic phrase deep nesting",
    {
      inputs: {
        query:
          "Find the file that contains the line starting with 'MAGIC_PHRASE:' and reply with the phrase value only. Be efficient: use grep.",
      },
      referenceOutputs: { expectedText: "cobalt-otter-17" },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: {
          "/a/b/c/d/e/notes.txt": "just some notes\n",
          "/a/b/c/d/e/readme.md": "project readme\n",
          "/a/b/c/d/e/answer.txt": "MAGIC_PHRASE: cobalt-otter-17\n",
          "/a/b/c/d/other.txt": "nothing here\n",
          "/a/b/x/y/z/nope.txt": "still nothing\n",
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveToolCallInStep(1, {
        name: "grep",
        argsContains: { pattern: "MAGIC_PHRASE:" },
      });
      expect(result).toHaveFinalTextContaining("cobalt-otter-17");
      expect(getFinalText(result)).not.toContain("MAGIC_PHRASE");
    },
  );

  ls.test(
    "files: identify quote author from directory parallel reads",
    {
      inputs: {
        query:
          "In the /quotes directory, there are several small quote files. " +
          "Which file most likely contains a quote by Grace Hopper? Reply with the file path only. " +
          "Be efficient: list the directory, then read the quote files in parallel to decide. " +
          "Do not use grep.",
      },
      referenceOutputs: { expectedText: "/quotes/q3.txt" },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: {
          "/quotes/q1.txt":
            "Quote: The analytical engine weaves algebraic patterns.\nClues: discusses an engine for computation and weaving patterns.\n",
          "/quotes/q2.txt":
            "Quote: I have always been more interested in the future than in the past.\nClues: talks about anticipating the future; broad and general.\n",
          "/quotes/q3.txt":
            "Quote: The most dangerous phrase in the language is, 'We've always done it this way.'\nClues: emphasizes changing established processes; often associated with early computing leadership.\n",
          "/quotes/q4.txt":
            "Quote: Sometimes it is the people no one can imagine anything of who do the things no one can imagine.\nClues: about imagination and doing the impossible; inspirational.\n",
          "/quotes/q5.txt":
            "Quote: Programs must be written for people to read, and only incidentally for machines to execute.\nClues: about programming readability; software craftsmanship.\n",
        },
      });

      expect(result).toHaveAgentSteps(3);
      expect(result).toHaveToolCallRequests(6);
      expect(result).toHaveToolCallInStep(1, {
        name: "ls",
        argsContains: { path: "/quotes" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/quotes/q1.txt" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/quotes/q2.txt" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/quotes/q3.txt" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/quotes/q4.txt" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/quotes/q5.txt" },
      });
      expect(result).toHaveFinalTextContaining("/quotes/q3.txt");
    },
  );

  ls.test(
    "files: identify quote author from directory unprompted efficiency",
    {
      inputs: {
        query:
          "In the /quotes directory, there are a few small quote files. " +
          "Which file most likely contains a quote by Grace Hopper? Reply with the file path only.",
      },
      referenceOutputs: { expectedText: "/quotes/q3.txt" },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: {
          "/quotes/q1.txt":
            "Quote: The analytical engine weaves algebraic patterns.\nClues: discusses an engine for computation and weaving patterns.\n",
          "/quotes/q2.txt":
            "Quote: I have always been more interested in the future than in the past.\nClues: talks about anticipating the future; broad and general.\n",
          "/quotes/q3.txt":
            "Quote: The most dangerous phrase in the language is, 'We've always done it this way.'\nClues: emphasizes changing established processes; often associated with early computing leadership.\n",
          "/quotes/q4.txt":
            "Quote: Sometimes it is the people no one can imagine anything of who do the things no one can imagine.\nClues: about imagination and doing the impossible; inspirational.\n",
          "/quotes/q5.txt":
            "Quote: Programs must be written for people to read, and only incidentally for machines to execute.\nClues: about programming readability; software craftsmanship.\n",
        },
      });

      expect(result).toHaveAgentSteps(3);
      expect(result).toHaveToolCallRequests(6);
      expect(result).toHaveToolCallInStep(1, {
        name: "ls",
        argsContains: { path: "/quotes" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/quotes/q1.txt" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/quotes/q2.txt" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/quotes/q3.txt" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/quotes/q4.txt" },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "read_file",
        argsContains: { file_path: "/quotes/q5.txt" },
      });
      expect(result).toHaveFinalTextContaining("/quotes/q3.txt");
    },
  );
});
