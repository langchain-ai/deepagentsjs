/**
 * Mock tools for the deep agent's subagents.
 *
 * Ported from the streaming-cookbook `react-custom-backend` example. Both tools
 * are intentionally fake so the example runs offline; what matters is that the
 * subagents emit real tool-call deltas on the `messages` channel and tool
 * results as `ToolMessage`s, all namespaced under their subagent run.
 */

import { tool } from "langchain";
import { z } from "zod";

export const searchWeb = tool(
  async ({ query }) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return JSON.stringify({
      results: [
        {
          title: `Result for: ${query}`,
          snippet:
            "LangGraph streaming sends token deltas on the messages channel " +
            "and tool lifecycle events on tools. Subagent runs carry their own " +
            "namespace so the UI can render them in dedicated cards.",
        },
      ],
    });
  },
  {
    name: "search_web",
    description: "Search the web for information.",
    schema: z.object({ query: z.string().describe("Search query.") }),
  },
);

/** Demo-only arithmetic evaluator restricted to numbers and basic operators. */
function evaluateExpression(expression: string): number {
  if (!/^[\d+\-*/().\s]+$/.test(expression)) {
    throw new Error("Only basic arithmetic is supported.");
  }
  const compute = new Function(
    `"use strict"; return (${expression});`,
  ) as () => unknown;
  const result = compute();
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("Expression did not evaluate to a finite number.");
  }
  return result;
}

export const calculator = tool(
  async ({ expression }) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      return String(evaluateExpression(expression));
    } catch (error) {
      return `Error evaluating: ${expression} (${String(error)})`;
    }
  },
  {
    name: "calculator",
    description: "Evaluate a math expression.",
    schema: z.object({
      expression: z.string().describe("Math expression to evaluate."),
    }),
  },
);
