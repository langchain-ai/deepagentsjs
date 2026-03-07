/**
 * Data Analysis Agent Example
 *
 * Demonstrates the QuickJS REPL as a computational scratch pad.
 * The agent reads data from the VFS, processes it in sandboxed JavaScript,
 * and writes results back — all without network access or Node.js APIs.
 *
 * This is useful for tasks where LLMs typically hallucinate:
 * - Arithmetic and statistical calculations
 * - Sorting, filtering, grouping data
 * - JSON transformation and restructuring
 * - Multi-step logic with intermediate state
 */
import "dotenv/config";
import dedent from "dedent";
import { HumanMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { createDeepAgent } from "deepagents";
import { createQuickJSMiddleware } from "@langchain/quickjs";

const model = new ChatAnthropic({
  model: "claude-sonnet-4-5",
  temperature: 0,
});

const agent = createDeepAgent({
  model,
  systemPrompt: dedent`
    You are a data analyst. Use the js_eval REPL to perform calculations
    and data transformations. Always show your work in code — never guess
    at arithmetic or statistics.
  `,
  middleware: [createQuickJSMiddleware()],
});

const result = await agent.invoke({
  messages: [
    new HumanMessage(dedent`
      I have sales data in /data/sales.json. Parse it, calculate the total
      revenue per region, find the top-performing region, and write a
      summary report to /reports/sales-summary.md.
    `),
  ],
});

const last = result.messages[result.messages.length - 1];
// eslint-disable-next-line no-console
console.log(
  typeof last.content === "string" ? last.content.slice(0, 500) : last.content,
);
