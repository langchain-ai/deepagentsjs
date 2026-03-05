import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { tool } from "langchain";
import { z } from "zod/v4";
import {
  MemorySaver,
  Command,
} from "@langchain/langgraph";
import {
  AIMessage,
  ToolMessage,
  type HITLRequest,
  type InterruptOnConfig,
} from "langchain";
import { createDeepAgent } from "./index.js";

const sampleToolEval = tool((input) => input.sample_input, {
  name: "sample_tool",
  description: "Sample tool",
  schema: z.object({ sample_input: z.string() }),
});

const getWeatherEval = tool(
  (input) => `The weather in ${input.location} is sunny.`,
  {
    name: "get_weather",
    description: "Use this tool to get the weather",
    schema: z.object({ location: z.string() }),
  },
);

const getSoccerScoresEval = tool(
  (input) => `The latest soccer scores for ${input.team} are 2-1.`,
  {
    name: "get_soccer_scores",
    description: "Use this tool to get the latest soccer scores",
    schema: z.object({ team: z.string() }),
  },
);

const SAMPLE_TOOL_CONFIG: Record<string, boolean | InterruptOnConfig> = {
  sample_tool: true,
  get_weather: false,
  get_soccer_scores: { allowedDecisions: ["approve", "reject"] },
};

