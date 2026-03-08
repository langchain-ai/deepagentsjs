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

import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { createMiddleware, tool } from "langchain";
import { z } from "zod/v4";

import { createDeepAgent, createSandboxPtcMiddleware } from "deepagents";
import { VfsSandbox } from "@langchain/node-vfs";

// ---------------------------------------------------------------------------
// 1. Data: 100 employee records
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

// ---------------------------------------------------------------------------
// 2. PTC-only tool (registered but hidden from the model)
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

// ---------------------------------------------------------------------------
// 3. System prompt
// ---------------------------------------------------------------------------

const systemPrompt = `You are a data-processing agent with PTC (Programmatic Tool Calling)
and an "analyst" subagent.

## PTC functions available inside \`execute\`

### tool_call classify_record '<json>'
Input: \`{"name":"<str>","age":<int>,"department":"<str>","years_at_company":<int>}\`
Output: \`{"name":"...","seniority":"junior"|"mid-level"|"senior","age_group":"under-30"|"30-39"|"40-54"|"55+","department":"...","promotion_eligible":true|false}\`

### spawn_agent "<description>" "analyst"
Spawns the analyst subagent with the given task description. Returns the analyst's text response.
The description must be a single argument — use quotes around it.

## Sandbox filesystem
Files use **relative paths**. Data: \`data/employees.csv\` (CSV: id,name,age,department,years_at_company)

## Exact script to use

\`\`\`bash
#!/bin/bash
mkdir -p /tmp/cls /tmp/analysis

# Phase 1: classify all 100 employees in parallel
echo "Phase 1: classifying 100 employees..."
line_num=0
while IFS=, read -r id name age dept years; do
  line_num=$((line_num + 1)); [ $line_num -eq 1 ] && continue
  ( result=$(tool_call classify_record "{\\"name\\":\\"$name\\",\\"age\\":$age,\\"department\\":\\"$dept\\",\\"years_at_company\\":$years}")
    echo "$result" > /tmp/cls/$id.json ) &
done < data/employees.csv
wait
echo "Phase 1 done: $(ls /tmp/cls/*.json | wc -l | tr -d ' ') classified"

# Phase 2: spawn 100 analyst subagents in parallel, one per record
echo "Phase 2: spawning 100 analyst subagents..."
for id in $(seq 1 100); do
  ( record=$(cat /tmp/cls/$id.json 2>/dev/null)
    if [ -n "$record" ]; then
      analysis=$(spawn_agent "Give a one-sentence career recommendation for this employee: $record" "analyst")
      echo "$analysis" > /tmp/analysis/$id.txt
    fi ) &
done
wait
echo "Phase 2 done: $(ls /tmp/analysis/*.txt 2>/dev/null | wc -l | tr -d ' ') analysed"

# Print sample results
echo ""
echo "=== Sample results (first 5) ==="
for id in $(seq 1 5); do
  echo "--- Employee $id ---"
  echo "Classification: $(cat /tmp/cls/$id.json 2>/dev/null)"
  echo "Recommendation: $(cat /tmp/analysis/$id.txt 2>/dev/null)"
  echo ""
done

echo "=== TOTALS ==="
echo "Classified: $(ls /tmp/cls/*.json | wc -l | tr -d ' ')"
echo "Analysed:   $(ls /tmp/analysis/*.txt 2>/dev/null | wc -l | tr -d ' ')"
\`\`\`

## Rules
1. Use a SINGLE \`execute\` call with the EXACT script above — do not modify it.
2. Do NOT explore files or call tools directly.
3. Use relative paths (\`data/...\`), never absolute (\`/data/...\`).`;

// ---------------------------------------------------------------------------
// 4. Main
// ---------------------------------------------------------------------------

async function main() {
  const csv = generateCsv(100);

  console.log("Creating VFS Sandbox...\n");
  const sandbox = await VfsSandbox.create({
    initialFiles: { "/data/employees.csv": csv },
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
      subagents: [
        {
          name: "analyst",
          description:
            "Provides career recommendations for individual employees",
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
        ptcOnlyToolsMiddleware,
      ],
    });

    console.log(
      "Running: 100 parallel classify + 100 parallel analyst subagents...\n",
    );
    const t0 = performance.now();

    const result = await agent.invoke(
      {
        messages: [
          new HumanMessage(
            "Run the script to classify all 100 employees and spawn 100 analyst subagents in parallel.",
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
