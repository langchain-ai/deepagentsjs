import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const DIR = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "results",
);

/** A judge result (score + its written explanation). */
export interface JudgeOut {
  score: number;
  reasoning: string;
}

/**
 * Append one test's results to a local JSONL file, including the judge and
 * pattern-judge reasoning text. Works regardless of LangSmith tracking, so
 * the reasoning is always captured for the report.
 *
 * Records land in `results/<EVAL_RUNNER>.jsonl`.
 */
export function recordRun(
  inputs: { pattern: string; condition: string; scale?: number },
  score: object,
  judge: JudgeOut,
  patternJudge: JudgeOut,
): void {
  const metrics: Record<string, number> = {};
  for (const [k, v] of Object.entries(score)) {
    if (typeof v === "number") metrics[k] = v;
  }

  const record = {
    pattern: inputs.pattern,
    condition: inputs.condition,
    scale: inputs.scale ?? null,
    metrics,
    judge_score: judge.score,
    judge_reasoning: judge.reasoning,
    pattern_verified: patternJudge.score,
    pattern_reasoning: patternJudge.reasoning,
    ts: new Date().toISOString(),
  };

  const runner = process.env.EVAL_RUNNER ?? "local";
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(
    path.join(DIR, `${runner}.jsonl`),
    JSON.stringify(record) + "\n",
  );
}
