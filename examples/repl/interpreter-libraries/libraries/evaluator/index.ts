import { create, run, rows } from "swarm";

declare const tools: {
  writeFile?: (args: { file_path: string; content: string }) => Promise<string>;
};

interface Criterion {
  key?: string;
  name: string;
  weight: number;
}

interface NormalizedCriterion {
  key: string;
  name: string;
  weight: number;
}

interface EvaluateOptions {
  topN?: number;
  outputDir?: string;
}

/**
 * Derive a camelCase key from a criterion name when key is not provided.
 */
function deriveKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_, ch) => ch.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, "");
}

/**
 * Turn a candidate name into a safe filename slug.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Compute a weighted score from per-criterion values.
 *
 * @param scores - Object mapping criterion keys to numeric values.
 * @param criteria - Criteria with weight fields.
 * @returns The weighted total.
 */
export function weightedScore(
  scores: Record<string, unknown>,
  criteria: { key: string; weight: number }[],
): number {
  return criteria.reduce(
    (sum, c) => sum + Number(scores[c.key] ?? 0) * c.weight,
    0,
  );
}

const DEFAULT_OUTPUT_DIR = "/evaluation";

/**
 * Run a multi-pass evaluation pipeline and write results to files.
 *
 * Pass 1 (invoke mode): quick 1-10 ratings on every criterion.
 * Weighted scoring + filter to top N.
 * Pass 2 (agent mode, "researcher"): general research on top candidates.
 * Pass 3 (agent mode, "benchmarker"): performance benchmarks on top candidates.
 * Pass 4 (agent mode, "community_analyst"): ecosystem/community analysis on top candidates.
 *
 * Results are split across multiple files under `options.outputDir`
 * (default: /evaluation):
 * - `rankings.json` — scores and ranking for all candidates
 * - `{slug}.json` — detailed research/benchmarks/ecosystem for each top-N candidate
 *
 * @param candidates - Names of things to evaluate.
 * @param criteria - Scoring criteria with weights (should sum to 1).
 * @param options - Pipeline options.
 */
export async function evaluate(
  candidates: string[],
  criteria: Criterion[],
  options?: EvaluateOptions,
): Promise<void> {
  const topN = options?.topN ?? 3;
  const outputDir = options?.outputDir ?? DEFAULT_OUTPUT_DIR;

  const normalized: NormalizedCriterion[] = criteria.map((c) => ({
    key: c.key ?? deriveKey(c.name),
    name: c.name,
    weight: c.weight,
  }));

  // Build the swarm table
  const table = await create({
    tasks: candidates.map((name, i) => ({ id: `c${i}`, name })),
  });

  // Pass 1 — invoke mode: quick 1-10 ratings per criterion
  const criteriaList = normalized.map((c) => c.name).join(", ");
  await run(table.id, {
    instruction:
      `Rate {name} on each of the following criteria using a 1-10 scale. ` +
      `Be specific and differentiated — avoid giving the same score to all candidates. ` +
      `Criteria: ${criteriaList}`,
    responseSchema: {
      type: "object",
      properties: Object.fromEntries(
        normalized.map((c) => [
          c.key,
          { type: "number", description: `1-10 rating for ${c.name}` },
        ]),
      ),
      required: normalized.map((c) => c.key),
    },
  });

  // Compute weighted scores and rank
  const scoredRows = await rows(table.id);
  const scored = scoredRows.map((r) => ({
    ...r,
    weightedScore: Math.round(weightedScore(r, normalized) * 100) / 100,
  }));
  scored.sort(
    (a, b) => (b.weightedScore as number) - (a.weightedScore as number),
  );

  const ranked = scored.map((r) => r.id as string);
  const topIds = ranked.slice(0, topN);

  // Pass 2 — researcher: general deep-dive on top candidates
  await run(table.id, {
    instruction:
      `Research {name} in depth for the use case described in the task context. ` +
      `Provide an overview covering strengths, weaknesses, and adoption trends. ` +
      `Cite specific data — download counts, GitHub stars, survey results.`,
    subagentType: "researcher",
    filter: { column: "id", in: topIds },
    responseSchema: {
      type: "object",
      properties: {
        research: {
          type: "string",
          description: "General research findings with evidence",
        },
      },
      required: ["research"],
    },
  });

  // Pass 3 — benchmarker: performance data on top candidates
  await run(table.id, {
    instruction:
      `Find performance benchmarks for {name} relevant to CLI tool development. ` +
      `Focus on: startup time, memory usage, binary size, throughput. ` +
      `Compare against alternatives. Cite benchmark sources.`,
    subagentType: "benchmarker",
    filter: { column: "id", in: topIds },
    responseSchema: {
      type: "object",
      properties: {
        benchmarks: {
          type: "string",
          description: "Performance benchmark data with sources",
        },
      },
      required: ["benchmarks"],
    },
  });

  // Pass 4 — community_analyst: ecosystem analysis on top candidates
  await run(table.id, {
    instruction:
      `Analyze the ecosystem and community around {name} for CLI development. ` +
      `Cover: key libraries/frameworks, package manager stats, community size, ` +
      `tooling maturity, and recent momentum. Cite specific numbers.`,
    subagentType: "community_analyst",
    filter: { column: "id", in: topIds },
    responseSchema: {
      type: "object",
      properties: {
        ecosystem: {
          type: "string",
          description: "Ecosystem and community analysis",
        },
        recommendation: {
          type: "string",
          description: "One-paragraph recommendation for this candidate",
        },
      },
      required: ["ecosystem", "recommendation"],
    },
  });

  // Build results and write to split files
  const finalRows = await rows(table.id);

  const rankings = ranked.map((id) => {
    const row = finalRows.find((r) => r.id === id) ?? {};
    const scoreEntry = scored.find((s) => s.id === id);
    const name = (row.name as string) ?? id;
    const perCriterion: Record<string, number> = {};
    for (const c of normalized) {
      perCriterion[c.key] = Number(row[c.key] ?? 0);
    }
    return {
      name,
      slug: slugify(name),
      weightedScore: scoreEntry?.weightedScore ?? 0,
      scores: perCriterion,
      hasDetail: topIds.includes(id),
    };
  });

  // Write compact rankings summary
  await tools.writeFile!({
    file_path: `${outputDir}/rankings.json`,
    content: JSON.stringify({ rankings, topN, criteria: normalized }, null, 2),
  });

  // Write per-candidate detail files for top-N
  for (const id of topIds) {
    const row = finalRows.find((r) => r.id === id) ?? {};
    const name = (row.name as string) ?? id;
    const scoreEntry = scored.find((s) => s.id === id);
    const perCriterion: Record<string, number> = {};
    for (const c of normalized) {
      perCriterion[c.key] = Number(row[c.key] ?? 0);
    }
    const detail = {
      name,
      weightedScore: scoreEntry?.weightedScore ?? 0,
      scores: perCriterion,
      research: row.research as string | undefined,
      benchmarks: row.benchmarks as string | undefined,
      ecosystem: row.ecosystem as string | undefined,
      recommendation: row.recommendation as string | undefined,
    };
    await tools.writeFile!({
      file_path: `${outputDir}/${slugify(name)}.json`,
      content: JSON.stringify(detail, null, 2),
    });
  }

  const files = [
    `${outputDir}/rankings.json`,
    ...topIds.map((id) => {
      const row = finalRows.find((r) => r.id === id) ?? {};
      return `${outputDir}/${slugify((row.name as string) ?? id)}.json`;
    }),
  ];
  console.log(`Evaluation complete. Files written:\n${files.join("\n")}`);
}
