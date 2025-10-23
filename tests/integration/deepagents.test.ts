import { describe, it, expect } from "vitest";
import { createAgent } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { createDeepAgent } from "../../src/index.js";
import {
  SAMPLE_MODEL,
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
} from "../utils.js";

describe("DeepAgents Integration Tests", () => {
  it("should create a base deep agent", () => {
    const agent = createDeepAgent();
    assertAllDeepAgentQualities(agent);
  });

  it("should create deep agent with tool", () => {
    const agent = createDeepAgent({ tools: [sampleTool] });
    assertAllDeepAgentQualities(agent);

    const toolsNode = (agent as any).nodes?.tools;
    const toolNames = Object.keys(
      toolsNode?.bound?._tools_by_name || toolsNode?._tools_by_name || {}
    );
    expect(toolNames).toContain("sample_tool");
  });

  it("should create deep agent with middleware with tool", () => {
    const agent = createDeepAgent({ middleware: [SampleMiddlewareWithTools] });
    assertAllDeepAgentQualities(agent);

    const toolsNode = (agent as any).nodes?.tools;
    const toolNames = Object.keys(
      toolsNode?.bound?._tools_by_name || toolsNode?._tools_by_name || {}
    );
    expect(toolNames).toContain("sample_tool");
  });

  it("should create deep agent with middleware with tool and state", () => {
    const agent = createDeepAgent({
      middleware: [SampleMiddlewareWithToolsAndState],
    });
    assertAllDeepAgentQualities(agent);

    const toolsNode = (agent as any).nodes?.tools;
    const toolNames = Object.keys(
      toolsNode?.bound?._tools_by_name || toolsNode?._tools_by_name || {}
    );
    expect(toolNames).toContain("sample_tool");

    const streamChannels = Object.keys((agent as any).streamChannels || {});
    expect(streamChannels).toContain("sample_input");
  });

  it(
    "should create deep agent with subagents",
    { timeout: 60000 },
    async () => {
      const subagents = [
        {
          name: "weather_agent",
          description: "Use this agent to get the weather",
          system_prompt: "You are a weather agent.",
          tools: [getWeather],
          model: SAMPLE_MODEL,
        },
      ];
      const agent = createDeepAgent({ tools: [sampleTool], subagents });
      assertAllDeepAgentQualities(agent);

      const result = await agent.invoke({
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });

      const agentMessages = result.messages.filter(
        (msg: any) => msg._getType() === "ai"
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || []
      );

      expect(
        toolCalls.some(
          (tc: any) =>
            tc.name === "task" && tc.args?.subagent_type === "weather_agent"
        )
      ).toBe(true);
    }
  );

  it(
    "should create deep agent with subagents and general purpose",
    { timeout: 60000 },
    async () => {
      const subagents = [
        {
          name: "weather_agent",
          description: "Use this agent to get the weather",
          system_prompt: "You are a weather agent.",
          tools: [getWeather],
          model: SAMPLE_MODEL,
        },
      ];
      const agent = createDeepAgent({ tools: [sampleTool], subagents });
      assertAllDeepAgentQualities(agent);

      const result = await agent.invoke({
        messages: [
          new HumanMessage(
            "Use the general purpose subagent to call the sample tool"
          ),
        ],
      });

      const agentMessages = result.messages.filter(
        (msg: any) => msg._getType() === "ai"
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || []
      );

      expect(
        toolCalls.some(
          (tc: any) =>
            tc.name === "task" && tc.args?.subagent_type === "general-purpose"
        )
      ).toBe(true);
    }
  );

  it(
    "should create deep agent with subagents with middleware",
    { timeout: 60000 },
    async () => {
      const subagents = [
        {
          name: "weather_agent",
          description: "Use this agent to get the weather",
          system_prompt: "You are a weather agent.",
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

      const agentMessages = result.messages.filter(
        (msg: any) => msg._getType() === "ai"
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || []
      );

      expect(
        toolCalls.some(
          (tc: any) =>
            tc.name === "task" && tc.args?.subagent_type === "weather_agent"
        )
      ).toBe(true);
    }
  );

  it(
    "should create deep agent with custom subagents",
    { timeout: 60000 },
    async () => {
      const subagents = [
        {
          name: "weather_agent",
          description: "Use this agent to get the weather",
          system_prompt: "You are a weather agent.",
          tools: [getWeather],
          model: SAMPLE_MODEL,
        },
        {
          name: "soccer_agent",
          description: "Use this agent to get the latest soccer scores",
          runnable: createAgent({
            model: SAMPLE_MODEL,
            tools: [getSoccerScores] as any,
            systemPrompt: "You are a soccer agent.",
          }),
        },
      ];
      const agent = createDeepAgent({ tools: [sampleTool], subagents });
      assertAllDeepAgentQualities(agent);

      const result = await agent.invoke({
        messages: [
          new HumanMessage(
            "Look up the weather in Tokyo, and the latest scores for Manchester City!"
          ),
        ],
      });

      const agentMessages = result.messages.filter(
        (msg: any) => msg._getType() === "ai"
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || []
      );

      expect(
        toolCalls.some(
          (tc: any) =>
            tc.name === "task" && tc.args?.subagent_type === "weather_agent"
        )
      ).toBe(true);
      expect(
        toolCalls.some(
          (tc: any) =>
            tc.name === "task" && tc.args?.subagent_type === "soccer_agent"
        )
      ).toBe(true);
    }
  );

  it(
    "should create deep agent with extended state and subagents",
    { timeout: 60000 },
    async () => {
      const subagents = [
        {
          name: "basketball_info_agent",
          description:
            "Use this agent to get surface level info on any basketball topic",
          system_prompt: "You are a basketball info agent.",
          middleware: [ResearchMiddlewareWithTools],
        },
      ];
      const agent = createDeepAgent({
        tools: [sampleTool],
        subagents,
        middleware: [ResearchMiddleware],
      });
      assertAllDeepAgentQualities(agent);

      const streamChannels = Object.keys((agent as any).streamChannels || {});
      expect(streamChannels).toContain("research");

      const result = await agent.invoke(
        {
          messages: [
            new HumanMessage("Get surface level info on lebron james"),
          ],
        },
        { recursionLimit: 100 }
      );

      const agentMessages = result.messages.filter(
        (msg: any) => msg._getType() === "ai"
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || []
      );

      expect(
        toolCalls.some(
          (tc: any) =>
            tc.name === "task" &&
            tc.args?.subagent_type === "basketball_info_agent"
        )
      ).toBe(true);
      expect(result.research).toContain(TOY_BASKETBALL_RESEARCH);
    }
  );

  it(
    "should create deep agent with subagents no tools",
    { timeout: 60000 },
    async () => {
      const subagents = [
        {
          name: "basketball_info_agent",
          description:
            "Use this agent to get surface level info on any basketball topic",
          system_prompt: "You are a basketball info agent.",
        },
      ];
      const agent = createDeepAgent({ tools: [sampleTool], subagents });
      assertAllDeepAgentQualities(agent);

      const result = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use the basketball info subagent to call the sample tool"
            ),
          ],
        },
        { recursionLimit: 100 }
      );

      const agentMessages = result.messages.filter(
        (msg: any) => msg._getType() === "ai"
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || []
      );

      expect(
        toolCalls.some(
          (tc: any) =>
            tc.name === "task" &&
            tc.args?.subagent_type === "basketball_info_agent"
        )
      ).toBe(true);
    }
  );

  // Note: response_format with ToolStrategy is not yet available in LangChain TS v1
  // Skipping test_response_format_tool_strategy for now
});