ls.describe("deepagents-js-hitl", () => {
  ls.test(
    "hitl: agent interrupts and resumes",
    {
      inputs: {
        query:
          "Call the sample tool, get the weather in New York and get scores for the latest soccer games in parallel",
      },
    },
    async ({ inputs }) => {
      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        tools: [sampleToolEval, getWeatherEval, getSoccerScoresEval],
        interruptOn: SAMPLE_TOOL_CONFIG,
        checkpointer,
      });

      const threadId = uuidv4();
      const config = { configurable: { thread_id: threadId } };

      const result = await agent.invoke(
        {
          messages: [{ role: "user", content: inputs.query }],
        },
        config,
      );

      const agentMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = agentMessages.flatMap(
        (msg: AIMessage) => msg.tool_calls || [],
      );

      expect(toolCalls.some((tc: any) => tc.name === "sample_tool")).toBe(true);
      expect(toolCalls.some((tc: any) => tc.name === "get_weather")).toBe(true);
      expect(toolCalls.some((tc: any) => tc.name === "get_soccer_scores")).toBe(
        true,
      );

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

      const reviewConfigs = interrupts.reviewConfigs;
      expect(
        reviewConfigs.some(
          (rc: any) =>
            rc.actionName === "sample_tool" &&
            rc.allowedDecisions.includes("approve") &&
            rc.allowedDecisions.includes("edit") &&
            rc.allowedDecisions.includes("reject"),
        ),
      ).toBe(true);
      expect(
        reviewConfigs.some(
          (rc: any) =>
            rc.actionName === "get_soccer_scores" &&
            rc.allowedDecisions.includes("approve") &&
            rc.allowedDecisions.includes("reject"),
        ),
      ).toBe(true);

      const result2 = await agent.invoke(
        new Command({
          resume: {
            decisions: [{ type: "approve" }, { type: "approve" }],
          },
        }),
        config,
      );

      const toolResults = result2.messages.filter(ToolMessage.isInstance);
      expect(toolResults.some((tr: ToolMessage) => tr.name === "sample_tool")).toBe(
        true,
      );
      expect(toolResults.some((tr: ToolMessage) => tr.name === "get_weather")).toBe(
        true,
      );
      expect(
        toolResults.some((tr: ToolMessage) => tr.name === "get_soccer_scores"),
      ).toBe(true);
    },
  );

  ls.test(
    "hitl: subagent with hitl",
    {
      inputs: {
        query:
          "Use the task tool to kick off the general-purpose subagent. " +
          "Tell it to call the sample tool, get the weather in New York " +
          "and get scores for the latest soccer games in parallel",
      },
    },
    async ({ inputs }) => {
      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        tools: [sampleToolEval, getWeatherEval, getSoccerScoresEval],
        interruptOn: SAMPLE_TOOL_CONFIG,
        checkpointer,
      });

      const threadId = uuidv4();
      const config = { configurable: { thread_id: threadId } };

      const result = await agent.invoke(
        {
          messages: [{ role: "user", content: inputs.query }],
        },
        config,
      );

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

      const reviewConfigs = interrupts.reviewConfigs;
      expect(
        reviewConfigs.some(
          (rc: any) =>
            rc.actionName === "sample_tool" &&
            rc.allowedDecisions.includes("approve") &&
            rc.allowedDecisions.includes("edit") &&
            rc.allowedDecisions.includes("reject"),
        ),
      ).toBe(true);
      expect(
        reviewConfigs.some(
          (rc: any) =>
            rc.actionName === "get_soccer_scores" &&
            rc.allowedDecisions.includes("approve") &&
            rc.allowedDecisions.includes("reject"),
        ),
      ).toBe(true);

      const result2 = await agent.invoke(
        new Command({
          resume: {
            decisions: [{ type: "approve" }, { type: "approve" }],
          },
        }),
        config,
      );

      expect(
        result2.__interrupt__ === undefined ||
          result2.__interrupt__?.length === 0,
      ).toBe(true);
    },
  );

  ls.test(
    "hitl: subagent with custom interrupt on",
    {
      inputs: {
        query:
          "Use the task tool to kick off the task_handler subagent. " +
          "Tell it to call the sample tool, get the weather in New York " +
          "and get scores for the latest soccer games in parallel",
      },
    },
    async ({ inputs }) => {
      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        tools: [sampleToolEval, getWeatherEval, getSoccerScoresEval],
        interruptOn: SAMPLE_TOOL_CONFIG,
        checkpointer,
        subagents: [
          {
            name: "task_handler",
            description:
              "A subagent that can handle all sorts of tasks",
            systemPrompt:
              "You are a task handler. You can handle all sorts of tasks.",
            tools: [sampleToolEval, getWeatherEval, getSoccerScoresEval],
            interruptOn: {
              sample_tool: false,
              get_weather: true,
              get_soccer_scores: true,
            },
          },
        ],
      });

      const threadId = uuidv4();
      const config = { configurable: { thread_id: threadId } };

      const result = await agent.invoke(
        {
          messages: [{ role: "user", content: inputs.query }],
        },
        config,
      );

      expect(result.__interrupt__).toBeDefined();
      expect(result.__interrupt__!.length).toBeGreaterThan(0);

      const interrupts = result.__interrupt__?.[0].value as HITLRequest;
      const actionRequests = interrupts.actionRequests;
      expect(actionRequests).toHaveLength(2);
      expect(actionRequests.some((ar: any) => ar.name === "get_weather")).toBe(
        true,
      );
      expect(
        actionRequests.some((ar: any) => ar.name === "get_soccer_scores"),
      ).toBe(true);
      expect(actionRequests.some((ar: any) => ar.name === "sample_tool")).toBe(
        false,
      );

      const reviewConfigs = interrupts.reviewConfigs;
      expect(
        reviewConfigs.some(
          (rc: any) =>
            rc.actionName === "get_weather" &&
            rc.allowedDecisions.includes("approve") &&
            rc.allowedDecisions.includes("edit") &&
            rc.allowedDecisions.includes("reject"),
        ),
      ).toBe(true);
      expect(
        reviewConfigs.some(
          (rc: any) =>
            rc.actionName === "get_soccer_scores" &&
            rc.allowedDecisions.includes("approve") &&
            rc.allowedDecisions.includes("edit") &&
            rc.allowedDecisions.includes("reject"),
        ),
      ).toBe(true);

      const result2 = await agent.invoke(
        new Command({
          resume: {
            decisions: [{ type: "approve" }, { type: "approve" }],
          },
        }),
        config,
      );

      expect(
        result2.__interrupt__ === undefined ||
          result2.__interrupt__?.length === 0,
      ).toBe(true);
    },
  );
});
