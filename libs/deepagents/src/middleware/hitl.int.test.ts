import { describe, it, expect } from "vitest";
import { v4 as uuidv4 } from "uuid";

import { MemorySaver, Command } from "@langchain/langgraph";
import {
  AIMessage,
  HITLRequest,
  HumanMessage,
  ToolMessage,
  type InterruptOnConfig,
} from "langchain";

import { createDeepAgent } from "../index.js";
import {
  assertAllDeepAgentQualities,
  sampleTool,
  getWeather,
  getSoccerScores,
} from "../testing/utils.js";

const SAMPLE_TOOL_CONFIG: Record<string, boolean | InterruptOnConfig> = {
  sample_tool: true,
  get_weather: false,
  get_soccer_scores: { allowedDecisions: ["approve", "reject"] },
};

describe("Human-in-the-Loop (HITL) Integration Tests", () => {
  it.concurrent(
    "should interrupt agent execution for tool approval",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        tools: [sampleTool, getWeather, getSoccerScores],
        interruptOn: SAMPLE_TOOL_CONFIG,
        checkpointer,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      assertAllDeepAgentQualities(agent);

      // First invocation - should interrupt
      const result = await agent.invoke(
        {
          messages: [
            {
              role: "user",
              content:
                "Call the sample tool, get the weather in New York and get scores for the latest soccer games in parallel",
            },
          ],
        },
        config,
      );

      // Check tool calls were made
      const agentMessages = result.messages.filter((msg: any) =>
        AIMessage.isInstance(msg),
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || [],
      );

      expect(toolCalls.some((tc: any) => tc.name === "sample_tool")).toBe(true);
      expect(toolCalls.some((tc: any) => tc.name === "get_weather")).toBe(true);
      expect(toolCalls.some((tc: any) => tc.name === "get_soccer_scores")).toBe(
        true,
      );

      // Check interrupts
      expect(result.__interrupt__).toBeDefined();
      expect(result.__interrupt__).toHaveLength(1);

      const interrupts = result.__interrupt__?.[0].value as HITLRequest;
      const actionRequests = interrupts.actionRequests;

      expect(actionRequests).toHaveLength(2);
      expect(actionRequests.some((ar: any) => ar.name === "sample_tool")).toBe(
        true,
      );
      expect(
        actionRequests.some((ar: any) => ar.name === "get_soccer_scores"),
      ).toBe(true);

      // Check review configs
      const reviewConfigs = interrupts.reviewConfigs;
      expect(
        reviewConfigs.some(
          (rc) =>
            rc.actionName === "sample_tool" &&
            rc.allowedDecisions.includes("approve") &&
            rc.allowedDecisions.includes("edit") &&
            rc.allowedDecisions.includes("reject"),
        ),
      ).toBe(true);
      expect(
        reviewConfigs.some(
          (rc) =>
            rc.actionName === "get_soccer_scores" &&
            rc.allowedDecisions.includes("approve") &&
            rc.allowedDecisions.includes("reject"),
        ),
      ).toBe(true);

      // Resume with approvals
      const result2 = await agent.invoke(
        new Command({
          resume: {
            decisions: [{ type: "approve" }, { type: "approve" }],
          },
        }),
        config,
      );

      // Check tool results are present
      const toolResults = result2.messages.filter(
        (msg: any) => msg._getType() === "tool",
      );
      expect(toolResults.some((tr: any) => tr.name === "sample_tool")).toBe(
        true,
      );
      expect(toolResults.some((tr: any) => tr.name === "get_weather")).toBe(
        true,
      );
      expect(
        toolResults.some((tr: any) => tr.name === "get_soccer_scores"),
      ).toBe(true);

      // No more interrupts
      expect(result2.__interrupt__).toBeUndefined();
    },
  );

  it.concurrent(
    "should handle HITL with subagents",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        tools: [sampleTool, getWeather, getSoccerScores],
        interruptOn: SAMPLE_TOOL_CONFIG,
        checkpointer,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      assertAllDeepAgentQualities(agent);

      // First invocation - use subagent which should also interrupt
      const result = await agent.invoke(
        {
          messages: [
            {
              role: "user",
              content:
                "Use the task tool to kick off the general-purpose subagent. Tell it to call the sample tool, get the weather in New York and get scores for the latest soccer games in parallel",
            },
          ],
        },
        config,
      );

      // Check that task tool was called
      const agentMessages = result.messages.filter(
        (msg: any) => msg._getType() === "ai",
      );
      const toolCalls = agentMessages.flatMap(
        (msg: any) => msg.tool_calls || [],
      );
      expect(toolCalls.some((tc: any) => tc.name === "task")).toBe(true);

      // Subagent should have interrupts too
      expect(result.__interrupt__).toBeDefined();

      // Resume with approvals
      const toolResultNames: string[] = [];

      for await (const chunk of await agent.graph.stream(
        new Command({
          resume: { decisions: [{ type: "approve" }, { type: "approve" }] },
        }),
        {
          ...config,
          streamMode: ["updates"],
          subgraphs: true,
        },
      )) {
        const update = chunk[2] ?? {};
        if (!("tools" in update)) continue;

        const tools = update.tools as { messages: ToolMessage[] };
        toolResultNames.push(...tools.messages.map((msg: any) => msg.name));
      }

      expect(toolResultNames).toContain("sample_tool");
      expect(toolResultNames).toContain("get_weather");
      expect(toolResultNames).toContain("get_soccer_scores");
    },
  );

  it.concurrent(
    "should use custom interrupt_on config for subagents",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        tools: [sampleTool, getWeather, getSoccerScores],
        interruptOn: SAMPLE_TOOL_CONFIG,
        checkpointer,
        subagents: [
          {
            name: "custom_weather_agent",
            description: "Agent that gets weather with custom interrupt config",
            systemPrompt: "Use get_weather tool to get weather information",
            tools: [getWeather],
            // Different config for subagent
            interruptOn: { get_weather: true },
          },
        ],
      });

      const config = { configurable: { thread_id: uuidv4() } };
      const result = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use the custom_weather_agent subagent to get weather in Tokyo",
            ),
          ],
        },
        config,
      );

      // Check that task tool was called
      expect(
        result.messages
          .filter((msg: any) => AIMessage.isInstance(msg))
          .flatMap((msg: any) => msg.tool_calls || []),
      ).toMatchObject([
        { name: "task", args: { subagent_type: "custom_weather_agent" } },
      ]);

      // Subagent should have different interrupt config
      // The get_weather tool should now trigger an interrupt in the subagent
      expect(result.__interrupt__).toBeDefined();

      await agent.invoke(
        new Command({
          resume: {
            decisions: [{ type: "approve" }],
          },
        }),
        config,
      );
      expect(result.messages.length).toBeGreaterThan(0);
    },
  );
});
