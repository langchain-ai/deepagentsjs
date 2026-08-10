import { describe, expect, it } from "vitest";
import { Client } from "@langchain/langgraph-sdk";
import { z } from "zod";

const DeploymentUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1"].includes(url.hostname))
    );
  }, "LANGGRAPH_API_URL must use HTTPS, or HTTP for a local deployment");

const deploymentUrl = process.env.LANGGRAPH_API_URL?.trim();
const graphId =
  process.env.LANGGRAPH_SERDE_GRAPH_ID?.trim() ?? "summarization-serde";
const describeDeployment = deploymentUrl ? describe : describe.skip;

describeDeployment("summarization checkpoint serde deployment", () => {
  it("rejects a resumed thread if its summary message was not rehydrated", async () => {
    const client = new Client({
      apiUrl: DeploymentUrlSchema.parse(deploymentUrl),
    });
    const thread = await client.threads.create();

    try {
      await client.runs.wait(thread.thread_id, graphId, {
        input: { messages: [{ type: "human", content: "first user request" }] },
      });
      await client.runs.wait(thread.thread_id, graphId, {
        input: {
          messages: [{ type: "human", content: "second user request" }],
        },
      });

      const summarizedState = await client.threads.getState(thread.thread_id);
      expect(
        (summarizedState.values as Record<string, unknown>)._summarizationEvent,
      ).toBeDefined();

      // The fixture middleware throws before the model call if checkpoint serde
      // returned a plain object instead of a HumanMessage.
      await expect(
        client.runs.wait(thread.thread_id, graphId, {
          input: {
            messages: [
              { type: "human", content: "third user request after resume" },
            ],
          },
        }),
      ).resolves.toBeDefined();
    } finally {
      await client.threads.delete(thread.thread_id);
    }
  });
});
