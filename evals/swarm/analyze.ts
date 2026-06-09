/**
 * Post-hoc analysis script for swarm vs baseline eval experiments.
 *
 * Fetches runs from LangSmith, groups by pattern/condition/scale,
 * aggregates metrics, computes swarm vs baseline deltas, and prints
 * a markdown summary to stdout.
 *
 * Usage:
 *   LANGSMITH_API_KEY=... npx tsx analyze.ts --project sonnet-4-6
 */
import { Client } from "langsmith";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AggregatedRow {
  pattern: string;
  condition: string;
  scale: number | null;
  metrics: Record<string, { mean: number; count: number }>;
  tokens: { prompt: number; completion: number; total: number };
}

interface DeltaRow {
  pattern: string;
  scale: number | null;
  deltas: Record<string, number>;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse --project from argv, falling back to EVAL_RUNNER env var.
 */
function parseProjectName(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--project");
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }

  const envRunner = process.env.EVAL_RUNNER;
  if (envRunner) {
    return envRunner;
  }

  console.error(
    "Usage: npx tsx analyze.ts --project <project-name>\n" +
      "       Or set EVAL_RUNNER env var.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

/**
 * Fetch all root runs for a LangSmith project and group them by
 * (pattern, condition, scale).
 *
 * @param projectName - The LangSmith project name (e.g. "sonnet-4-6").
 * @returns Aggregated metrics for each group.
 */
async function fetchAndAggregate(
  projectName: string,
): Promise<AggregatedRow[]> {
  const client = new Client();

  const buckets = new Map<
    string,
    {
      pattern: string;
      condition: string;
      scale: number | null;
      metricSums: Record<string, { sum: number; count: number }>;
      tokenSums: { prompt: number; completion: number; total: number };
      runCount: number;
    }
  >();

  for await (const run of client.listRuns({
    projectName,
    isRoot: true,
  })) {
    const inputs = run.inputs as Record<string, unknown> | undefined;
    if (!inputs?.pattern || !inputs?.condition) continue;

    const pattern = String(inputs.pattern);
    const condition = String(inputs.condition);
    const scale =
      inputs.scale != null ? Number(inputs.scale) : null;
    const key = `${pattern}::${condition}::${scale}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        pattern,
        condition,
        scale,
        metricSums: {},
        tokenSums: { prompt: 0, completion: 0, total: 0 },
        runCount: 0,
      };
      buckets.set(key, bucket);
    }

    bucket.runCount++;
    bucket.tokenSums.prompt += run.prompt_tokens ?? 0;
    bucket.tokenSums.completion += run.completion_tokens ?? 0;
    bucket.tokenSums.total += run.total_tokens ?? 0;

    const stats = run.feedback_stats as
      | Record<string, unknown>
      | undefined;
    if (!stats) continue;

    for (const [metricKey, value] of Object.entries(stats)) {
      if (!bucket.metricSums[metricKey]) {
        bucket.metricSums[metricKey] = { sum: 0, count: 0 };
      }
      const entry = bucket.metricSums[metricKey];

      // feedback_stats values may be { avg, count } objects or raw numbers
      if (typeof value === "number") {
        entry.sum += value;
        entry.count += 1;
      } else if (
        typeof value === "object" &&
        value != null &&
        "avg" in value
      ) {
        const avg = (value as { avg: number }).avg;
        entry.sum += avg;
        entry.count += 1;
      }
    }
  }

  const rows: AggregatedRow[] = [];
  for (const bucket of buckets.values()) {
    const metrics: Record<string, { mean: number; count: number }> = {};
    for (const [k, v] of Object.entries(bucket.metricSums)) {
      metrics[k] = {
        mean: v.count > 0 ? v.sum / v.count : 0,
        count: v.count,
      };
    }

    rows.push({
      pattern: bucket.pattern,
      condition: bucket.condition,
      scale: bucket.scale,
      metrics,
      tokens: {
        prompt: Math.round(bucket.tokenSums.prompt / bucket.runCount),
        completion: Math.round(
          bucket.tokenSums.completion / bucket.runCount,
        ),
        total: Math.round(bucket.tokenSums.total / bucket.runCount),
      },
    });
  }

  rows.sort((a, b) => {
    const pc = a.pattern.localeCompare(b.pattern);
    if (pc !== 0) return pc;
    const sc = (a.scale ?? 0) - (b.scale ?? 0);
    if (sc !== 0) return sc;
    return a.condition.localeCompare(b.condition);
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

/**
 * Compute deltas (swarm - baseline) for each metric, grouped by
 * pattern and scale.
 *
 * @param rows - The aggregated rows.
 * @returns One row per (pattern, scale) with metric deltas.
 */
function computeDeltas(rows: AggregatedRow[]): DeltaRow[] {
  const byKey = new Map<string, { baseline?: AggregatedRow; swarm?: AggregatedRow }>();

  for (const row of rows) {
    const key = `${row.pattern}::${row.scale}`;
    const entry = byKey.get(key) ?? {};
    if (row.condition === "baseline") entry.baseline = row;
    if (row.condition === "swarm") entry.swarm = row;
    byKey.set(key, entry);
  }

  const deltas: DeltaRow[] = [];
  for (const [, pair] of byKey) {
    if (!pair.baseline || !pair.swarm) continue;

    const metricKeys = new Set([
      ...Object.keys(pair.baseline.metrics),
      ...Object.keys(pair.swarm.metrics),
    ]);

    const d: Record<string, number> = {};
    for (const k of metricKeys) {
      const bVal = pair.baseline.metrics[k]?.mean ?? 0;
      const sVal = pair.swarm.metrics[k]?.mean ?? 0;
      d[k] = sVal - bVal;
    }

    deltas.push({
      pattern: pair.swarm.pattern,
      scale: pair.swarm.scale,
      deltas: d,
    });
  }

  deltas.sort((a, b) => {
    const pc = a.pattern.localeCompare(b.pattern);
    if (pc !== 0) return pc;
    return (a.scale ?? 0) - (b.scale ?? 0);
  });

  return deltas;
}

// ---------------------------------------------------------------------------
// Markdown formatting
// ---------------------------------------------------------------------------

/**
 * Collect all unique metric keys across rows, in a stable order.
 */
function collectMetricKeys(rows: AggregatedRow[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row.metrics)) {
      keys.add(k);
    }
  }

  const preferred = [
    "coverage",
    "recall",
    "precision",
    "judge_score",
    "pattern_verified",
    "structural",
    "steps",
  ];
  const ordered: string[] = [];
  for (const k of preferred) {
    if (keys.has(k)) {
      ordered.push(k);
      keys.delete(k);
    }
  }
  for (const k of [...keys].sort()) {
    ordered.push(k);
  }
  return ordered;
}

/**
 * Format a number for display: 2 decimal places for fractions, integer for counts.
 */
function fmt(val: number): string {
  if (Number.isInteger(val) && Math.abs(val) >= 2) return String(val);
  return val.toFixed(2);
}

/**
 * Format a delta value with a +/- prefix.
 */
function fmtDelta(val: number): string {
  const sign = val >= 0 ? "+" : "";
  return sign + fmt(val);
}

/**
 * Format aggregated rows and deltas into a markdown summary string.
 *
 * @param rows - The aggregated metric rows.
 * @param deltas - The computed deltas.
 * @param projectName - The project name for the heading.
 * @returns Markdown-formatted summary.
 */
function formatMarkdown(
  rows: AggregatedRow[],
  deltas: DeltaRow[],
  projectName: string,
): string {
  const metricKeys = collectMetricKeys(rows);
  const lines: string[] = [];

  lines.push(`# Swarm vs Baseline Analysis: ${projectName}\n`);

  // Aggregated metrics table
  lines.push("## Aggregated Metrics\n");
  const metricHeader = ["Pattern", "Condition", "Scale", ...metricKeys];
  lines.push("| " + metricHeader.join(" | ") + " |");
  lines.push("| " + metricHeader.map(() => "---").join(" | ") + " |");

  for (const row of rows) {
    const cells = [
      row.pattern,
      row.condition,
      row.scale != null ? String(row.scale) : "-",
      ...metricKeys.map((k) =>
        row.metrics[k] != null ? fmt(row.metrics[k].mean) : "-",
      ),
    ];
    lines.push("| " + cells.join(" | ") + " |");
  }

  // Delta table
  lines.push("\n## Swarm vs Baseline Deltas\n");
  lines.push(
    "> Positive values mean swarm outperformed baseline. " +
      "For `steps`, negative means swarm was more efficient.\n",
  );

  const deltaKeys = metricKeys.filter((k) =>
    deltas.some((d) => d.deltas[k] != null),
  );
  const deltaHeader = [
    "Pattern",
    "Scale",
    ...deltaKeys.map((k) => `Δ${k}`),
  ];
  lines.push("| " + deltaHeader.join(" | ") + " |");
  lines.push("| " + deltaHeader.map(() => "---").join(" | ") + " |");

  for (const d of deltas) {
    const cells = [
      d.pattern,
      d.scale != null ? String(d.scale) : "-",
      ...deltaKeys.map((k) =>
        d.deltas[k] != null ? fmtDelta(d.deltas[k]) : "-",
      ),
    ];
    lines.push("| " + cells.join(" | ") + " |");
  }

  // Token usage table
  lines.push("\n## Token Usage (per run average)\n");
  const tokenHeader = [
    "Pattern",
    "Condition",
    "Scale",
    "Prompt",
    "Completion",
    "Total",
  ];
  lines.push("| " + tokenHeader.join(" | ") + " |");
  lines.push("| " + tokenHeader.map(() => "---").join(" | ") + " |");

  for (const row of rows) {
    const cells = [
      row.pattern,
      row.condition,
      row.scale != null ? String(row.scale) : "-",
      row.tokens.prompt.toLocaleString(),
      row.tokens.completion.toLocaleString(),
      row.tokens.total.toLocaleString(),
    ];
    lines.push("| " + cells.join(" | ") + " |");
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Main entry point. Parses CLI arguments, fetches data from LangSmith,
 * computes analysis, and prints the markdown summary to stdout.
 */
async function main(): Promise<void> {
  const projectName = parseProjectName();

  console.error(`Fetching runs for project: ${projectName}...`);
  const rows = await fetchAndAggregate(projectName);

  if (rows.length === 0) {
    console.error("No runs found. Check that the project name is correct.");
    process.exit(1);
  }

  console.error(`Found ${rows.length} groups across runs.`);
  const deltas = computeDeltas(rows);

  const markdown = formatMarkdown(rows, deltas, projectName);
  console.log(markdown);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
