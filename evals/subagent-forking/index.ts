import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import type { EvalRunner } from "@deepagents/evals";
import {
  EXPECTED_FACTS,
  QUERY,
  QUERY_WITH_EXPLICIT_INSTRUCTION,
  RUNBOOK_PATH,
  buildRunbookWriterSubagent,
  initialFiles,
} from "./scenario.js";
import { UsageCollector, logUsageFeedback } from "./metrics.js";

interface Arm {
  name: string;
  mode: "handoff" | "fork";
  query: string;
}

// Same task, same model, only `mode` (and, for the third arm, the delegation
// instruction) differs — isolating what forking actually changes.
const ARMS: Arm[] = [
  { name: "handoff (baseline)", mode: "handoff", query: QUERY },
  {
    name: "handoff + explicit instruction",
    mode: "handoff",
    query: QUERY_WITH_EXPLICIT_INSTRUCTION,
  },
  { name: "fork", mode: "fork", query: QUERY },
];

export function subagentForkingSuite(runner: EvalRunner): void {
  for (const arm of ARMS) {
    ls.test(
      `retry-timeout runbook delegation — ${arm.name}`,
      {
        inputs: { query: arm.query, mode: arm.mode },
        referenceOutputs: { expectedFacts: EXPECTED_FACTS },
      },
      async ({ inputs }) => {
        const usage = new UsageCollector();
        const start = Date.now();

        const result = await runner
          .extend({ subagents: [buildRunbookWriterSubagent(inputs.mode)] })
          .run({ query: inputs.query, initialFiles, callbacks: [usage] });

        const latencyMs = Date.now() - start;
        logUsageFeedback(usage.totals, latencyMs);

        const runbook = result.files[RUNBOOK_PATH] ?? "";
        for (const fact of EXPECTED_FACTS) {
          ls.logFeedback({
            key: `fact_present:${fact}`,
            score: runbook.includes(fact) ? 1 : 0,
          });
        }
        const allFactsPresent = EXPECTED_FACTS.every((fact) =>
          runbook.includes(fact),
        );
        ls.logFeedback({
          key: "all_facts_present",
          score: allFactsPresent ? 1 : 0,
        });

        // Sanity check only — did delegation actually write something. Fact
        // accuracy is scored via feedback above, not a hard pass/fail here,
        // since a realistic handoff-mode miss is exactly what we're measuring.
        expect(runbook.length).toBeGreaterThan(
          initialFiles[RUNBOOK_PATH].length,
        );
      },
    );
  }
}
