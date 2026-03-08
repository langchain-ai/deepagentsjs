/* eslint-disable no-console */
/**
 * Sandbox PTC (Programmatic Tool Calling) Example
 *
 * Demonstrates how to use `createDeepAgent` with the PTC middleware so the
 * LLM can write bash scripts that call tools and spawn subagents in
 * parallel — directly from within the sandbox.
 *
 * The agent is given:
 * - A CSV of 100 employee records
 * - A TSV of 100 research topics
 * - Two PTC-only tools: `classify_record` and `research_topic`
 *
 * These tools are hidden from the model (it cannot call them directly).
 * Instead, the system prompt teaches the agent to use `tool_call` inside
 * `execute` to fire all 200 calls as parallel bash background jobs.
 *
 * ## How PTC integrates with createDeepAgent
 *
 * `createSandboxPtcMiddleware` is applied as custom middleware. Because
 * custom middleware runs after built-in middleware, the PTC middleware sees
 * all registered tools — including the `task` tool from
 * `createSubAgentMiddleware`. It intercepts `execute` tool calls, instruments
 * the command with the PTC bash runtime, and routes IPC markers through the
 * `PtcExecutionEngine`.
 *
 * ## Running
 *
 * ```bash
 * ANTHROPIC_API_KEY=sk-... npx tsx examples/sandbox/sandbox-ptc.ts
 * ```
 */

import "dotenv/config";

import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { createMiddleware, tool } from "langchain";
import { z } from "zod/v4";

import { createDeepAgent, createSandboxPtcMiddleware } from "deepagents";
import { VfsSandbox } from "@langchain/node-vfs";

// ---------------------------------------------------------------------------
// 1. Data: 100 employee records + 100 research topics
// ---------------------------------------------------------------------------

const DEPARTMENTS = [
  "Engineering",
  "Sales",
  "Marketing",
  "Finance",
  "Operations",
  "HR",
  "Legal",
  "Support",
];
const FIRST_NAMES = [
  "Alice",
  "Bob",
  "Carol",
  "Dave",
  "Eve",
  "Frank",
  "Grace",
  "Hank",
  "Iris",
  "Jack",
];
const LAST_NAMES = [
  "Smith",
  "Chen",
  "Patel",
  "Garcia",
  "Kim",
  "Müller",
  "Tanaka",
  "Silva",
  "Nguyen",
  "Lopez",
];
const TOPICS = [
  "quantum computing",
  "fusion energy",
  "CRISPR gene editing",
  "neural interfaces",
  "solid-state batteries",
  "carbon capture",
  "autonomous vehicles",
  "protein folding",
  "room-temp superconductors",
  "space mining",
  "synthetic biology",
  "ocean thermal energy",
  "topological qubits",
  "metamaterials",
  "microbiome therapeutics",
  "plasma propulsion",
  "photonic chips",
  "biodegradable electronics",
  "swarm robotics",
  "holographic displays",
];

function generateCsv(n: number): string {
  const rows = ["id,name,age,department,years_at_company"];
  for (let i = 1; i <= n; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const last =
      LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
    rows.push(
      `${i},${first} ${last},${22 + ((i * 7) % 40)},${DEPARTMENTS[i % DEPARTMENTS.length]},${Math.max(1, (i * 3) % 25)}`,
    );
  }
  return rows.join("\n") + "\n";
}

