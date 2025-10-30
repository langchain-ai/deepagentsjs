import { describe, it, expect } from "vitest";
import { createAgent, createMiddleware } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { createSubAgentMiddleware } from "../../src/index.js";
import { SAMPLE_MODEL, getWeather, getSoccerScores } from "../utils.js";

const WeatherToolMiddleware = createMiddleware({
  name: "weatherToolMiddleware",
  tools: [getWeather],
});

/**
 * Helper to extract all tool calls from agent response
 */
function extractToolCalls(
  response: any
): Array<{ name: string; args: Record<string, any> }> {
  const messages = response.messages || [];
  const aiMessages = messages.filter((msg: any) => msg._getType() === "ai");
  return aiMessages.flatMap((msg: any) => msg.tool_calls || []);
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
  agent: any,
  input: any
) {
  const response = await agent.invoke(input);
  const actualToolCalls = extractToolCalls(response);

  for (const expected of expectedToolCalls) {
    const found = actualToolCalls.some((actual: any) => {
      if (actual.name !== expected.name) return false;
      if (expected.args) {
        // Check if expected args are present in actual args
        for (const [key, value] of Object.entries(expected.args)) {
          if (actual.args[key] !== value) return false;
        }
      }
      return true;
    });
    expect(found).toBe(true);
  }
}

describe("Subagent Middleware Integration Tests", () => {
  it("should invoke general-purpose subagent", { timeout: 60000 }, async () => {
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
    const toolsNode = (agent as any).nodes?.tools;
    const tools = toolsNode?.bound?._tools_by_name || toolsNode?._tools_by_name;
    expect(tools.task).toBeDefined();

    const response = await agent.invoke({
      messages: [new HumanMessage("What is the weather in Tokyo?")],
    });

    const toolCalls = extractToolCalls(response);
    const taskCall = toolCalls.find((tc) => tc.name === "task");

    expect(taskCall).toBeDefined();
    expect(taskCall!.args.subagent_type).toBe("general-purpose");
  });

  it("should invoke defined subagent", { timeout: 60000 }, async () => {
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
    const toolsNode = (agent as any).nodes?.tools;
    const tools = toolsNode?.bound?._tools_by_name || toolsNode?._tools_by_name;
    expect(tools.task).toBeDefined();

    const response = await agent.invoke({
      messages: [new HumanMessage("What is the weather in Tokyo?")],
    });

    const toolCalls = extractToolCalls(response);
    const taskCall = toolCalls.find((tc) => tc.name === "task");

    expect(taskCall).toBeDefined();
    expect(taskCall!.args.subagent_type).toBe("weather");
  });

  it("should make tool calls within subagent", { timeout: 60000 }, async () => {
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
  });

  it("should use custom model in subagent", { timeout: 60000 }, async () => {
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
      {
        name: "task",
        args: { subagent_type: "weather" },
      },
      { name: "get_weather" },
    ];

    await assertExpectedSubgraphActions(expectedToolCalls, agent, {
      messages: [new HumanMessage("What is the weather in Tokyo?")],
    });
  });

  it(
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

  it(
    "should use custom runnable for subagent",
    { timeout: 60000 },
    async () => {
      // Create a pre-compiled subagent
      const weatherAgent = createAgent({
        model: SAMPLE_MODEL,
        tools: [getSoccerScores] as any,
        systemPrompt: "Use the get_soccer_scores tool to get soccer scores.",
      });

      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call a subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "soccer",
                description: "This subagent can get soccer scores.",
                runnable: weatherAgent,
              } as any, // Type assertion for CompiledSubAgent
            ],
          }),
        ],
      });

      const expectedToolCalls = [
        { name: "task", args: { subagent_type: "soccer" } },
        { name: "get_soccer_scores" },
      ];

      await assertExpectedSubgraphActions(expectedToolCalls, agent, {
        messages: [
          new HumanMessage("What are the latest scores for Manchester United?"),
        ],
      });
    }
  );

  it(
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

      const toolCalls1 = extractToolCalls(response1);
      const taskCall1 = toolCalls1.find((tc) => tc.name === "task");
      expect(taskCall1?.args.subagent_type).toBe("weather");

      const response2 = await agent.invoke({
        messages: [
          new HumanMessage("What are the latest scores for Manchester United?"),
        ],
      });

      const toolCalls2 = extractToolCalls(response2);
      const taskCall2 = toolCalls2.find((tc) => tc.name === "task");
      expect(taskCall2?.args.subagent_type).toBe("soccer");
    }
  );
});
