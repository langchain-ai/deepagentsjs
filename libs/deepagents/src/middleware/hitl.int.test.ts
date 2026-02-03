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

  /**
   * When two tools are called in parallel (one interrupted, one not),
   * rejecting the interrupted tool should not leave a dangling tool_call_id.
   */
  it.concurrent(
    "should not leave dangling tool_call_id when rejecting an interrupted tool with parallel tool calls (issue #15)",
    { timeout: 120000 },
    async () => {
      const checkpointer = new MemorySaver();

      // interrupted_tool requires approval, free_tool does not
      const interruptConfig: Record<string, boolean | InterruptOnConfig> = {
        sample_tool: true, // This one will be interrupted
        get_weather: false, // This one will run freely
      };

      const agent = createDeepAgent({
        tools: [sampleTool, getWeather],
        interruptOn: interruptConfig,
        checkpointer,
      });

      const config = { configurable: { thread_id: uuidv4() } };
      assertAllDeepAgentQualities(agent);

      // First invocation - ask agent to call both tools in parallel
      // sample_tool will be interrupted, get_weather will run freely
      const result = await agent.invoke(
        {
          messages: [
            {
              role: "user",
              content:
                "Call both sample_tool AND get_weather for New York in parallel.",
            },
          ],
        },
        config,
      );

      // Check that both tools were called
      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap(
        (msg: AIMessage) => msg.tool_calls || [],
      );

      expect(toolCalls.some((tc) => tc.name === "sample_tool")).toBe(true);
      expect(toolCalls.some((tc) => tc.name === "get_weather")).toBe(true);

      // Check that we have an interrupt for sample_tool
      expect(result.__interrupt__).toBeDefined();
      expect(result.__interrupt__).toHaveLength(1);

      const interrupts = result.__interrupt__?.[0].value as HITLRequest;
      expect(interrupts.actionRequests).toHaveLength(1);
      expect(interrupts.actionRequests[0].name).toBe("sample_tool");

      // REJECT the interrupted tool call
      // This is the key scenario from issue #15 - rejecting should not leave
      // a dangling tool_call_id that causes a 400 error
      let result2 = await agent.invoke(
        new Command({
          resume: {
            decisions: [{ type: "reject" }],
          },
        }),
        config,
      );

      // The key assertion: we should NOT get a 400 error about dangling tool_call_ids
      // The agent may still have an interrupt if it decides to retry the tool,
      // so we'll keep rejecting until it completes or gives up
      let retries = 0;
      const maxRetries = 3;
      while (result2.__interrupt__ && retries < maxRetries) {
        // If there's still an interrupt (agent retrying the rejected tool),
        // reject again - this is valid behavior, we just want to ensure no 400 error
        result2 = await agent.invoke(
          new Command({
            resume: {
              decisions: result2.__interrupt__.map(() => ({ type: "reject" })),
            },
          }),
          config,
        );
        retries++;
      }

      // After rejecting, check that we have tool results for get_weather (the non-interrupted tool)
      const toolResults = result2.messages.filter(ToolMessage.isInstance);
      expect(toolResults.some((tr) => tr.name === "get_weather")).toBe(true);

      // The sample_tool should have a synthetic ToolMessage (cancelled/rejected)
      // or the tool call should be handled in some way that doesn't leave it dangling
      const sampleToolResult = toolResults.find(
        (tr) => tr.name === "sample_tool",
      );
      // There should be at least one result for sample_tool (rejection message from patching)
      expect(sampleToolResult).toBeDefined();
      expect(typeof sampleToolResult?.content).toBe("string");
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

      for await (const chunk of await agent.stream(
        new Command({
          resume: { decisions: [{ type: "approve" }, { type: "approve" }] },
        }),
        {
          ...config,
          streamMode: ["updates"],
          // @ts-expect-error - type issue in LangGraph
          subgraphs: true,
        },
      )) {
        // @ts-expect-error - type issue in LangChain
        const update = chunk[2] ?? {};
        if (!("tools" in update)) continue;

        const tools = update.tools as any;
        toolResultNames.push(...tools.messages.map((msg) => msg.name ?? ""));
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
      const toolMessages = resumeResult.messages.filter(
        (msg) => msg._getType() === "tool",
      );
      expect(toolMessages.length).toBeGreaterThan(0);
    },
  );
});
