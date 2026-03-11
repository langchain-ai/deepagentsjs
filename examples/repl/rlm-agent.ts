/**
 * Recursive Language Model (RLM) Example
 *
 * Demonstrates the RLM pattern using the QuickJS REPL middleware with
 * programmatic tool calling (PTC). The agent writes code that spawns
 * sub-agents via `tools.task()`, processes their results programmatically,
 * and aggregates findings — all within the sandboxed REPL.
 *
 * This is the core RLM insight: instead of the LLM verbalizing each
 * sub-agent call as a separate tool invocation, it writes a loop that
 * spawns N sub-agents in parallel and processes the results in code.
 *
 * Architecture:
 * ```
 * Agent (with js_eval + PTC)
 *   └── REPL code
 *       ├── tools.task({ description: "analyze chunk 1", ... })
 *       ├── tools.task({ description: "analyze chunk 2", ... })
 *       └── ... (N parallel sub-agent calls via Promise.all)
 *       └── programmatic aggregation of results
 * ```
 *
 */
import "dotenv/config";
import dedent from "dedent";
import { HumanMessage } from "@langchain/core/messages";
import { createDeepAgent, type SubAgent } from "deepagents";
import { createQuickJSMiddleware } from "@langchain/quickjs";
import { ChatOpenAI } from "@langchain/openai";

const generalPurpose: SubAgent = {
  name: "general-purpose",
  description: dedent`
    General-purpose research agent. Give it a focused task and it will
    return a detailed analysis. Good for researching a single topic,
    analyzing a document chunk, or answering a specific question.
  `,
  systemPrompt: dedent`
    You are a focused research agent. Conduct thorough research on the
    topic you are given and return a detailed analysis with key findings.
  `,
};

const agent = createDeepAgent({
  model: new ChatOpenAI("gpt-5.2"),
  systemPrompt: dedent`
    You are a research analyst that uses code to orchestrate sub-agents.

    **CRITICAL: Always use Promise.all to spawn sub-agents in parallel.**
    Never call tools.task() sequentially in a loop — always build an array
    of promises and await them together with Promise.all. This runs all
    sub-agents concurrently and is dramatically faster.

    When given a complex research task:
    1. Break it into independent sub-tasks
    2. Write a single js_eval call that spawns ALL sub-agents in parallel
    3. Aggregate and analyze the results programmatically in the same code block
    4. Write your final synthesis to a file

    \`\`\`typescript
    const topics = ["topic A", "topic B", "topic C"];

    // ALWAYS fan out in parallel like this:
    const results = await Promise.all(
      topics.map(topic =>
        tools.task({
          description: \`Research \${topic} in depth. Return key findings.\`,
          subagentType: "general-purpose",
        })
      )
    );

    // Then aggregate programmatically
    const report = topics.map((t, i) => \`## \${t}\\n\${results[i]}\`).join("\\n\\n");
    await writeFile("/research.md", report);
    \`\`\`

    Do all sub-agent spawning, result processing, and file writing in a
    single js_eval call. Do not use multiple sequential js_eval calls
    when the work can be parallelized.
  `,
  subagents: [generalPurpose],
  middleware: [
    createQuickJSMiddleware({
      ptc: ["task"],
    }),
  ],
});

const result = await agent.invoke({
  messages: [
    new HumanMessage(dedent`
      Compare the renewable energy policies of Germany, China, and the
      United States. For each country, research their current targets,
      major investments, and key challenges. Then write a comparative
      analysis to /analysis.md.
    `),
  ],
});

const last = result.messages[result.messages.length - 1];
// eslint-disable-next-line no-console
console.log(
  typeof last.content === "string" ? last.content.slice(0, 500) : last.content,
);
