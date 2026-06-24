import { tool } from "langchain";
import { z } from "zod";

/**
 * Mock tools used to demonstrate message and tool-call streaming.
 *
 * Both tools are intentionally fake so the example runs offline. What matters
 * is that the agent (and its subagents) emit real tool-call deltas on the
 * `messages` channel and tool results as `ToolMessage`s, which the UI renders.
 */

export const searchWeb = tool(
  async ({ query }) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return JSON.stringify({
      results: [
        {
          title: `Result for: ${query}`,
          snippet:
            "LangGraph streaming sends token deltas on the messages channel " +
            "and tool lifecycle events on the tools channel.",
        },
      ],
    });
  },
  {
    name: "search_web",
    description: "Search the web for information about a topic.",
    schema: z.object({ query: z.string().describe("Search query.") }),
  }
);

/** Demo-only arithmetic evaluator restricted to numbers and basic operators. */
function evaluateExpression(expression: string): number {
  if (!/^[\d+\-*/().\s]+$/.test(expression)) {
    throw new Error("Only basic arithmetic is supported.");
  }
  const compute = new Function(
    `"use strict"; return (${expression});`
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
  }
);
