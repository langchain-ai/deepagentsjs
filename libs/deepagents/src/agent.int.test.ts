import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createDeepAgent } from "./index.js";
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

      const agentMessages = result.messages.filter((msg: any) =>
        AIMessage.isInstance(msg),
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || [],
      );

      expect(
        toolCalls.some(
          (tc: any) =>
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

      const agentMessages = result.messages.filter((msg: any) =>
        AIMessage.isInstance(msg),
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || [],
      );

      expect(
        toolCalls.some(
          (tc: any) =>
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

      const agentMessages = result.messages.filter((msg: any) =>
        AIMessage.isInstance(msg),
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || [],
      );

      expect(
        toolCalls.some(
          (tc: any) =>
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

      const agentMessages = result.messages.filter((msg: any) =>
        AIMessage.isInstance(msg),
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || [],
      );

      expect(
        toolCalls.some(
          (tc: any) =>
            tc.name === "task" && tc.args?.subagent_type === "weather_agent",
        ),
      ).toBe(true);
      expect(
        toolCalls.some(
          (tc: any) =>
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

      const agentMessages = result.messages.filter((msg: any) =>
        AIMessage.isInstance(msg),
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || [],
      );

      expect(
        toolCalls.some(
          (tc: any) =>
            tc.name === "task" &&
            tc.args?.subagent_type === "basketball_info_agent",
        ),
      ).toBe(true);
      expect(result.research).toContain(TOY_BASKETBALL_RESEARCH);
    },
  );

  it.concurrent(
    "should handle complex multi-turn workflow with files, todos, and subagents",
    { timeout: 120 * 1000 }, // 120s
    async () => {
      const subagents = [
        {
          name: "code_reviewer",
          description: "Reviews code and provides feedback",
          systemPrompt: "You are a code reviewer. Analyze code quality.",
          tools: [sampleTool],
          model: SAMPLE_MODEL,
        },
      ];
      const agent = createDeepAgent({
        middleware: [ResearchMiddleware],
        subagents,
      });
      assertAllDeepAgentQualities(agent);

      const result1 = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Create a file called app.js with the content 'console.log(\"Hello\");' and " +
                "create a todo list with tasks: 'Write code' (completed), 'Review code' (in_progress), 'Deploy' (pending)",
            ),
          ],
        },
        { recursionLimit: 100 },
      );

      expect((result1 as any).files).toHaveProperty("/app.js");
      expect((result1 as any).files["/app.js"].content.join()).toContain("Hello");

      expect(result1.todos.length).toBeGreaterThanOrEqual(3);
      const todoStatuses = result1.todos.map((t: any) => t.status);
      expect(todoStatuses).toContain("completed");
      expect(todoStatuses).toContain("in_progress");
      expect(todoStatuses).toContain("pending");

      const result2 = await agent.invoke(
        {
          messages: [
            ...result1.messages,
            new HumanMessage(
              "Use the code_reviewer subagent to review the app.js file. " +
                "Also save this research note: 'Project uses Node.js'",
            ),
          ],
        },
        { recursionLimit: 100 },
      );

      const agentMessages = result2.messages.filter((msg: any) =>
        AIMessage.isInstance(msg),
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || [],
      );
      expect(
        toolCalls.some(
          (tc: any) =>
            tc.name === "task" && tc.args?.subagent_type === "code_reviewer",
        ),
      ).toBe(true);

      expect((result2 as any).files).toHaveProperty("/app.js");

      expect((result2 as any).research).toContain("Node.js");

      expect(result2.todos.length).toBeGreaterThanOrEqual(3);

      expect(result2.messages.length).toBeGreaterThan(result1.messages.length);
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

      const agentMessages = result.messages.filter((msg: any) =>
        AIMessage.isInstance(msg),
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || [],
      );

      expect(
        toolCalls.some(
          (tc: any) =>
            tc.name === "task" &&
            tc.args?.subagent_type === "basketball_info_agent",
        ),
      ).toBe(true);
    },
  );

  // Note: response_format with ToolStrategy is not yet available in LangChain TS v1
  // Skipping test_response_format_tool_strategy for now
});
