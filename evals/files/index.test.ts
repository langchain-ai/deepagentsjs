import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner } from "@deepagents/evals";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-files",
  () => {
    ls.test(
      "read file seeded state backend file",
      {
        inputs: {
          query: "Read /foo.md and tell me the 3rd word on the 2nd line.",
        },
      },
      async ({ inputs }) => {
        const result = await runner.run({
          query: inputs.query,
          initialFiles: {
            "/foo.md": "alpha beta gamma\none two three four\n",
          },
        });

        expect(result).toHaveFinalTextContaining("three", true);
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
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
        const result = await runner
          .extend({ systemPrompt: "Your name is Foo Bar." })
          .run({ query: inputs.query });

        expect(result.files["/foo.md"]).toContain("Foo Bar");
        expect(result).toHaveFinalTextContaining("Foo Bar");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
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
        const result = await runner.run({ query: inputs.query });

        expect(result.files["/a.md"]).toBe("bar");
        expect(result.files["/b.md"]).toBe("bar");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
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
        const result = await runner.run({
          query: inputs.query,
          initialFiles: {
            "/foo/a.md": "a",
            "/foo/b.md": "b",
            "/foo/c.md": "c",
          },
        });

        expect(result).toHaveFinalTextContaining("[YES]");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
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
        const result = await runner.run({
          query: inputs.query,
          initialFiles: {
            "/foo/a.md": "a",
            "/foo/b.md": "b",
          },
        });

        expect(result).toHaveFinalTextContaining("[NO]", true);
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
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
        const result = await runner.run({
          query: inputs.query,
          initialFiles: { "/note.md": "cat cat cat\n" },
        });

        expect(result.files["/note.md"]).toBe("dog dog dog\n");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
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
        const result = await runner.run({
          query: inputs.query,
          initialFiles: { "/data.txt": "alpha\nbeta\ngamma\n" },
        });

        expect(result.files["/out.txt"].trimEnd().split("\n")).toEqual([
          "gamma",
          "beta",
          "alpha",
        ]);
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
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
        const result = await runner.run({
          query: inputs.query,
          initialFiles: {
            "/a.md": "same",
            "/b.md": "same",
          },
        });

        expect(result).toHaveFinalTextContaining("[YES]");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
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
        const result = await runner.run({
          query: inputs.query,
          initialFiles: {
            "/a.txt": "haystack\nneedle\n",
            "/b.txt": "haystack\n",
            "/c.md": "needle\n",
          },
        });

        expect(result).toHaveFinalTextContaining("/a.txt");
        expect(result).toHaveFinalTextContaining("/c.md");
        expect(result).not.toHaveFinalTextContaining("/b.txt");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
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
        const result = await runner.run({
          query: inputs.query,
          initialFiles: {
            "/foo/a.md": "a",
            "/foo/b.txt": "b",
            "/foo/c.md": "c",
          },
        });

        expect(result).toHaveFinalTextContaining("/foo/a.md");
        expect(result).toHaveFinalTextContaining("/foo/c.md");
        expect(result).not.toHaveFinalTextContaining("/foo/b.txt");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "write files in parallel with verification",
      {
        inputs: {
          query:
            'Write "bar" to /a.md and "bar" to /b.md in parallel. Then read both files in parallel to verify. Reply with DONE only.',
        },
      },
      async ({ inputs }) => {
        const result = await runner.run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("DONE");
        expect(result.files["/a.md"]).toBe("bar");
        expect(result.files["/b.md"]).toBe("bar");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "write files in parallel ambiguous confirmation",
      {
        inputs: {
          query:
            'Write "bar" to /a.md and "bar" to /b.md. Do the writes in parallel, then reply DONE.',
        },
      },
      async ({ inputs }) => {
        // Intentionally ambiguous: some models will confirm directly; others
        // may read back to verify. Only enforce the parallel writes and file
        // content; do not enforce step/tool-call counts.
        const result = await runner.run({ query: inputs.query });

        expect(result.files["/a.md"]).toBe("bar");
        expect(result.files["/b.md"]).toBe("bar");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "find magic phrase deep nesting",
      {
        inputs: {
          query:
            "Find the file that contains the line starting with 'MAGIC_PHRASE:' and reply with the phrase value only. Be efficient: use grep.",
        },
        referenceOutputs: { expectedText: "cobalt-otter-17" },
      },
      async ({ inputs }) => {
        const result = await runner.run({
          query: inputs.query,
          initialFiles: {
            "/a/b/c/d/e/notes.txt": "just some notes\n",
            "/a/b/c/d/e/readme.md": "project readme\n",
            "/a/b/c/d/e/answer.txt": "MAGIC_PHRASE: cobalt-otter-17\n",
            "/a/b/c/d/other.txt": "nothing here\n",
            "/a/b/x/y/z/nope.txt": "still nothing\n",
          },
        });

        expect(result).toHaveFinalTextContaining("cobalt-otter-17");
        expect(result).not.toHaveFinalTextContaining("MAGIC_PHRASE");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "identify quote author from directory parallel reads",
      {
        inputs: {
          query:
            "In the /quotes directory, there are several small quote files. " +
            "Which file most likely contains a quote by Grace Hopper? Reply with the file path only. " +
            "Be efficient: list the directory, then read the quote files in parallel to decide. " +
            "Do not use grep.",
        },
        referenceOutputs: { expectedPath: "/quotes/q3.txt" },
      },
      async ({ inputs }) => {
        const result = await runner.run({
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

        expect(result).toHaveFinalTextContaining("/quotes/q3.txt");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "identify quote author from directory unprompted efficiency",
      {
        inputs: {
          query:
            "In the /quotes directory, there are a few small quote files. " +
            "Which file most likely contains a quote by Grace Hopper? Reply with the file path only.",
        },
        referenceOutputs: { expectedPath: "/quotes/q3.txt" },
      },
      async ({ inputs }) => {
        // Same task as above but without explicit efficiency instructions.
        // We still expect ls + parallel reads but the model may choose a
        // different strategy.
        const result = await runner.run({
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

        expect(result).toHaveFinalTextContaining("/quotes/q3.txt");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );
  },
  { projectName: runner.name, upsert: true },
);
