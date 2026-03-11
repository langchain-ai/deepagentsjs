/* eslint-disable no-console */
/**
 * Sandbox PTC (Programmatic Tool Calling) Example
 *
 * Demonstrates `createDeepAgent` with PTC middleware: the agent writes a
 * bash script that runs two parallel phases inside a single `execute` call:
 *
 *   Phase 1 — 100 parallel `tool_call classify_record` (pure function)
 *   Phase 2 — 100 parallel `spawn_agent` "analyst" (real LLM subagents)
 *
 * Each analyst subagent receives one classified employee record and returns
 * a one-sentence career recommendation. All 200 calls run as bash
 * background jobs.
 *
 * ## Running
 *
 * ```bash
 * ANTHROPIC_API_KEY=sk-... npx tsx examples/sandbox/sandbox-ptc.ts
 * ```
 */

import "dotenv/config";

import { z } from "zod/v4";

import { ChatAnthropic } from "@langchain/anthropic";
import { createMiddleware, tool, HumanMessage, AIMessage } from "langchain";
import { createDeepAgent, createSandboxPtcMiddleware } from "deepagents";
import { VfsSandbox } from "@langchain/node-vfs";

import { generateCsv, downloadDeliverables } from "./utils/sandbox-ptc.js";

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

The sandbox contains \`data/employees.csv\` with columns: id, name, age, department, years_at_company (100 rows).`;

const csv = generateCsv(100);

console.log("Creating VFS Sandbox...\n");
const sandbox = await VfsSandbox.create({
  initialFiles: { "/data/employees.csv": csv },
});
console.log(`  Sandbox ID: ${sandbox.id}`);
console.log(`  100 employee records loaded\n`);

try {
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
    backend: sandbox,
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
      createSandboxPtcMiddleware({ backend: sandbox, ptc: true }),
      // @ts-expect-error type issue with branded AgentMiddleware type
      ptcOnlyToolsMiddleware,
    ],
  });

  console.log(
    "Running: 100 parallel classify + 100 parallel analyst subagents...\n",
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
          `Classify all 100 employees and spawn 100 analyst subagents in parallel.
Save classifications to /tmp/classifications/<id>.json and analyst reports to /tmp/analyst_reports/<id>.txt.`,
        ),
      ],
    },
    { recursionLimit: 100 },
  );

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const last = result.messages.findLast(AIMessage.isInstance);
  if (last) {
    console.log(`\nAgent Response (${elapsed}s total):\n`);
    console.log(last.content);
  }

  await downloadDeliverables(sandbox);
} finally {
  console.log("\nCleaning up sandbox...");
  await sandbox.stop();
  console.log("Done.");
}
