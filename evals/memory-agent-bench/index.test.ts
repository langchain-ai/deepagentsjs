import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner, getFinalText } from "@deepagents/evals";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-memory-agent-bench",
  () => {
    ls.test(
      "long context memorization",
      {
        inputs: {
          source: "synthetic_long_context",
          query:
            "Please memorize the following context and answer the final question using only it.\n\n" +
            "Chunk 1: Project overview: codename Nimbus. Primary language Rust. Launch quarter Q3.\n" +
            "Chunk 2: Operational notes: staging region us-west-2, production region eu-central-1.\n" +
            "Chunk 3: Security notes: rotate deployment key every 30 days. Incident channel #ops-urgent.\n\n" +
            "Question: Based only on the context above, what is the project codename and production region? Answer briefly.",
        },
      },
      async ({ inputs }) => {
        const result = await runner.run({ query: inputs.query });
        const answer = getFinalText(result).toLowerCase();
        expect(answer).toContain("nimbus");
        expect(answer).toContain("eu-central-1");
      },
    );

    ls.test(
      "conflict resolution latest fact wins",
      {
        inputs: {
          source: "synthetic_conflict_resolution",
          query:
            "Facts:\n" +
            "- Initial: The support tier is Gold.\n" +
            "- Update: support tier has been downgraded to Silver.\n\n" +
            "Question: What is the current support tier? Return only the tier.",
        },
      },
      async ({ inputs }) => {
        const result = await runner.run({ query: inputs.query });
        const answer = getFinalText(result).toLowerCase();
        expect(answer).toContain("silver");
        expect(answer).not.toContain("gold");
      },
    );

    ls.test(
      "file seeded retrieval mode",
      {
        inputs: {
          source: "synthetic_file_seeded",
          query:
            "Using the files under /data, what is the escalation alias for database incidents? " +
            "Answer with the alias only.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({
            systemPrompt:
              "Use file tools to retrieve answers from /data files before responding. Keep answers concise.",
          })
          .run({
            query: inputs.query,
            initialFiles: {
              "/data/chunk_0001.txt": "Service map: web -> app -> db.",
              "/data/chunk_0002.txt":
                "On-call aliases: web=#web-ops, app=#app-ops, db=#db-urgent.",
              "/data/chunk_0003.txt":
                "Escalation policy: page alias first, then manager.",
            },
          });

        expect(getFinalText(result).toLowerCase()).toContain("#db-urgent");
      },
    );
  },
  { projectName: runner.name, upsert: true },
);
