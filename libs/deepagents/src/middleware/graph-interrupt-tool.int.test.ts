import { describe, it, expect } from "vitest";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { GraphInterrupt } from "@langchain/langgraph";
import { MemorySaver, Command } from "@langchain/langgraph";
import { createDeepAgent } from "../index.js";
import { SAMPLE_MODEL } from "../testing/utils.js";
import { v4 as uuidv4 } from "uuid";

describe("GraphInterrupt from Tool Tests", () => {
  it.skip(
    "demonstrates that throwing GraphInterrupt from tools loses interrupts property",
    { timeout: 30000 },
    async () => {
      // This test demonstrates the issue described in GitHub issue #131
      // Throwing GraphInterrupt from a tool results in a TypeError because
      // LangGraph's error serialization only preserves {message, name} properties

      const interruptingTool = new DynamicStructuredTool({
        name: "pause_tool",
        description: "A tool that pauses execution",
        schema: z.object({
          reason: z.string(),
        }),
        func: async (input) => {
          const graphInterrupt = new GraphInterrupt([
            {
              id: "test-interrupt",
              value: { reason: input.reason },
            },
          ]);

          // Verify it's properly constructed before throwing
          expect(graphInterrupt.interrupts).toBeDefined();
          expect(graphInterrupt.interrupts).toHaveLength(1);

          throw graphInterrupt;
        },
      });

      const agent = createDeepAgent({
        systemPrompt: "Use pause_tool when user asks to pause",
        tools: [interruptingTool],
        model: SAMPLE_MODEL,
      });

      // This will throw a TypeError: undefined is not an object (evaluating 'error.interrupts.length')
      // because the interrupts property is lost during error serialization
      await expect(
        agent.invoke({
          messages: [{ role: "user", content: "Pause execution" }],
        })
      ).rejects.toThrow();
    }
  );

  it.concurrent(
    "demonstrates the recommended solution: use HITL middleware with interruptOn",
    { timeout: 90000 },
    async () => {
      // This test shows the PROPER way to implement tool-level approval workflows
      // Using the HITL middleware with interruptOn configuration

      const actionTool = new DynamicStructuredTool({
        name: "perform_action",
        description: "Perform a potentially dangerous action",
        schema: z.object({
          action: z.string().describe("The action to perform"),
        }),
        func: async (input) => {
          return `Performed action: ${input.action}`;
        },
      });

      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        tools: [actionTool],
        interruptOn: {
          perform_action: true, // Interrupt before executing this tool
        },
        checkpointer,
        model: SAMPLE_MODEL,
      });

      const config = { configurable: { thread_id: uuidv4() } };

      // First invocation - should interrupt before executing the tool
      const result = await agent.invoke(
        {
          messages: [
            {
              role: "user",
              content: "Perform a dangerous action",
            },
          ],
        },
        config
      );

      // Verify that execution was interrupted
      expect(result.__interrupt__).toBeDefined();
      expect(result.__interrupt__).toHaveLength(1);

      // The interrupt contains the tool call information
      const interrupt = result.__interrupt__[0].value;
      expect(interrupt.actionRequests).toBeDefined();
      expect(interrupt.actionRequests.length).toBeGreaterThan(0);

      // Resume with approval
      const result2 = await agent.invoke(
        new Command({
          resume: {
            decisions: [{ type: "approve" }],
          },
        }),
        config
      );

      // Verify the tool was executed after approval
      const toolMessages = result2.messages.filter(
        (msg: any) => msg._getType() === "tool"
      );
      expect(toolMessages.some((msg: any) => msg.name === "perform_action")).toBe(
        true
      );

      // No more interrupts
      expect(result2.__interrupt__).toBeUndefined();
    }
  );
});