function generateTopics(n: number): string {
  return (
    Array.from(
      { length: n },
      (_, i) =>
        `${TOPICS[i % TOPICS.length]}\t${i % 3 === 0 ? "deep" : "standard"}`,
    ).join("\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// 2. PTC-only tools (registered but hidden from the model)
// ---------------------------------------------------------------------------

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

const researchTool = tool(
  async (input: { topic: string; depth: string }) => {
    const wordCount = input.depth === "deep" ? 120 : 60;
    return JSON.stringify({
      topic: input.topic,
      summary: `${input.topic}: A ${input.depth} analysis covering ${wordCount} words of findings.`,
      key_findings: [
        `Breakthrough in ${input.topic} expected within 3-5 years`,
        `Global investment grew 40% YoY`,
        `${Math.floor(Math.random() * 50 + 10)} active research groups worldwide`,
      ],
      confidence: +(0.85 + Math.random() * 0.1).toFixed(2),
    });
  },
  {
    name: "research_topic",
    description:
      "Research a topic in depth — simulates subagent work, returns summary + key findings",
    schema: z.object({ topic: z.string(), depth: z.string() }),
  },
);

/**
 * Middleware that registers the PTC-only tools with the agent (so the PTC
 * engine can discover them) but hides them from the model so it must use
 * `tool_call` inside `execute` to reach them.
 */
const ptcOnlyToolsMiddleware = createMiddleware({
  name: "PtcOnlyTools",
  tools: [classifyTool, researchTool],
  wrapModelCall: async (request, handler) => {
    const hidden = new Set(["classify_record", "research_topic"]);
    const visibleTools = (request.tools as { name: string }[]).filter(
      (t) => !hidden.has(t.name),
    );
    return handler({ ...request, tools: visibleTools });
  },
});

// ---------------------------------------------------------------------------
// 3. System prompt
// ---------------------------------------------------------------------------

const systemPrompt = `You are a data-processing agent with access to a sandboxed shell and
Programmatic Tool Calling (PTC).

## PTC — calling tools from bash

Inside any \`execute\` command the shell function \`tool_call\` is pre-loaded.
Two tools are available ONLY via \`tool_call\` — you CANNOT call them as direct tool calls.

### classify_record

Input: \`{"name":"<string>","age":<int>,"department":"<string>","years_at_company":<int>}\`
Output JSON fields: \`name\` (string), \`seniority\` ("junior"|"mid-level"|"senior"), \`age_group\` ("under-30"|"30-39"|"40-54"|"55+"), \`department\` (string), \`promotion_eligible\` (boolean)

Example:
\`\`\`bash
result=$(tool_call classify_record '{"name":"Alice","age":30,"department":"Engineering","years_at_company":5}')
# → {"name":"Alice","seniority":"mid-level","age_group":"30-39","department":"Engineering","promotion_eligible":true}
\`\`\`

### research_topic

Input: \`{"topic":"<string>","depth":"standard"|"deep"}\`
Output JSON fields: \`topic\`, \`summary\`, \`key_findings\` (array of 3 strings), \`confidence\` (float)

Example:
\`\`\`bash
result=$(tool_call research_topic '{"topic":"quantum computing","depth":"deep"}')
# → {"topic":"quantum computing","summary":"...","key_findings":["...","...","..."],"confidence":0.91}
\`\`\`

## Sandbox filesystem

All file paths are **relative to the working directory**. Do NOT use absolute paths.
Data files are at:
- \`data/employees.csv\` — CSV with columns: id, name, age, department, years_at_company
- \`data/topics.tsv\` — TSV with columns: topic, depth

## Script template

Use this exact pattern — launch every tool_call as a background job, then wait:

\`\`\`bash
#!/bin/bash
mkdir -p /tmp/cls /tmp/res

# Classify all employees in parallel
line_num=0
while IFS=, read -r id name age dept years; do
  line_num=$((line_num + 1))
  [ $line_num -eq 1 ] && continue
  ( result=$(tool_call classify_record "{\\"name\\":\\"$name\\",\\"age\\":$age,\\"department\\":\\"$dept\\",\\"years_at_company\\":$years}")
    echo "$result" > /tmp/cls/$id.json ) &
done < data/employees.csv

# Research all topics in parallel
idx=0
while IFS=$'\\t' read -r topic depth; do
  idx=$((idx + 1))
  ( result=$(tool_call research_topic "{\\"topic\\":\\"$topic\\",\\"depth\\":\\"$depth\\"}")
    echo "$result" > /tmp/res/$idx.json ) &
done < data/topics.tsv

wait
echo "Done — $(ls /tmp/cls/*.json | wc -l) employees, $(ls /tmp/res/*.json | wc -l) topics"
\`\`\`

## Rules

1. Use a SINGLE \`execute\` call with the complete script.
2. Do NOT explore files first — the schema above is authoritative.
3. Do NOT call classify_record or research_topic as direct tool calls.
4. Use \`data/...\` (relative), never \`/data/...\` (absolute).
5. Match the exact output field values above when counting results (e.g. "junior" not "Junior", "under-30" not "Young").`;

// ---------------------------------------------------------------------------
// 4. Main
// ---------------------------------------------------------------------------

async function main() {
  const csv = generateCsv(100);
  const topics = generateTopics(100);

  console.log("Creating VFS Sandbox...\n");
  const sandbox = await VfsSandbox.create({
    initialFiles: {
      "/data/employees.csv": csv,
      "/data/topics.tsv": topics,
    },
  });
  console.log(`  Sandbox ID: ${sandbox.id}`);
  console.log(`  100 employee records + 100 research topics loaded\n`);

  try {
    const agent = createDeepAgent({
      model: new ChatAnthropic({
        model: "claude-sonnet-4-20250514",
        temperature: 0,
      }),
      systemPrompt,
      backend: sandbox,
      middleware: [
        // PTC middleware intercepts `execute` tool calls and instruments
        // them with the PTC bash runtime. It discovers classify_record and
        // research_topic from the agent's tool list and makes them callable
        // via `tool_call <name> '<json>'` inside bash scripts.
        createSandboxPtcMiddleware({ backend: sandbox, ptc: true }),
        // This middleware registers the tools but hides them from the model,
        // forcing it to use tool_call in bash rather than direct tool calls.
        ptcOnlyToolsMiddleware,
      ],
    });

    console.log(
      "Running agent — it will write and execute a bash script with 200 parallel tool_call invocations...\n",
    );
    const t0 = performance.now();

    const result = await agent.invoke(
      {
        messages: [
          new HumanMessage(
            "Process all 100 employee records and all 100 research topics in parallel using tool_call inside a single execute call. Print summary statistics when done.",
          ),
        ],
      },
      { recursionLimit: 100 },
    );

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    // Show the final AI response
    const last = result.messages.findLast(AIMessage.isInstance);
    if (last) {
      console.log(`\nAgent Response (${elapsed}s total):\n`);
      console.log(last.content);

      console.log(result.messages);
    }
  } finally {
    console.log("\nCleaning up sandbox...");
    await sandbox.stop();
    console.log("Done.");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
