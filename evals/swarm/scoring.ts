/**
 * Artifact-based scoring for swarm vs baseline evals.
 *
 * Both conditions are required (via the query) to write their final
 * structured results to `/results/output.json`. Scoring parses that
 * artifact and compares it against ground truth deterministically —
 * no string-scanning of the trajectory, no condition bias from glob
 * listings, and real (bounded) precision/recall.
 */
import type { AgentTrajectory } from "@deepagents/evals";
import type { TicketGroundTruth, VulnerabilityGroundTruth } from "./fixtures.js";

/** Canonical path the agent is asked to write its results to. */
export const ARTIFACT_PATH = "/results/output.json";

// ---------------------------------------------------------------------------
// Artifact loading
// ---------------------------------------------------------------------------

/**
 * Locate and parse the results artifact from the trajectory's file system.
 *
 * Tolerant of leading-slash and `results/output.json` variants. Accepts
 * either a bare JSON array or `{ items: [...] }`. Returns null when the
 * artifact is missing or unparseable — callers treat that as "no
 * deliverable", scoring everything to zero.
 */
export function loadArtifact(
  trajectory: AgentTrajectory,
): Record<string, unknown>[] | null {
  const entry = Object.entries(trajectory.files).find(([path]) =>
    path.replace(/^\//, "").endsWith("results/output.json"),
  );
  if (!entry) return null;

  try {
    const parsed = JSON.parse(entry[1]);
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    if (
      parsed != null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      return (parsed as { items: Record<string, unknown>[] }).items;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether the trajectory contains a valid (parseable, non-empty) results
 * artifact. Replaces the old `structural` JSON-presence check with a
 * meaningful signal: did the agent honor the output contract?
 */
export function measureArtifactValid(trajectory: AgentTrajectory): number {
  const artifact = loadArtifact(trajectory);
  return artifact != null && artifact.length > 0 ? 1 : 0;
}

/**
 * Count total agent steps as a rough (per-condition, NOT cross-condition)
 * efficiency proxy. Swarm pushes work into subagent runs not counted here,
 * so compare tokens — not steps — across conditions.
 */
export function measureSteps(trajectory: AgentTrajectory): number {
  return trajectory.steps.length;
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/** Last path segment, slash-insensitive (e.g. "/src/a.ts" -> "a.ts"). */
function basename(p: string): string {
  const parts = String(p).split("/");
  return parts[parts.length - 1] || String(p);
}

/** Read a string-ish field from an artifact row by any of several keys. */
function readField(
  row: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

const VULN_ALIASES: Record<string, string[]> = {
  "sql-injection": ["sql injection", "sql-injection", "sqli", "query injection"],
  "path-traversal": [
    "path traversal",
    "path-traversal",
    "directory traversal",
    "lfi",
  ],
  xss: ["xss", "cross-site scripting", "cross site scripting", "script injection"],
  "command-injection": [
    "command injection",
    "command-injection",
    "os command",
    "shell injection",
    "rce",
  ],
  "insecure-deserialization": [
    "insecure deserialization",
    "prototype pollution",
    "proto pollution",
    "__proto__",
  ],
  ssrf: [
    "ssrf",
    "server-side request forgery",
    "server side request forgery",
    "request forgery",
  ],
  "hardcoded-secret": [
    "hardcoded secret",
    "hardcoded credential",
    "hardcoded api key",
    "hard-coded",
    "secret in source",
    "exposed api key",
  ],
  "weak-crypto": [
    "weak crypto",
    "weak hash",
    "weak hashing",
    "md5",
    "insecure hash",
    "broken crypto",
  ],
};

/** Whether a free-form type string refers to the given canonical vulnType. */
function typeMatches(reported: string, vulnType: string): boolean {
  const lower = reported.toLowerCase();
  // Always include the canonical key itself (hyphenated and spaced forms) so
  // a finding reported as the exact type matches, plus any human-phrasing aliases.
  const aliases = [
    vulnType,
    vulnType.replace(/-/g, " "),
    ...(VULN_ALIASES[vulnType] ?? []),
  ];
  return aliases.some((a) => lower.includes(a.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Pattern 1 — classify-and-act
// ---------------------------------------------------------------------------

export interface ClassificationScore {
  artifactValid: number;
  coverage: number;
  categoryAccuracy: number;
  urgentRecall: number;
  urgentPrecision: number;
}

/**
 * Score a classify-and-act artifact against ticket ground truth.
 *
 * Rows are matched to ground truth by file basename. Coverage is the
 * fraction of tickets present; categoryAccuracy is the fraction with the
 * correct category; urgentRecall/Precision score the `urgent` flag
 * against the known high-urgency tickets.
 */
export function scoreClassification(
  trajectory: AgentTrajectory,
  groundTruth: TicketGroundTruth[],
): ClassificationScore {
  const artifact = loadArtifact(trajectory);
  const zero: ClassificationScore = {
    artifactValid: 0,
    coverage: 0,
    categoryAccuracy: 0,
    urgentRecall: 0,
    urgentPrecision: 0,
  };
  if (!artifact) return zero;

  const byBase = new Map<string, Record<string, unknown>>();
  for (const row of artifact) {
    const file = readField(row, ["file", "path", "id"]);
    if (file) byBase.set(basename(file), row);
  }

  let present = 0;
  let correctCategory = 0;
  let predictedUrgent = 0;
  let urgentHits = 0;

  const actualUrgent = groundTruth.filter((g) => g.urgency === "high").length;

  for (const gt of groundTruth) {
    const row = byBase.get(basename(gt.path));
    if (!row) continue;
    present++;

    const category = readField(row, ["category"])?.toLowerCase();
    if (category === gt.category) correctCategory++;

    const urgentVal = row.urgent ?? row.urgency;
    const isUrgent =
      urgentVal === true ||
      String(urgentVal).toLowerCase() === "high" ||
      String(urgentVal).toLowerCase() === "true";
    if (isUrgent && gt.urgency === "high") urgentHits++;
  }

  // Count total urgent predictions (across all rows, matched or not) for precision.
  for (const row of artifact) {
    const urgentVal = row.urgent ?? row.urgency;
    if (
      urgentVal === true ||
      String(urgentVal).toLowerCase() === "high" ||
      String(urgentVal).toLowerCase() === "true"
    ) {
      predictedUrgent++;
    }
  }

  const total = groundTruth.length;
  return {
    artifactValid: artifact.length > 0 ? 1 : 0,
    coverage: total > 0 ? present / total : 1,
    categoryAccuracy: total > 0 ? correctCategory / total : 1,
    urgentRecall: actualUrgent > 0 ? urgentHits / actualUrgent : 1,
    urgentPrecision: predictedUrgent > 0 ? urgentHits / predictedUrgent : 0,
  };
}

// ---------------------------------------------------------------------------
// Patterns 2 & 3 — fanout / adversarial (vulnerability findings)
// ---------------------------------------------------------------------------

export interface VulnerabilityScore {
  artifactValid: number;
  coverage: number;
  recall: number;
  precision: number;
  found: number;
  expected: number;
  reported: number;
  falsePositives: number;
}

/**
 * Score a vulnerability artifact against seeded ground truth.
 *
 * Each artifact row is `{ file, vulnerabilities: [{ type }] }`. A reported
 * finding is a true positive when its file matches a ground-truth entry's
 * file (by basename) AND its type matches that entry's vulnType. Recall is
 * over ground-truth vulns; precision is over reported findings (real,
 * bounded denominator); falsePositives are reported findings matching no
 * ground-truth entry.
 */
export function scoreVulnerabilities(
  trajectory: AgentTrajectory,
  groundTruth: VulnerabilityGroundTruth[],
  allFilePaths: string[],
): VulnerabilityScore {
  const artifact = loadArtifact(trajectory);
  const zero: VulnerabilityScore = {
    artifactValid: 0,
    coverage: 0,
    recall: 0,
    precision: 0,
    found: 0,
    expected: groundTruth.length,
    reported: 0,
    falsePositives: 0,
  };
  if (!artifact) return zero;

  // Coverage — distinct reviewed files (present in artifact) over all files.
  const reviewedBases = new Set<string>();
  for (const row of artifact) {
    const file = readField(row, ["file", "path", "id"]);
    if (file) reviewedBases.add(basename(file));
  }
  const allBases = new Set(allFilePaths.map(basename));
  let reviewedCount = 0;
  for (const b of allBases) if (reviewedBases.has(b)) reviewedCount++;

  // Flatten reported findings into (fileBase, typeString).
  const reportedFindings: { fileBase: string; type: string }[] = [];
  for (const row of artifact) {
    const file = readField(row, ["file", "path", "id"]);
    if (!file) continue;
    const vulns = row.vulnerabilities ?? row.findings ?? row.issues;
    if (!Array.isArray(vulns)) continue;
    for (const v of vulns) {
      const type =
        typeof v === "string"
          ? v
          : readField(v as Record<string, unknown>, ["type", "vulnType", "kind", "name"]);
      if (type) reportedFindings.push({ fileBase: basename(file), type });
    }
  }

  // Recall — ground-truth vulns matched by at least one reported finding.
  let found = 0;
  for (const gt of groundTruth) {
    const gtBase = basename(gt.file);
    const matched = reportedFindings.some(
      (f) => f.fileBase === gtBase && typeMatches(f.type, gt.vulnType),
    );
    if (matched) found++;
  }

  // Precision — reported findings that correspond to a real ground-truth vuln.
  let truePositives = 0;
  for (const f of reportedFindings) {
    const isReal = groundTruth.some(
      (gt) => basename(gt.file) === f.fileBase && typeMatches(f.type, gt.vulnType),
    );
    if (isReal) truePositives++;
  }

  const reported = reportedFindings.length;
  return {
    artifactValid: artifact.length > 0 ? 1 : 0,
    coverage: allBases.size > 0 ? reviewedCount / allBases.size : 1,
    recall: groundTruth.length > 0 ? found / groundTruth.length : 1,
    precision: reported > 0 ? truePositives / reported : 0,
    found,
    expected: groundTruth.length,
    reported,
    falsePositives: reported - truePositives,
  };
}

// ---------------------------------------------------------------------------
// Pattern 4 — generate-and-filter
// ---------------------------------------------------------------------------

export interface GenerateFilterScore {
  artifactValid: number;
  coverage: number;
  testCount: number;
}

/**
 * Score a generate-and-filter artifact for module coverage and test count.
 *
 * Quality and deduplication are judged by the LLM rubric; this provides the
 * deterministic structural signals (how many modules were covered, how many
 * tests survived filtering).
 */
export function scoreGenerateFilter(
  trajectory: AgentTrajectory,
  totalModules: number,
): GenerateFilterScore {
  const artifact = loadArtifact(trajectory);
  if (!artifact) {
    return { artifactValid: 0, coverage: 0, testCount: 0 };
  }

  const modules = new Set<string>();
  let testCount = 0;
  for (const row of artifact) {
    const mod = readField(row, ["module", "file", "path", "id"]);
    if (mod) modules.add(basename(mod));
    const tests = row.tests ?? row.testCases ?? row.cases;
    if (Array.isArray(tests)) testCount += tests.length;
  }

  return {
    artifactValid: artifact.length > 0 ? 1 : 0,
    coverage: totalModules > 0 ? Math.min(modules.size, totalModules) / totalModules : 1,
    testCount,
  };
}
