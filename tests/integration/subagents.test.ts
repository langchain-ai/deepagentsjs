import { describe, it, expect } from "vitest";
import { createAgent, createMiddleware, ReactAgent } from "langchain";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { createSubAgentMiddleware } from "../../src/index.js";
import {
  SAMPLE_MODEL,
  getWeather,
  getSoccerScores,
  extractToolsFromAgent,
} from "../utils.js";

const WeatherToolMiddleware = createMiddleware({
  name: "weatherToolMiddleware",
  tools: [getWeather],
});

/**
 * Helper to extract all tool calls from agent response
 */
function extractAllToolCalls(
  response: any
): Array<{ name: string; args: Record<string, any>; model?: string }> {
  const messages = response.messages || [];
  const aiMessages = messages.filter((msg: any) => AIMessage.isInstance(msg));
  return aiMessages.flatMap((msg: any) =>
    (msg.tool_calls || []).map((toolCall: any) => ({
      name: toolCall.name,
      args: toolCall.args,
      model: msg.response_metadata?.model_name || undefined,
    }))
  );
}

/**
 * Helper to assert expected actions in subgraph
 * This collects all tool calls from the agent execution
 */
async function assertExpectedSubgraphActions(
  expectedToolCalls: Array<{
    name: string;
    args?: Record<string, any>;
    model?: string;
  }>,
  agent: ReactAgent,
  input: any
) {
  const actualToolCalls: Array<{
    name: string;
    args: Record<string, any>;
    model?: string;
  }> = [];

  for await (const chunk of await agent.graph.stream(input, {
    streamMode: ["updates"],
    subgraphs: true,
  })) {
    const update = chunk[2] ?? {};

    if (!("model_request" in update)) continue;
    const messages = update.model_request.messages as BaseMessage[];

    const lastAiMessage = messages
      .filter((msg) => AIMessage.isInstance(msg))
      .at(-1);

    if (!lastAiMessage) continue;

    actualToolCalls.push(
      ...(lastAiMessage.tool_calls ?? []).map((toolCall) => ({
        name: toolCall.name,
        args: toolCall.args,
        model: lastAiMessage.response_metadata?.model_name || undefined,
      }))
    );
  }

  expect(actualToolCalls).toMatchObject(expectedToolCalls);
}

describe("Subagent Middleware Integration Tests", () => {
  it.concurrent(
    "should invoke general-purpose subagent",
    { timeout: 60000 },
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "Use the general-purpose subagent to get the weather in a city.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [getWeather] as any,
          }),
        ],
      });

      // Check that task tool is available
      const tools = extractToolsFromAgent(agent);
      expect(tools.task).toBeDefined();

      const response = await agent.invoke({
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });

      const toolCalls = extractAllToolCalls(response);
      const taskCall = toolCalls.find((tc) => tc.name === "task");

      expect(taskCall).toBeDefined();
      expect(taskCall!.args.subagent_type).toBe("general-purpose");
    }
  );

  it.concurrent(
    "should invoke defined subagent",
    { timeout: 60000 },
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call a subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather",
                description: "This subagent can get weather in cities.",
                systemPrompt:
                  "Use the get_weather tool to get the weather in a city.",
                tools: [getWeather],
              },
            ],
          }),
        ],
      });

      // Check that task tool is available
      const tools = extractToolsFromAgent(agent);
      expect(tools.task).toBeDefined();

      const response = await agent.invoke({
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });

      const toolCalls = extractAllToolCalls(response);
      const taskCall = toolCalls.find((tc) => tc.name === "task");

      expect(taskCall).toBeDefined();
      expect(taskCall!.args.subagent_type).toBe("weather");
    }
  );

  it.concurrent(
    "should make tool calls within subagent",
    { timeout: 60000 },
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call a subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather",
                description: "This subagent can get weather in cities.",
                systemPrompt:
                  "Use the get_weather tool to get the weather in a city.",
                tools: [getWeather],
              },
            ],
          }),
        ],
      });

      const expectedToolCalls = [
        { name: "task", args: { subagent_type: "weather" } },
        { name: "get_weather" },
      ];

      await assertExpectedSubgraphActions(expectedToolCalls, agent, {
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });
    }
  );

  it.concurrent(
    "should use custom model in subagent",
    { timeout: 60000 },
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call a subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather",
                description: "This subagent can get weather in cities.",
                systemPrompt:
                  "Use the get_weather tool to get the weather in a city.",
                tools: [getWeather],
                model: "gpt-4.1", // Custom model for subagent
              },
            ],
          }),
        ],
      });

      const expectedToolCalls = [
        { name: "task", args: { subagent_type: "weather" } },
        { name: "get_weather" },
      ];

      await assertExpectedSubgraphActions(expectedToolCalls, agent, {
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });
    }
  );

  it.concurrent(
    "should use custom middleware in subagent",
    { timeout: 60000 },
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call a subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather",
                description: "This subagent can get weather in cities.",
                systemPrompt:
                  "Use the get_weather tool to get the weather in a city.",
                tools: [], // No tools directly, only via middleware
                model: "gpt-4.1",
                middleware: [WeatherToolMiddleware],
              },
            ],
          }),
        ],
      });

      const expectedToolCalls = [
        { name: "task", args: { subagent_type: "weather" } },
        { name: "get_weather" },
      ];

      await assertExpectedSubgraphActions(expectedToolCalls, agent, {
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });
    }
  );

  it.concurrent(
    "should handle multiple subagents without middleware accumulation",
    { timeout: 120000 },
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call subagents.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather",
                description: "Get weather information",
                systemPrompt: "Use get_weather tool",
                tools: [getWeather],
              },
              {
                name: "soccer",
                description: "Get soccer scores",
                systemPrompt: "Use get_soccer_scores tool",
                tools: [getSoccerScores],
              },
            ],
          }),
        ],
      });

      // Verify both subagents work independently
      const response1 = await agent.invoke({
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });

      const toolCalls1 = extractAllToolCalls(response1);
      const taskCall1 = toolCalls1.find((tc) => tc.name === "task");
      expect(taskCall1?.args.subagent_type).toBe("weather");

      const response2 = await agent.invoke({
        messages: [
          new HumanMessage("What are the latest scores for Manchester United?"),
        ],
      });

      const toolCalls2 = extractAllToolCalls(response2);
      const taskCall2 = toolCalls2.find((tc) => tc.name === "task");
      expect(taskCall2?.args.subagent_type).toBe("soccer");
    }
  );
});
