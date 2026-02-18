import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { agent, createDeepAgent, runAgent, getFinalText } from "./index.js";

ls.describe("file operations", () => {
  ls.test(
    "read file seeded state backend file",
    {
      inputs: {
        query: "Read /foo.md and tell me the 3rd word on the 2nd line.",
      },
    },
    async ({ inputs }) => {
      const result = await runAgent(agent, {
        query: inputs.query,
        initialFiles: { "/foo.md": "alpha beta gamma\none two three four\n" },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveFinalTextContaining("three", true);
    },
  );

  ls.test(
    "write file simple",
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
    "write files in parallel",
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
    "ls directory contains file yes/no",
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
    "ls directory missing file yes/no",
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
    "edit file replace text",
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
    "read then write derived output",
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
    "avoid unnecessary tool calls",
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
    "read files in parallel",
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
    "grep finds matching paths",
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
    "glob lists markdown files",
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
});
