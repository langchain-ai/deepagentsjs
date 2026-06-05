/**
 * Interpreter Libraries Example — Tech Stack Evaluator
 *
 * Demonstrates two interpreter libraries working together:
 *
 * 1. **swarm** (built-in) — parallel task dispatch infrastructure.
 *    Configured with three specialized subagents, each with Tavily
 *    web search: researcher, benchmarker, and community_analyst.
 *
 * 2. **evaluator** (custom, imports swarm) — multi-pass evaluation
 *    pipeline. Pass 1 does quick scoring (invoke mode), filters to the
 *    top N, then passes 2-4 fan out to different subagents for
 *    research, benchmarks, and ecosystem analysis.
 *
 * The agent writes code that calls `evaluate()` from the evaluator
 * library. The evaluator orchestrates 4 swarm passes under the hood,
 * dispatching to 3 different subagent types. The structured results
 * (scores, research, benchmarks, ecosystem data) come back to the
 * agent's sandbox, demonstrating context isolation — the agent
 * reasons over aggregated data without managing any of the dispatch.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... TAVILY_API_KEY=... npx tsx examples/repl/interpreter-libraries/run.ts
 */
import "dotenv/config";
import * as path from "node:path";
import * as url from "node:url";
import dedent from "dedent";
import { HumanMessage } from "@langchain/core/messages";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { ChatAnthropic } from "@langchain/anthropic";
import { TavilySearch } from "@langchain/tavily";
import { createDeepAgent } from "deepagents";
import {
  createCodeInterpreterMiddleware,
  swarm,
  loadLibrary,
} from "@langchain/quickjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function main() {
  const model = new ChatAnthropic({
    model: "claude-sonnet-4-5",
    temperature: 0,
  });

  const defaultModel = "anthropic:claude-sonnet-4-5";

  // Built-in swarm library with three specialized subagents
  const swarmLib = swarm({
  defaultModel,
  subagents: [
    {
      name: "researcher",
      description: "General research and fact-finding via web search",
      systemPrompt: dedent`
        You are a technical researcher. Use web search to find current,
        factual information about the technology you're evaluating.
        Focus on official docs, adoption trends, and survey data.
        Cite specific numbers and sources. Be concise but substantive.
      `,
      tools: [new TavilySearch({ maxResults: 3 })],
    },
    {
      name: "benchmarker",
      description: "Performance benchmark specialist",
      systemPrompt: dedent`
        You are a performance analyst. Use web search to find benchmarks,
        profiling data, and performance comparisons for the technology
        you're evaluating. Focus on startup time, memory usage, binary
        size, and throughput. Cite benchmark sources and methodology.
      `,
      tools: [new TavilySearch({ maxResults: 3 })],
    },
    {
      name: "community_analyst",
      description: "Ecosystem and community analysis",
      systemPrompt: dedent`
        You are a developer ecosystem analyst. Use web search to assess
        the community, ecosystem, and tooling around the technology
        you're evaluating. Cover: package counts, key libraries,
        GitHub activity, StackOverflow trends, and recent momentum.
        Cite specific numbers.
      `,
      tools: [new TavilySearch({ maxResults: 3 })],
    },
  ],
});

// Custom evaluator library — imports swarm internally to build
// a multi-pass pipeline (score → filter → research → benchmarks → ecosystem)
const evaluatorLib = await loadLibrary(
  path.join(__dirname, "libraries", "evaluator"),
);

const agent = createDeepAgent({
  model,
  systemPrompt: dedent`
    You are a tech stack evaluator. You have an \`evaluator\` library that
    orchestrates a full multi-pass comparison pipeline via swarm.

    ## Step 1 — Run the evaluation

    Write exactly this code (no console.log needed — the library handles output):

    \`\`\`
    import { evaluate } from "evaluator";
    await evaluate(
      ["Rust", "Go", "Python", "TypeScript", "Java", "C#", "Zig", "Swift", "Kotlin", "Ruby"],
      [
        { name: "Developer experience", weight: 0.3 },
        { name: "Performance", weight: 0.25 },
        { name: "Ecosystem/libraries", weight: 0.25 },
        { name: "Cross-platform support", weight: 0.2 },
      ],
      { topN: 5 },
    );
    \`\`\`

    ## Step 2 — Read results

    evaluate() writes results to \`/evaluation/\`:
    - \`/evaluation/rankings.json\` — scores and ranking for all candidates
    - \`/evaluation/{slug}.json\` — detailed research, benchmarks, and ecosystem
      analysis for each top-N candidate (e.g. \`/evaluation/rust.json\`)

    Read \`rankings.json\` first for the overview. Then read each top-N
    candidate's detail file.

    ## Step 3 — Respond with findings

    Summarize the results in your response. Include scores, research
    findings, benchmarks, ecosystem analysis, and a final recommendation.
    Do not write to a file — just respond directly.
  `,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- middleware types vary across langchain version resolutions in the monorepo
  middleware: [
    createCodeInterpreterMiddleware({
      libraries: [swarmLib, evaluatorLib],
      executionTimeoutMs: -1,
    }) as any,
  ],
});

const result = await agent.invoke({
  messages: [
    new HumanMessage(dedent`
      Compare Rust, Go, Python, TypeScript, Java, C#, Zig, Swift, Kotlin, and Ruby
      for building CLI tools. Evaluate on:
      - Developer experience (weight: 0.3)
      - Performance (weight: 0.25)
      - Ecosystem/libraries (weight: 0.25)
      - Cross-platform support (weight: 0.2)

      Deep-dive the top 5.
    `),
  ],
});

  const last = result.messages[result.messages.length - 1];
  console.log(typeof last.content === "string" ? last.content : last.content);

  await awaitAllCallbacks();
}

main().catch(console.error);
