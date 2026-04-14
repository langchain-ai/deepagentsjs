import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import {
  getDefaultRunner,
  parseTrajectory,
  getFinalText,
} from "@deepagents/evals";

const runner = getDefaultRunner();

function resolveModelFromEvalRunner(): string {
  const name = process.env.EVAL_RUNNER;
  if (name === "sonnet-4-5" || name === "sonnet-4-5-thinking")
    return "claude-sonnet-4-5-20250929";
  if (name === "sonnet-4-6") return "claude-sonnet-4-6";
  if (name === "opus-4-6") return "claude-opus-4-6";
  if (name === "gpt-4.1") return "gpt-4.1";
  if (name === "gpt-4.1-mini") return "gpt-4.1-mini";
  if (name === "o3-mini") return "o3-mini";
  return "claude-sonnet-4-6";
}

async function invoke(
  agent: ReturnType<typeof createDeepAgent>,
  threadId: string,
  query: string,
  initialFiles?: Record<string, string>,
) {
  const now = new Date().toISOString();
  const files: Record<
    string,
    { content: string[]; created_at: string; modified_at: string }
  > = {};
  for (const [path, content] of Object.entries(initialFiles ?? {})) {
    files[path] = {
      content: content.split("\n"),
      created_at: now,
      modified_at: now,
    };
  }

  const result = await agent.invoke(
    {
      messages: [{ role: "user", content: query }],
      ...(Object.keys(files).length > 0 ? { files } : {}),
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
      "long context memorization",
      {
        inputs: {
          source: "synthetic_long_context",
        },
      },
      async () => {
        const agent = createDeepAgent({
          model: resolveModelFromEvalRunner(),
          checkpointer: new MemorySaver(),
        });
        const threadId = crypto.randomUUID();

        const chunks = [
          "Project overview: codename Nimbus. Primary language Rust. Launch quarter Q3.",
          "Operational notes: staging region us-west-2, production region eu-central-1.",
          "Security notes: rotate deployment key every 30 days. Incident channel #ops-urgent.",
        ];

        for (const chunk of chunks) {
          await invoke(
            agent,
            threadId,
            `Please memorize this information for later questions:\n\n${chunk}`,
          );
        }

        const qa = await invoke(
          agent,
          threadId,
          "Based only on prior context, what is the project codename and production region? Answer briefly.",
        );

        const answer = getFinalText(qa).toLowerCase();
        expect(answer).toContain("nimbus");
        expect(answer).toContain("eu-central-1");
      },
    );

    ls.test(
      "conflict resolution latest fact wins",
      {
        inputs: {
          source: "synthetic_conflict_resolution",
        },
      },
      async () => {
        const agent = createDeepAgent({
          model: resolveModelFromEvalRunner(),
          checkpointer: new MemorySaver(),
        });
        const threadId = crypto.randomUUID();

        await invoke(agent, threadId, "Memorize: The support tier is Gold.");
        await invoke(
          agent,
          threadId,
          "Update: support tier has been downgraded to Silver.",
        );
        const qa = await invoke(
          agent,
          threadId,
          "What is the current support tier? Return only the tier.",
        );

        const answer = getFinalText(qa).toLowerCase();
        expect(answer).toContain("silver");
        expect(answer).not.toContain("gold");
      },
    );

    ls.test(
      "file seeded retrieval mode",
      {
        inputs: {
          source: "synthetic_file_seeded",
        },
      },
      async () => {
        const agent = createDeepAgent({
          model: resolveModelFromEvalRunner(),
          checkpointer: new MemorySaver(),
          systemPrompt:
            "Use file tools to retrieve answers from /data files before responding. Keep answers concise.",
        });
        const threadId = crypto.randomUUID();

        const qa = await invoke(
          agent,
          threadId,
          "Using the files under /data, what is the escalation alias for database incidents? Answer with the alias only.",
          {
            "/data/chunk_0001.txt": "Service map: web -> app -> db.",
            "/data/chunk_0002.txt":
              "On-call aliases: web=#web-ops, app=#app-ops, db=#db-urgent.",
            "/data/chunk_0003.txt":
              "Escalation policy: page alias first, then manager.",
          },
        );

        expect(getFinalText(qa).toLowerCase()).toContain("#db-urgent");
      },
    );
  },
  { projectName: "deepagents-js-memory-agent-bench", upsert: true },
);
