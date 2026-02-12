import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { toolStrategy, providerStrategy } from "langchain";
import { z } from "zod/v4";
import { createDeepAgent } from "./index.js";
import type { CompiledSubAgent } from "./index.js";
import {
  SAMPLE_MODEL,
  SAMPLE_MODEL_WITH_STRUCTURED_RESPONSE,
  TOY_BASKETBALL_RESEARCH,
  ResearchMiddleware,
  ResearchMiddlewareWithTools,
  SampleMiddlewareWithTools,
  SampleMiddlewareWithToolsAndState,
  WeatherToolMiddleware,
  assertAllDeepAgentQualities,
  getSoccerScores,
  getWeather,
  sampleTool,
  extractToolsFromAgent,
} from "./testing/utils.js";

describe("DeepAgents Integration Tests", () => {
  it.concurrent("should create a base deep agent", () => {
    const agent = createDeepAgent();
    assertAllDeepAgentQualities(agent);
  });

  it.concurrent("should create deep agent with tool", () => {
    const agent = createDeepAgent({ tools: [sampleTool] });
    assertAllDeepAgentQualities(agent);

    const toolNames = Object.keys(extractToolsFromAgent(agent));
    expect(toolNames).toContain("sample_tool");
  });

  it.concurrent("should create deep agent with middleware with tool", () => {
    const agent = createDeepAgent({ middleware: [SampleMiddlewareWithTools] });
    assertAllDeepAgentQualities(agent);

    const toolNames = Object.keys(extractToolsFromAgent(agent));
    expect(toolNames).toContain("sample_tool");
  });

  it.concurrent(
    "should create deep agent with middleware with tool and state",
    () => {
      const agent = createDeepAgent({
        middleware: [SampleMiddlewareWithToolsAndState],
      });
      assertAllDeepAgentQualities(agent);

      const toolNames = Object.keys(extractToolsFromAgent(agent));
      expect(toolNames).toContain("sample_tool");

      expect(agent.graph.streamChannels).toContain("sample_input");
    },
  );

  it.concurrent(
    "should create deep agent with subagents",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const subagents = [
        {
          name: "weather_agent",
          description: "Use this agent to get the weather",
          systemPrompt: "You are a weather agent.",
          tools: [getWeather],
          model: SAMPLE_MODEL,
        },
      ];
      const agent = createDeepAgent({ tools: [sampleTool], subagents });
      assertAllDeepAgentQualities(agent);

      const result = await agent.invoke({
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });

      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);

      expect(
        toolCalls.some(
          (tc) =>
            tc.name === "task" && tc.args?.subagent_type === "weather_agent",
        ),
      ).toBe(true);
    },
  );

  it.concurrent(
    "should create deep agent with subagents and general purpose",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const subagents = [
        {
          name: "weather_agent",
          description: "Use this agent to get the weather",
          systemPrompt: "You are a weather agent.",
          tools: [getWeather],
          model: SAMPLE_MODEL,
        },
      ];
      const agent = createDeepAgent({ tools: [sampleTool], subagents });
      assertAllDeepAgentQualities(agent);

      const result = await agent.invoke({
        messages: [
          new HumanMessage(
            "Use the general purpose subagent to call the sample tool",
          ),
        ],
      });

      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);

      expect(
        toolCalls.some(
          (tc) =>
            tc.name === "task" && tc.args?.subagent_type === "general-purpose",
        ),
      ).toBe(true);
    },
  );

  it.concurrent(
    "should create deep agent with subagents with middleware",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const subagents = [
        {
          name: "weather_agent",
          description: "Use this agent to get the weather",
          systemPrompt: "You are a weather agent.",
          tools: [],
          model: SAMPLE_MODEL,
          middleware: [WeatherToolMiddleware],
        },
      ];
      const agent = createDeepAgent({ tools: [sampleTool], subagents });
      assertAllDeepAgentQualities(agent);

      const result = await agent.invoke({
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });

      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);

      expect(
        toolCalls.some(
          (tc) =>
            tc.name === "task" && tc.args?.subagent_type === "weather_agent",
        ),
      ).toBe(true);
    },
  );

  it.concurrent(
    "should create deep agent with custom subagents",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const agent = createDeepAgent({
        tools: [sampleTool],
        subagents: [
          {
            name: "weather_agent",
            description: "Use this agent to get the weather",
            systemPrompt: "You are a weather agent.",
            tools: [getWeather],
            model: SAMPLE_MODEL,
          },
          {
            name: "soccer_agent",
            description: "Use this agent to get the latest soccer scores",
            tools: [getSoccerScores],
            model: SAMPLE_MODEL,
            systemPrompt: "You are a soccer agent.",
          },
        ],
      });
      assertAllDeepAgentQualities(agent);

      const result = await agent.invoke({
        messages: [
          new HumanMessage(
            "Look up the weather in Tokyo, and the latest scores for Manchester City!",
          ),
        ],
      });

      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);

      expect(
        toolCalls.some(
          (tc) =>
            tc.name === "task" && tc.args?.subagent_type === "weather_agent",
        ),
      ).toBe(true);
      expect(
        toolCalls.some(
          (tc) =>
            tc.name === "task" && tc.args?.subagent_type === "soccer_agent",
        ),
      ).toBe(true);
    },
  );

  it.concurrent(
    "should create deep agent with extended state and subagents",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const subagents = [
        {
          name: "basketball_info_agent",
          description:
            "Use this agent to get surface level info on any basketball topic",
          systemPrompt: "You are a basketball info agent.",
          middleware: [ResearchMiddlewareWithTools],
        },
      ];
      const agent = createDeepAgent({
        tools: [sampleTool],
        subagents,
        middleware: [ResearchMiddleware],
      });
      assertAllDeepAgentQualities(agent);
      expect(agent.graph.streamChannels).toContain("research");

      const result = await agent.invoke(
        {
          messages: [
            new HumanMessage("Get surface level info on lebron james"),
          ],
        },
        { recursionLimit: 100 },
      );

      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);

      expect(
        toolCalls.some(
          (tc) =>
            tc.name === "task" &&
            tc.args?.subagent_type === "basketball_info_agent",
        ),
      ).toBe(true);
      expect(result.research).toContain(TOY_BASKETBALL_RESEARCH);
    },
  );

  it.concurrent(
    "should create deep agent with subagents no tools",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const subagents = [
        {
          name: "basketball_info_agent",
          description:
            "Use this agent to get surface level info on any basketball topic",
          systemPrompt: "You are a basketball info agent.",
        },
      ];
      const agent = createDeepAgent({ tools: [sampleTool], subagents });
      assertAllDeepAgentQualities(agent);

      const result = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use the basketball info subagent to call the sample tool",
            ),
          ],
        },
        { recursionLimit: 100 },
      );

      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);

      expect(
        toolCalls.some(
          (tc) =>
            tc.name === "task" &&
            tc.args?.subagent_type === "basketball_info_agent",
        ),
      ).toBe(true);
    },
  );

  it.concurrent(
    "should use a deep agent as a compiled subagent (agent-as-subagent hierarchy)",
    { timeout: 120 * 1000 }, // 120s
    async () => {
      // Create a deep agent that will serve as a subagent
      const weatherDeepAgent = createDeepAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "You are a weather specialist. Use the get_weather tool to get weather information for any location requested.",
        tools: [getWeather],
      });

      // Use the deep agent as a CompiledSubAgent in the parent
      const parentAgent = createDeepAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "You are an orchestrator. Delegate weather queries to the weather-specialist subagent via the task tool.",
        subagents: [
          {
            name: "weather-specialist",
            description:
              "A specialized weather agent that can provide detailed weather information for any city.",
            runnable: weatherDeepAgent,
          } satisfies CompiledSubAgent,
        ],
      });
      assertAllDeepAgentQualities(parentAgent);

      // Verify the task tool lists the weather-specialist subagent
      const tools = extractToolsFromAgent(parentAgent);
      expect(tools.task).toBeDefined();
      expect(tools.task.description).toContain("weather-specialist");

      // Invoke and verify the parent delegates to the weather-specialist
      const result = await parentAgent.invoke(
        {
          messages: [new HumanMessage("What is the weather in Tokyo?")],
        },
        { recursionLimit: 100 },
      );

      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);

      expect(
        toolCalls.some(
          (tc) =>
            tc.name === "task" &&
            tc.args?.subagent_type === "weather-specialist",
        ),
      ).toBe(true);
    },
  );

  it.concurrent(
    "should support multi-level deep agent hierarchy (nested deep agents)",
    { timeout: 120 * 1000 }, // 120s
    async () => {
      // Level 2: A deep agent with its own subagents
      const innerDeepAgent = createDeepAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "You are a sports information agent. Use the get_soccer_scores tool to get soccer scores.",
        tools: [getSoccerScores],
        subagents: [
          {
            name: "weather-helper",
            description: "Gets weather information for match day conditions.",
            systemPrompt:
              "Use the get_weather tool to get weather information.",
            tools: [getWeather],
            model: SAMPLE_MODEL,
          },
        ],
      });

      // Level 1: Parent deep agent using the inner deep agent as a subagent
      const parentAgent = createDeepAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "You are an orchestrator. Use the sports-info subagent for any sports related questions.",
        tools: [sampleTool],
        subagents: [
          {
            name: "sports-info",
            description:
              "A specialized sports agent that can get soccer scores and check match day weather.",
            runnable: innerDeepAgent,
          } satisfies CompiledSubAgent,
        ],
      });
      assertAllDeepAgentQualities(parentAgent);

      const result = await parentAgent.invoke(
        {
          messages: [
            new HumanMessage(
              "What are the latest scores for Manchester United?",
            ),
          ],
        },
        { recursionLimit: 100 },
      );

      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);

      expect(
        toolCalls.some(
          (tc) =>
            tc.name === "task" && tc.args?.subagent_type === "sports-info",
        ),
      ).toBe(true);
    },
  );

  describe.each([
    {
      strategyName: "toolStrategy",
      wrap: (s: z.ZodObject<any>) => toolStrategy(s),
    },
    {
      strategyName: "providerStrategy",
      wrap: (s: z.ZodObject<any>) => providerStrategy(s),
    },
  ])("responseFormat ($strategyName)", ({ strategyName, wrap }) => {
    it.concurrent(
      "should return structuredResponse with Zod schema",
      { timeout: 120 * 1000 },
      async () => {
        const WeatherSchema = z.object({
          location: z.string().describe("The location queried"),
          temperature: z.string().describe("The temperature"),
          conditions: z.string().describe("Weather conditions summary"),
        });

        const model =
          strategyName === "providerStrategy"
            ? SAMPLE_MODEL_WITH_STRUCTURED_RESPONSE
            : SAMPLE_MODEL;
        const agent = createDeepAgent({
          model,
          tools: [getWeather],
          systemPrompt:
            "You are a weather assistant. When asked about the weather, use the get_weather tool to get the information, then return a structured response with the location, temperature, and conditions.",
          responseFormat: wrap(WeatherSchema),
        });

        const result = await agent.invoke({
          messages: [new HumanMessage("What is the weather in San Francisco?")],
        });

        expect(result.structuredResponse).toBeDefined();
        expect(result.structuredResponse).toHaveProperty("location");
        expect(result.structuredResponse).toHaveProperty("temperature");
        expect(result.structuredResponse).toHaveProperty("conditions");
        expect(typeof result.structuredResponse.location).toBe("string");
        expect(typeof result.structuredResponse.temperature).toBe("string");
        expect(typeof result.structuredResponse.conditions).toBe("string");
      },
    );

    it.concurrent(
      "should return structuredResponse with tools",
      { timeout: 120 * 1000 },
      async () => {
        const WeatherReportSchema = z.object({
          city: z.string().describe("The city name"),
          weather_summary: z
            .string()
            .describe("A summary of the weather conditions"),
          is_sunny: z.boolean().describe("Whether the weather is sunny"),
        });

        const model =
          strategyName === "providerStrategy"
            ? SAMPLE_MODEL_WITH_STRUCTURED_RESPONSE
            : SAMPLE_MODEL;
        const agent = createDeepAgent({
          model,
          tools: [getWeather],
          systemPrompt:
            "You are a weather assistant. Use the get_weather tool to look up the weather, then provide a structured weather report.",
          responseFormat: wrap(WeatherReportSchema),
        });

        const result = await agent.invoke({
          messages: [new HumanMessage("What's the weather like in Tokyo?")],
        });

        // Verify the weather tool was actually called
        const agentMessages = result.messages.filter(AIMessage.isInstance);
        const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);
        expect(toolCalls.some((tc) => tc.name === "get_weather")).toBe(true);

        // Verify structured response
        expect(result.structuredResponse).toBeDefined();
        expect(result.structuredResponse).toHaveProperty("city");
        expect(result.structuredResponse).toHaveProperty("weather_summary");
        expect(result.structuredResponse).toHaveProperty("is_sunny");
        expect(typeof result.structuredResponse.city).toBe("string");
        expect(typeof result.structuredResponse.weather_summary).toBe("string");
        expect(typeof result.structuredResponse.is_sunny).toBe("boolean");
      },
    );

    it.concurrent(
      "should return structuredResponse with complex nested schema",
      { timeout: 120 * 1000 },
      async () => {
        const AnalysisSchema = z.object({
          topic: z.string().describe("The main topic"),
          key_points: z
            .array(z.string())
            .describe("Key points about the topic"),
          sentiment: z
            .enum(["positive", "negative", "neutral"])
            .describe("Overall sentiment"),
        });

        const model =
          strategyName === "providerStrategy"
            ? SAMPLE_MODEL_WITH_STRUCTURED_RESPONSE
            : SAMPLE_MODEL;
        const agent = createDeepAgent({
          model,
          systemPrompt:
            "You are an analyst. Provide structured analysis of any topic the user asks about.",
          responseFormat: wrap(AnalysisSchema),
        });

        const result = await agent.invoke({
          messages: [
            new HumanMessage(
              "Provide an analysis on the benefits of open source software.",
            ),
          ],
        });

        expect(result.structuredResponse).toBeDefined();
        expect(result.structuredResponse).toHaveProperty("topic");
        expect(result.structuredResponse).toHaveProperty("key_points");
        expect(result.structuredResponse).toHaveProperty("sentiment");
        expect(typeof result.structuredResponse.topic).toBe("string");
        expect(Array.isArray(result.structuredResponse.key_points)).toBe(true);
        expect(
          (result.structuredResponse.key_points as string[]).length,
        ).toBeGreaterThan(0);
        expect(["positive", "negative", "neutral"]).toContain(
          result.structuredResponse.sentiment,
        );
      },
    );

    it.concurrent(
      "should return structuredResponse with subagents",
      { timeout: 120 * 1000 },
      async () => {
        const WeatherResponseSchema = z.object({
          location: z.string().describe("The location queried"),
          summary: z.string().describe("Summary of the weather"),
        });

        const model =
          strategyName === "providerStrategy"
            ? SAMPLE_MODEL_WITH_STRUCTURED_RESPONSE
            : SAMPLE_MODEL;
        const agent = createDeepAgent({
          model,
          systemPrompt:
            "You are an orchestrator. Delegate weather queries to the weather_agent subagent, then return a structured response summarizing the result.",
          responseFormat: wrap(WeatherResponseSchema),
          subagents: [
            {
              name: "weather_agent",
              description: "Use this agent to get the weather for any location",
              systemPrompt:
                "You are a weather agent. Use the get_weather tool to get weather information.",
              tools: [getWeather],
              model: SAMPLE_MODEL,
            },
          ],
        });

        const result = await agent.invoke(
          {
            messages: [new HumanMessage("What is the weather in London?")],
          },
          { recursionLimit: 100 },
        );

        // Verify the subagent was invoked
        const agentMessages = result.messages.filter(AIMessage.isInstance);
        const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);
        expect(
          toolCalls.some(
            (tc) =>
              tc.name === "task" && tc.args?.subagent_type === "weather_agent",
          ),
        ).toBe(true);

        // Verify structured response
        expect(result.structuredResponse).toBeDefined();
        expect(result.structuredResponse).toHaveProperty("location");
        expect(result.structuredResponse).toHaveProperty("summary");
        expect(typeof result.structuredResponse.location).toBe("string");
        expect(typeof result.structuredResponse.summary).toBe("string");
      },
    );
  });
});
