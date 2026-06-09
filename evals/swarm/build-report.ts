/**
 * Fold captured eval results into REPORT.md.
 *
 * Reads `results/<runner>.jsonl` (written by `recordRun` during the suite),
 * aggregates by pattern/scale/condition, and replaces the block between
 * `<!-- RESULTS:START -->` and `<!-- RESULTS:END -->` in REPORT.md with a
 * compact metrics table plus the judge reasoning.
 *
 * Usage: npx tsx build-report.ts [--project <runner>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const DIR = path.dirname(url.fileURLToPath(import.meta.url));

interface Record_ {
  pattern: string;
  condition: string;
  scale: number | null;
  metrics: Record<string, number>;
  judge_score: number;
  judge_reasoning: string;
  pattern_verified: number;
  pattern_reasoning: string;
}

interface Cell {
  judge: number;
  metrics: Record<string, number>;
  reasoning: string;
  n: number;
}

function runnerName(): string {
  const i = process.argv.indexOf("--project");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.EVAL_RUNNER ?? "local";
}

function load(runner: string): Record_[] {
  const file = path.join(DIR, "results", `${runner}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record_);
}

const fmt = (n: number | undefined): string =>
  n == null ? "-" : Number.isInteger(n) ? String(n) : n.toFixed(2);

/** Average duplicate runs into one cell per pattern/scale/condition. */
function aggregate(records: Record_[]): Map<string, Cell> {
  const groups = new Map<string, Record_[]>();
  for (const r of records) {
    const key = `${r.pattern}::${r.scale}::${r.condition}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const cells = new Map<string, Cell>();
  for (const [key, rs] of groups) {
    const mean = (pick: (r: Record_) => number) =>
      rs.reduce((s, r) => s + pick(r), 0) / rs.length;
    const metricKeys = new Set<string>();
    rs.forEach((r) => Object.keys(r.metrics).forEach((k) => metricKeys.add(k)));
    const metrics: Record<string, number> = {};
    for (const k of metricKeys) {
      metrics[k] = mean((r) => r.metrics[k] ?? 0);
    }
    cells.set(key, {
      judge: mean((r) => r.judge_score),
      metrics,
      reasoning: rs[rs.length - 1].judge_reasoning,
      n: rs.length,
    });
  }
  return cells;
}

const PATTERNS = [
  "classify-and-act",
  "fanout-and-synthesize",
  "adversarial-verification",
  "generate-and-filter",
  "loop-until-done",
];
const SCALES = [50, 200, 500, 1000];

/** A baseline/swarm pair like "0.40 / 0.62". */
function pair(
  cells: Map<string, Cell>,
  pattern: string,
  scale: number,
  get: (c: Cell) => number | undefined,
): string {
  const b = cells.get(`${pattern}::${scale}::baseline`);
  const s = cells.get(`${pattern}::${scale}::swarm`);
  if (!b && !s) return "";
  return `${fmt(b && get(b))} / ${fmt(s && get(s))}`;
}

function buildMarkdown(cells: Map<string, Cell>): string {
  if (cells.size === 0) {
    return "_No results captured yet. Run the suite, then `npx tsx build-report.ts`._";
  }

  const lines: string[] = [];
  lines.push("Values are **baseline / swarm**. Higher is better except cost.\n");
  lines.push("| Pattern | N | Judge | Recall | Precision | Coverage |");
  lines.push("|---|---|---|---|---|---|");

  for (const pattern of PATTERNS) {
    for (const scale of SCALES) {
      const b = cells.get(`${pattern}::${scale}::baseline`);
      const s = cells.get(`${pattern}::${scale}::swarm`);
      if (!b && !s) continue;
      lines.push(
        `| ${pattern} | ${scale} | ${pair(cells, pattern, scale, (c) => c.judge)} | ` +
          `${pair(cells, pattern, scale, (c) => c.metrics.recall)} | ` +
          `${pair(cells, pattern, scale, (c) => c.metrics.precision)} | ` +
          `${pair(cells, pattern, scale, (c) => c.metrics.coverage)} |`,
      );
    }
  }

  // Judge reasoning, grouped by pattern.
  lines.push("\n### Judge notes\n");
  for (const pattern of PATTERNS) {
    const entries = [...cells.entries()]
      .filter(([k]) => k.startsWith(`${pattern}::`))
      .sort();
    if (entries.length === 0) continue;
    lines.push(`**${pattern}**\n`);
    for (const [key, cell] of entries) {
      const [, scale, condition] = key.split("::");
      lines.push(
        `- ${condition} @ N=${scale} (judge ${fmt(cell.judge)}). ${cell.reasoning}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function inject(reportPath: string, block: string): void {
  const START = "<!-- RESULTS:START -->";
  const END = "<!-- RESULTS:END -->";
  const md = fs.readFileSync(reportPath, "utf-8");
  const start = md.indexOf(START);
  const end = md.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(`REPORT.md is missing ${START} / ${END} markers`);
  }
  const next =
    md.slice(0, start + START.length) + "\n" + block + "\n" + md.slice(end);
  fs.writeFileSync(reportPath, next);
}

const runner = runnerName();
const cells = aggregate(load(runner));
inject(path.join(DIR, "REPORT.md"), buildMarkdown(cells));
console.error(
  `Updated REPORT.md from ${cells.size} result cell(s) [runner: ${runner}].`,
);
