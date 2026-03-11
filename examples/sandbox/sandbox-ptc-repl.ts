/* eslint-disable no-console */
/**
 * Sandbox PTC (Programmatic Tool Calling) Example — Worker REPL + StateBackend
 *
 * Same scenario as sandbox-ptc.ts but without any sandbox infrastructure.
 * A StateBackend stores the CSV file in agent state, giving the agent
 * filesystem tools (read_file, write_file, etc.) for data access.
 * The PTC middleware adds a `js_eval` tool backed by a Worker REPL
 * with `toolCall()` and `spawnAgent()` as async globals.
 *
 *   Phase 1 — 100 parallel `toolCall("classify_record", ...)` via Promise.all
 *   Phase 2 — 100 parallel `spawnAgent(...)` "analyst" (real LLM subagents)
 *
 * No VfsSandbox, no Deno, no Modal, no Docker — just a StateBackend + Worker thread.
 *
 * ## Running
 *
 * ```bash
 * ANTHROPIC_API_KEY=sk-... npx tsx examples/sandbox/sandbox-ptc-repl.ts
 * ```
 */

import "dotenv/config";

import { z } from "zod/v4";

import { ChatAnthropic } from "@langchain/anthropic";
import { createMiddleware, tool, HumanMessage, AIMessage } from "langchain";
import {
  createDeepAgent,
  createSandboxPtcMiddleware,
  StateBackend,
} from "deepagents";

import { generateCsv } from "./utils/sandbox-ptc.js";

/**
 * ===============================
 * Define the classification tool.
 * ===============================
 */

const classifyTool = tool(
  async (input: {
    name: string;
    age: number;
    department: string;
    years_at_company: number;
  }) => {
    const seniority =
      input.years_at_company >= 15
        ? "senior"
        : input.years_at_company >= 5
          ? "mid-level"
          : "junior";
    const ageGroup =
      input.age >= 55
        ? "55+"
        : input.age >= 40
          ? "40-54"
          : input.age >= 30
            ? "30-39"
            : "under-30";
    const eligible = input.years_at_company >= 3 && input.age >= 25;
    return JSON.stringify({
      name: input.name,
      seniority,
      age_group: ageGroup,
      department: input.department,
      promotion_eligible: eligible,
    });
  },
  {
    name: "classify_record",
    description:
      "Classify an employee record — returns seniority, age group, promotion eligibility",
    schema: z.object({
      name: z.string(),
      age: z.number(),
      department: z.string(),
      years_at_company: z.number(),
    }),
  },
);

const ptcOnlyToolsMiddleware = createMiddleware({
  name: "PtcOnlyTools",
  tools: [classifyTool],
  wrapModelCall: async (request, handler) => {
    const visibleTools = (request.tools as { name: string }[]).filter(
      (t) => t.name !== "classify_record",
    );
    return handler({ ...request, tools: visibleTools });
  },
});

/**
 * =============================
 * Define the system prompt.
 * =============================
 */
const systemPrompt = `You are a data-processing agent.

The file \`data/employees.csv\` contains 100 employee records with columns: id, name, age, department, years_at_company.
Use read_file to load it, then use js_eval with toolCall/spawnAgent for processing.`;

const csv = generateCsv(100);
const now = new Date().toISOString();

console.log("Starting Worker REPL with StateBackend...\n");
console.log(`  100 employee records loaded into state\n`);

/**
 * =============================
 * Create the agent.
 * =============================
 */
const agent = createDeepAgent({
  model: new ChatAnthropic({
    model: "claude-haiku-4-5",
    temperature: 0,
  }),
  systemPrompt,
  backend: (config) => new StateBackend(config),
  subagents: [
    {
      name: "analyst",
      description: "Provides career recommendations for individual employees",
      systemPrompt: `You are an HR analyst. Given an employee's classification data,
provide exactly ONE sentence of career recommendation. Be specific and actionable.
Do not use markdown. Keep it under 30 words.`,
      model: new ChatAnthropic({
        model: "claude-haiku-4-5",
        temperature: 0,
      }),
    },
  ],
  middleware: [
    // No backend passed to PTC → Worker REPL with js_eval tool.
    // The agent's StateBackend still provides filesystem tools (read_file, etc.)
    createSandboxPtcMiddleware({ ptc: true }),
    // @ts-expect-error type issue with branded AgentMiddleware type
    ptcOnlyToolsMiddleware,
  ],
});

console.log(
  "Running: 100 parallel classify + 100 parallel analyst subagents (Worker REPL)...\n",
);
const t0 = performance.now();

/**
 * =============================
 * Invoke the agent.
 * =============================
 */
const result = await agent.invoke(
  {
    messages: [
      new HumanMessage(
        `Classify all 100 employees and spawn 100 analyst subagents in parallel.`,
      ),
    ],
    files: {
      "/data/employees.csv": {
        content: csv.split("\n"),
        created_at: now,
        modified_at: now,
      },
    },
  },
  { recursionLimit: 100 },
);

const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
const last = result.messages.findLast(AIMessage.isInstance);
if (last) {
  console.log(`\nAgent Response (${elapsed}s total):\n`);
  console.log(last.content);
}

console.log("\nDone.");
