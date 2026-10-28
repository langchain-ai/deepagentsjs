import { describe, it, expect, vi } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { DeepAgentsServer } from "./server.js";

type Update = {
  sessionUpdate: string;
  content?: { text?: string };
  toolCallId?: string;
};

describe("session/load", () => {
  it("replays the agent's replies and tool calls, not only the prompts", async () => {
    const lookup = tool(async () => "found", {
      name: "lookup",
      description: "Looks a term up.",
      schema: {
        type: "object",
        properties: { term: { type: "string" } },
        required: ["term"],
      },
    });
    const model = fakeModel()
      .respond(
        new AIMessage({
          content: "",
          tool_calls: [
            { name: "lookup", args: { term: "x" }, id: "call_lookup" },
          ],
        }),
      )
      .respond(new AIMessage("It is x."));
    const server = new DeepAgentsServer({
      agents: {
        name: "replay-agent",
        description: "Answers questions.",
        model,
        tools: [lookup],
      },
    });
    const handlers = server as unknown as {
      handleNewSession(
        params: Record<string, unknown>,
        conn: unknown,
      ): Promise<{ sessionId: string }>;
      handlePrompt(
        params: Record<string, unknown>,
        conn: unknown,
      ): Promise<{ stopReason: string }>;
      handleLoadSession(
        params: Record<string, unknown>,
        conn: unknown,
      ): Promise<unknown>;
    };
    const conn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };

    const { sessionId } = await handlers.handleNewSession({}, conn);
    const { stopReason } = await handlers.handlePrompt(
      { sessionId, prompt: [{ type: "text", text: "What is x?" }] },
      conn,
    );
    const reloaded = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
    await handlers.handleLoadSession({ sessionId }, reloaded);

    const updates = reloaded.sessionUpdate.mock.calls.map(
      ([notification]) => (notification as { update: Update }).update,
    );
    const of = (kind: string) =>
      updates.filter((update) => update.sessionUpdate === kind);
    expect(stopReason).toBe("end_turn");
    expect(of("user_message_chunk").map((u) => u.content?.text)).toEqual([
      "What is x?",
    ]);
    expect(of("tool_call").map((u) => u.toolCallId)).toEqual(["call_lookup"]);
    expect(of("agent_message_chunk").map((u) => u.content?.text)).toEqual([
      "It is x.",
    ]);
  });
});
