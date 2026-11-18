/**
 * Evaluation tests for the deep agent graph.
 *
 * Unlike integration tests (which verify structural correctness), evals
 * measure *quality* — how well the agent's output matches reference answers.
 * Each test run is automatically logged as a LangSmith experiment so you can
 * track regressions over time.
 *
 * Uses `langsmith/vitest` wrappers which extend vitest's `expect` with
 * additional matchers for fuzzy text comparison:
 *   - `toBeRelativeCloseTo(expected, opts?)` — normalised Levenshtein distance
 *   - `toBeAbsoluteCloseTo(expected, opts?)` — raw edit-distance threshold
 *   - `toBeSemanticCloseTo(expected, opts)` — embedding cosine similarity
 *
 * Run with:  npm run test:eval
 * (which maps to `vitest run --mode eval`)
 */

import * as ls from "langsmith/vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { agent } from "./agent.js";

ls.describe("agent evals", () => {
  ls.test(
    "greeting: responds with a friendly hello",
    {
      inputs: { query: "Say hello in one sentence." },
      referenceOutputs: { expected: "Hello!" },
    },
    async ({ inputs, referenceOutputs }) => {
      const result = await agent.invoke({
        messages: [new HumanMessage(inputs.query)],
      });

      const lastMsg = result.messages.at(-1);

      // Fuzzy-match the response against the reference greeting.
      await ls
        .expect(lastMsg?.text)
        .toBeRelativeCloseTo(referenceOutputs!.expected as string, {
          threshold: 0.5,
        });

      return { response: lastMsg?.text };
    },
    60_000
  );

  ls.test(
    "tool usage: utc_now returns a timestamp",
    {
      inputs: {
        query: "What is the current UTC time? Use the utc_now tool.",
      },
    },
    async ({ inputs }) => {
      const result = await agent.invoke({
        messages: [new HumanMessage(inputs.query)],
      });

      const lastMsg = result.messages.at(-1);

      // The agent should mention a time-like string in its response.
      ls.expect(lastMsg?.text).toBeTruthy();

      // Log feedback: did the response contain an ISO-ish timestamp?
      const hasTimestamp = /\d{4}-\d{2}-\d{2}/.test(lastMsg?.text ?? "");
      ls.logFeedback({
        key: "contains_timestamp",
        score: hasTimestamp ? 1 : 0,
      });

      return { response: lastMsg?.text, hasTimestamp };
    },
    60_000
  );

  ls.test(
    "subagent delegation: researcher is invoked for fact-finding",
    {
      inputs: {
        query:
          "Use the researcher subagent to find out what year the first iPhone was released.",
      },
      referenceOutputs: { expected: "The first iPhone was released in 2007." },
    },
    async ({ inputs, referenceOutputs }) => {
      const result = await agent.invoke({
        messages: [new HumanMessage(inputs.query)],
      });

      const aiMessages = result.messages.filter(AIMessage.isInstance);
      const toolCalls = aiMessages.flatMap(
        (msg: AIMessage) => msg.tool_calls ?? []
      );

      // Log feedback: did the orchestrator dispatch to the researcher?
      const delegated = toolCalls.some(
        (tc) => tc.name === "task" && tc.args?.subagent_type === "researcher"
      );
      ls.logFeedback({
        key: "delegated_to_researcher",
        score: delegated ? 1 : 0,
      });

      // Fuzzy-match the final answer against the reference.
      const lastMsg = result.messages.at(-1);
      await ls
        .expect(lastMsg?.text)
        .toBeRelativeCloseTo(referenceOutputs!.expected as string, {
          threshold: 0.5,
        });

      return { response: lastMsg?.text, delegated };
    },
    90_000
  );
});
