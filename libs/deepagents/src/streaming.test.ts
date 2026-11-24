import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createAgent, tool } from "langchain";
import { z } from "zod/v4";

import { createDeepAgent } from "./agent.js";

describe("stream", () => {
  it("streams two subagents started in one turn under separate tools namespaces", async () => {
    const pingTool = tool(
      async (input: { value: string }) => `pong:${input.value}`,
      {
        name: "ping",
        description: "A simple ping tool",
        schema: z.object({ value: z.string() }),
      },
    );

    const subagent = (name: string) =>
      createAgent({
        model: fakeModel()
          .respondWithTools([
            { name: "ping", id: `ping-${name}`, args: { value: name } },
          ])
          .respond(new AIMessage(`done:${name}`)),
        tools: [pingTool],
        name,
      });

    const agent = createDeepAgent({
      model: fakeModel()
        .respondWithTools([
          {
            name: "task",
            id: "task-researcher",
            args: {
              description: "Research AI trends",
              subagent_type: "researcher",
            },
          },
          {
            name: "task",
            id: "task-coder",
            args: {
              description: "Write a hello world",
              subagent_type: "coder",
            },
          },
        ])
        .respond(new AIMessage("All subagents completed")),
      subagents: [
        {
          name: "researcher",
          description: "Research agent",
          runnable: subagent("researcher"),
        },
        {
          name: "coder",
          description: "Coding agent",
          runnable: subagent("coder"),
        },
      ],
    });

    const seen = new Map<
      string,
      { agentNames: Set<unknown>; aiTexts: string[]; toolResults: string[] }
    >();
    for await (const [namespace, mode, data] of await agent.stream(
      { messages: [new HumanMessage("Do both tasks")] },
      { streamMode: ["messages", "updates"], subgraphs: true },
    )) {
      if (mode !== "messages" || namespace.length === 0) continue;
      const [message, metadata] = data;
      const entry = seen.get(namespace[0]) ?? {
        agentNames: new Set(),
        aiTexts: [],
        toolResults: [],
      };
      seen.set(namespace[0], entry);
      entry.agentNames.add(metadata.lc_agent_name);
      (message.type === "tool" ? entry.toolResults : entry.aiTexts).push(
        message.text,
      );
    }

    const namespaces = [...seen.keys()];
    expect(namespaces).toHaveLength(2);
    expect(namespaces.every((ns) => ns.startsWith("tools:"))).toBe(true);

    const byAgent = Object.fromEntries(
      [...seen.values()].map((entry) => {
        expect(entry.agentNames.size).toBe(1);
        return [[...entry.agentNames][0], entry];
      }),
    );
    expect(Object.keys(byAgent).sort()).toEqual(["coder", "researcher"]);
    expect(byAgent.researcher.toolResults).toEqual(["pong:researcher"]);
    expect(byAgent.researcher.aiTexts.join("")).toContain("done:researcher");
    expect(byAgent.researcher.aiTexts.join("")).not.toContain("done:coder");
    expect(byAgent.coder.toolResults).toEqual(["pong:coder"]);
    expect(byAgent.coder.aiTexts.join("")).toContain("done:coder");
    expect(byAgent.coder.aiTexts.join("")).not.toContain("done:researcher");
  });

  it("hides a forked subagent's messages unless subgraphs are requested", async () => {
    const history = ["HISTORY_MESSAGE_ONE", "HISTORY_MESSAGE_TWO"];
    const input = () => ({
      messages: [
        new HumanMessage("The ticket is T-123"),
        ...history.map((text) => new AIMessage(text)),
      ],
    });

    const build = () => {
      const worker = fakeModel().respond(new AIMessage("FORK_PRIVATE_RESULT"));
      const agent = createDeepAgent({
        // respondWithTools would echo the input messages as the tool-call
        // message's text, which reads as history replayed into the stream.
        model: fakeModel()
          .respond(
            new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: "task",
                  id: "task-worker",
                  args: {
                    description: "Continue with ticket T-123",
                    subagent_type: "worker",
                  },
                  type: "tool_call",
                },
              ],
            }),
          )
          .respond(new AIMessage("PARENT_FINAL")),
        subagents: [
          {
            name: "worker",
            description: "Continues the current conversation",
            model: worker,
            mode: "fork",
          },
        ],
      });
      return { agent, worker };
    };

    const root = build();
    const rootAiTexts: string[] = [];
    const rootToolTexts: string[] = [];
    for await (const [message] of await root.agent.stream(input(), {
      streamMode: "messages",
    })) {
      (message.type === "tool" ? rootToolTexts : rootAiTexts).push(
        message.text,
      );
    }

    const inherited = root.worker.calls[0].messages.map((m) => m.text);
    for (const text of history) {
      expect(inherited.filter((t) => t === text)).toHaveLength(1);
    }

    const rootAiText = rootAiTexts.join("");
    expect(rootAiText).toContain("PARENT_FINAL");
    expect(rootAiText).not.toContain("FORK_PRIVATE_RESULT");
    for (const text of history) expect(rootAiText).not.toContain(text);
    expect(rootToolTexts.join("")).toContain("FORK_PRIVATE_RESULT");

    const forkTexts: string[] = [];
    for await (const [namespace, mode, data] of await build().agent.stream(
      input(),
      { streamMode: ["messages", "updates"], subgraphs: true },
    )) {
      if (mode !== "messages" || namespace.length === 0) continue;
      const [message, metadata] = data;
      if (metadata.lc_agent_name !== "worker") continue;
      expect(namespace[0]).toMatch(/^tools:/);
      forkTexts.push(message.text);
    }

    const forkText = forkTexts.join("");
    expect(forkText).toContain("FORK_PRIVATE_RESULT");
    for (const text of history) expect(forkText).not.toContain(text);
  });
});
