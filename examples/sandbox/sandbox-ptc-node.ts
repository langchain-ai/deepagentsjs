/* eslint-disable no-console */
/**
 * Sandbox PTC Example — Node.js with Skill
 *
 * The agent is given a skill (employee-classifier) that contains the
 * classification logic as a reference implementation. Instead of calling
 * a tool, the agent writes a Node.js script that:
 *
 * 1. Implements the classification locally (from the skill)
 * 2. Classifies all 100 employees in-process
 * 3. Spawns 100 analyst subagents via `spawnAgent()` (auto-injected global)
 *
 * This demonstrates that PTC isn't limited to tool_call — the agent can
 * combine local computation with subagent spawning in a single script.
 *
 * ## Running
 *
 * ```bash
 * ANTHROPIC_API_KEY=sk-... npx tsx examples/sandbox/sandbox-ptc-node.ts
 * ```
 */

import "dotenv/config";

import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, AIMessage } from "langchain";
import { createDeepAgent, createSandboxPtcMiddleware } from "deepagents";
import { VfsSandbox } from "@langchain/node-vfs";

import {
  generateCsv,
  loadSkillFiles,
  downloadDeliverables,
} from "./utils/sandbox-ptc.js";

// ---------------------------------------------------------------------------
// System prompt — classification comes from the skill, not the prompt
// ---------------------------------------------------------------------------

const systemPrompt = `You are a data-processing agent.

The sandbox contains \`data/employees.csv\` with 100 employee records (columns: id, name, age, department, years_at_company).

When asked to process data, write a **Node.js** script and run it with \`node\`.
Use the employee-classifier skill for the classification logic.
Use \`spawnAgent()\` (auto-injected global via PTC) for subagent calls.
Note: \`spawnAgent()\` is synchronous (blocks until the subagent returns).

Save classification results to \`/tmp/classifications/<id>.json\` and
analyst reports to \`/tmp/analyst_reports/<id>.txt\`.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const csv = generateCsv(100);
const skillFiles = loadSkillFiles();

console.log("Creating VFS Sandbox...\n");
const sandbox = await VfsSandbox.create({
  initialFiles: { "/data/employees.csv": csv, ...skillFiles },
});
console.log(`  Sandbox ID: ${sandbox.id}`);
console.log(`  100 employee records loaded\n`);

try {
  const agent = createDeepAgent({
    model: new ChatAnthropic({
      model: "claude-sonnet-4-20250514",
      temperature: 0,
    }),
    systemPrompt,
    backend: sandbox,
    skills: ["/skills/"],
    subagents: [
      {
        name: "analyst",
        description: "Provides career recommendations for individual employees",
        systemPrompt: `You are an HR analyst. Given an employee's classification data,
provide exactly ONE sentence of career recommendation. Be specific and actionable.
Do not use markdown. Keep it under 30 words.`,
        model: new ChatAnthropic({ model: "claude-haiku-4-5", temperature: 0 }),
      },
    ],
    middleware: [createSandboxPtcMiddleware({ backend: sandbox, ptc: true })],
  });

  console.log(
    "Running: Node.js script with classification (from skill) + 100 analyst subagents...\n",
  );
  const t0 = performance.now();

  const result = await agent.invoke(
    {
      messages: [
        new HumanMessage(
          `Classify all 100 employees from data/employees.csv using the employee-classifier skill,
then spawn 100 analyst subagents to provide career recommendations.
Write a single Node.js script that does both. Run it with node.`,
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
