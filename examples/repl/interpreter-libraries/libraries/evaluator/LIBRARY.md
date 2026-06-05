---
name: evaluator
description: Multi-pass evaluation pipeline built on swarm
ptcTools: [write_file]
---

# Evaluator

Run a structured multi-pass comparison of candidates against weighted
criteria. Built on top of the `swarm` library — you don't need to know the
swarm API to use this.

## Quick Start

```javascript
import { evaluate } from "evaluator";

await evaluate(
  ["Rust", "Go", "Python", "TypeScript"],
  [
    { name: "Performance", weight: 0.3 },
    { name: "Developer experience", weight: 0.4 },
    { name: "Ecosystem", weight: 0.3 },
  ],
  { topN: 3 },
);

// Results are written to /evaluation/:
//   rankings.json        — scores and ranking for all candidates
//   rust.json, go.json …  — detailed research for each top-N candidate
```

## How It Works

1. **Pass 1 (invoke mode)** — Every candidate gets a quick 1-10 rating
   on each criterion. This is a single model call per candidate, no tools.

2. **Weighted scoring** — Scores are combined using the `weight` field on
   each criterion. Candidates are sorted by weighted total.

3. **Pass 2 (researcher subagent)** — Top-N candidates get a general
   research deep-dive via web search. Returns research findings.

4. **Pass 3 (benchmarker subagent)** — Top-N candidates get performance
   benchmark analysis via web search. Returns benchmark data.

5. **Pass 4 (community_analyst subagent)** — Top-N candidates get
   ecosystem and community analysis via web search. Returns ecosystem
   data and a recommendation.

6. **Output** — Results are split across files under `/evaluation/`
   (or `options.outputDir`):
   - `rankings.json` — compact summary with scores for all candidates
   - `{slug}.json` — per-candidate detail file for each top-N candidate

## API

### `evaluate(candidates, criteria, options?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `candidates` | `string[]` | Names of things to evaluate |
| `criteria` | `Criterion[]` | `{ name, weight, key? }` — `key` auto-derived from name if omitted; weights should sum to 1 |
| `options.topN` | `number` | How many to deep-dive (default: 3) |
| `options.outputDir` | `string` | Directory for result files (default: `/evaluation`) |

Returns `void`. Results are written as:

**`rankings.json`** — `{ rankings, topN, criteria }` where each ranking entry has:
- `name` — candidate name
- `slug` — filename-safe version of the name
- `weightedScore` — combined weighted score
- `scores` — per-criterion scores as `{ [key]: number }`
- `hasDetail` — whether a detail file exists for this candidate

**`{slug}.json`** (top-N only) — per-candidate detail:
- `name`, `weightedScore`, `scores` — same as ranking entry
- `research` — general research findings
- `benchmarks` — performance benchmark data
- `ecosystem` — ecosystem and community analysis
- `recommendation` — one-paragraph recommendation

### `weightedScore(scores, criteria)`

Compute the weighted total for a single row. Useful for ad-hoc scoring
outside the pipeline.

```javascript
import { weightedScore } from "evaluator";

const total = weightedScore(
  { perf: 8, dx: 7, ecosystem: 9 },
  [
    { key: "perf", weight: 0.3 },
    { key: "dx", weight: 0.4 },
    { key: "ecosystem", weight: 0.3 },
  ],
);
// 7.9
```
