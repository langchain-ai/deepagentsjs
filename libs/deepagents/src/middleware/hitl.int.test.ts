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
      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);

      expect(toolCalls.some((tc) => tc.name === "sample_tool")).toBe(true);
      expect(toolCalls.some((tc) => tc.name === "get_weather")).toBe(true);
      expect(toolCalls.some((tc) => tc.name === "get_soccer_scores")).toBe(
        true,
      );

      // Check interrupts
      expect(result.__interrupt__).toBeDefined();
      expect(result.__interrupt__).toHaveLength(1);

      const interrupts = result.__interrupt__?.[0].value as HITLRequest;
      const actionRequests = interrupts.actionRequests;

      expect(actionRequests).toHaveLength(2);
      expect(actionRequests.some((ar) => ar.name === "sample_tool")).toBe(true);
      expect(actionRequests.some((ar) => ar.name === "get_soccer_scores")).toBe(
        true,
      );

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
      const toolResults = result2.messages.filter(ToolMessage.isInstance);
      expect(toolResults.some((tr) => tr.name === "sample_tool")).toBe(true);
      expect(toolResults.some((tr) => tr.name === "get_weather")).toBe(true);
      expect(toolResults.some((tr) => tr.name === "get_soccer_scores")).toBe(
        true,
      );

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
      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);
      expect(toolCalls.some((tc) => tc.name === "task")).toBe(true);

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
        } as any,
      )) {
        const update = chunk[2] ?? {};
        if (!("tools" in update)) continue;

        const tools = update.tools as { messages: ToolMessage[] };
        toolResultNames.push(...tools.messages.map((msg) => msg.name!));
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
          .filter(AIMessage.isInstance)
          .flatMap((msg) => msg.tool_calls || []),
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

  it.concurrent(
    "should properly propagate HITL interrupts from subagents without TypeError",
    { timeout: 120000 },
    async () => {
      // This test specifically verifies the fix for the issue where
      // GraphInterrupt.interrupts was undefined when propagating from subagents,
      // causing "Cannot read properties of undefined (reading 'length')" error

      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        tools: [sampleTool],
        interruptOn: { sample_tool: true },
        checkpointer,
      });

      const config = { configurable: { thread_id: uuidv4() } };

      // Invoke with a task that will use the subagent which has HITL
      // The subagent should interrupt, and this interrupt should propagate
      // properly to the parent graph without causing a TypeError
      const result = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use the task tool with the general-purpose subagent to call the sample_tool",
            ),
          ],
        },
        config,
      );

      // Verify the agent called the task tool
      const aiMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = aiMessages.flatMap((msg) => msg.tool_calls || []);
      expect(toolCalls.some((tc) => tc.name === "task")).toBe(true);

      // Verify interrupt was properly propagated from the subagent
      expect(result.__interrupt__).toBeDefined();
      expect(result.__interrupt__).toHaveLength(1);

      // Verify the interrupt has the correct HITL structure
      const interrupt = result.__interrupt__?.[0];
      expect(interrupt).toBeDefined();
      expect(interrupt!.value).toBeDefined();

      const hitlRequest = interrupt!.value as HITLRequest;
      expect(hitlRequest.actionRequests).toBeDefined();
      expect(hitlRequest.actionRequests.length).toBeGreaterThan(0);
      expect(hitlRequest.reviewConfigs).toBeDefined();
      expect(hitlRequest.reviewConfigs.length).toBeGreaterThan(0);

      // Verify we can resume successfully
      const resumeResult = await agent.invoke(
        new Command({
          resume: {
            decisions: [{ type: "approve" }],
          },
        }),
        config,
      );

      // After resume, there should be no more interrupts
      expect(resumeResult.__interrupt__).toBeUndefined();

      // The tool should have been executed
      const toolMessages = resumeResult.messages.filter(ToolMessage.isInstance);
      expect(toolMessages.length).toBeGreaterThan(0);
    },
  );

  it.concurrent(
    "should not leave dangling tool_call_id when rejecting an interrupted tool call with parallel tools (issue #150)",
    { timeout: 120000 },
    async () => {
      // This test reproduces issue #150: When a single user request causes the agent
      // to call two tools in parallel (interrupted_tool + free_tool), and interruptOn
      // pauses on interrupted_tool, rejecting the interrupt via
      // Command({ resume: { decisions: [{ type: "reject" }] } }) should not leave
      // a dangling tool_call_id.

      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        tools: [sampleTool, getWeather, getSoccerScores],
        interruptOn: {
          // sample_tool requires approval (will be interrupted)
          sample_tool: true,
          // get_weather does NOT require approval (will run immediately)
          get_weather: false,
          // get_soccer_scores also requires approval (will be interrupted)
          get_soccer_scores: true,
        },
        checkpointer,
      });

      const config = { configurable: { thread_id: uuidv4() } };

      // First invocation - should trigger interrupts for sample_tool and get_soccer_scores
      // but get_weather should run immediately
      const result = await agent.invoke(
        {
          messages: [
            {
              role: "user",
              content:
                "Call the sample tool with 'test', get the weather in New York, and get soccer scores for Manchester United - do all three in parallel",
            },
          ],
        },
        config,
      );

      // Check tool calls were made
      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap((msg) => msg.tool_calls || []);

      expect(toolCalls.some((tc) => tc.name === "sample_tool")).toBe(true);
      expect(toolCalls.some((tc) => tc.name === "get_weather")).toBe(true);
      expect(toolCalls.some((tc) => tc.name === "get_soccer_scores")).toBe(
        true,
      );

      // Check interrupts exist for the tools that require approval
      expect(result.__interrupt__).toBeDefined();
      expect(result.__interrupt__).toHaveLength(1);

      const interrupts = result.__interrupt__?.[0].value as HITLRequest;
      const actionRequests = interrupts.actionRequests;

      // Should have interrupts for sample_tool and get_soccer_scores (both require approval)
      expect(actionRequests.length).toBeGreaterThanOrEqual(1);

      // Resume with REJECTIONS for all interrupted tools
      // This is the critical part of the test - rejecting should not leave dangling tool_call_ids
      // If the bug exists (issue #150), this will throw:
      // "400 An assistant message with 'tool_calls' must be followed by tool messages
      // responding to each 'tool_call_id'"
      const result2 = await agent.invoke(
        new Command({
          resume: {
            // Reject all pending tool calls
            decisions: actionRequests.map(() => ({ type: "reject" as const })),
          },
        }),
        config,
      );

      // The agent successfully continued without a 400 error - the fix is working!
      // The result2 should have messages (agent processed the rejection and responded)
      expect(result2.messages.length).toBeGreaterThan(0);

      // Verify the agent was able to complete the run
      // (if there was a dangling tool_call_id, the model call would have thrown a 400 error)
      const finalAiMessages = result2.messages.filter(AIMessage.isInstance);
      expect(finalAiMessages.length).toBeGreaterThan(0);

      // The test passing without a 400 error proves the fix works
      // The patch middleware successfully added synthetic ToolMessages for dangling tool calls
    },
  );
});
