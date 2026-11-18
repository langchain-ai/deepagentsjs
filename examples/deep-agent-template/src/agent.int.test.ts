/**
 * Integration tests for the deep agent graph.
 *
 * These tests invoke the compiled graph against a real LLM and verify
 * end-to-end behaviour.  They require a valid ANTHROPIC_API_KEY in the
 * environment.
 *
 * Assertions use the LangChain custom vitest matchers registered in
 * `vitest.setup.ts`. These give readable, structure-oriented checks on messages
 * and tool calls rather than brittle string comparisons against
 * nondeterministic LLM output.
 *
 * Matcher reference:
 *   toBeAIMessage, toBeHumanMessage, toBeToolMessage, toBeSystemMessage,
 *   toContainToolCall, toHaveToolCalls, toHaveToolCallCount,
 *   toHaveToolMessages, toHaveBeenInterrupted, toHaveStructuredResponse
 *
 * Run with:  npm run test:int
 * (which maps to `vitest run --mode int`)
 */

import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { agent } from "./agent.js";

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "agent integration tests",
  () => {
    it("should respond to a simple prompt with an AI message", async () => {
      const result = await agent.invoke({
        messages: [new HumanMessage("Say hello in one sentence.")],
      });

      // The last message in the conversation should be an AIMessage.
      expect(result.messages.at(-1)).toBeAIMessage();
    }, 60_000);

    it("should use the utc_now tool when asked for the current time", async () => {
      const result = await agent.invoke({
        messages: [
          new HumanMessage(
            "What is the current UTC time? Use the utc_now tool."
          ),
        ],
      });

      // Find the first AIMessage;
      const message = result.messages.find(AIMessage.isInstance);

      // It should contain a utc_now tool call.
      expect(message).toContainToolCall({ name: "utc_now" });
    }, 60_000);

    it("should use the confidence_check tool when prompted", async () => {
      const result = await agent.invoke({
        messages: [
          new HumanMessage(
            "Use the confidence_check tool to rate your confidence that the Earth orbits the Sun."
          ),
        ],
      });

      const aiWithTools = result.messages.find(AIMessage.isInstance);

      expect(aiWithTools).toContainToolCall({ name: "confidence_check" });
    }, 60_000);

    it("should delegate to the researcher sub-agent for fact-finding tasks", async () => {
      const result = await agent.invoke({
        messages: [
          new HumanMessage(
            "Use the researcher subagent to find out what year the first iPhone was released."
          ),
        ],
      });

      // The orchestrator should have dispatched a `task` tool call targeting
      // the "researcher" sub-agent.
      const aiWithTask = result.messages.find(AIMessage.isInstance);

      expect(aiWithTask).toContainToolCall({
        name: "task",
        args: { subagent_type: "researcher" },
      });

      // The final message should be an AI response (not a tool message).
      expect(result.messages.at(-1)).toBeAIMessage();
    }, 90_000);
  }
);
