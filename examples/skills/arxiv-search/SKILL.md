---
name: arxiv-search
description: Search arXiv preprint repository for papers in physics, mathematics, computer science, quantitative biology, and related fields
---

# arXiv Search Skill

This skill provides access to arXiv, a free distribution service and open-access archive for scholarly articles in physics, mathematics, computer science, quantitative biology, quantitative finance, statistics, electrical engineering, systems science, and economics.

## When to Use This Skill

Use this skill when you need to:
- Find preprints and recent research papers before journal publication
- Search for papers in computational biology, bioinformatics, or systems biology
- Access mathematical or statistical methods papers relevant to biology
- Find machine learning papers applied to biological problems
- Get the latest research that may not yet be in PubMed

## How to Use

The skill provides a TypeScript script that searches arXiv and returns formatted results.

### Basic Usage

**Note:** Always use the absolute path from your skills directory (shown in the system prompt above).

```bash
npx tsx [YOUR_SKILLS_DIR]/arxiv-search/arxiv_search.ts "your search query" [--max-papers N]
```

Replace `[YOUR_SKILLS_DIR]` with the absolute skills directory path from your system prompt (e.g., `~/.deepagents/agent/skills` or the full absolute path).

**Arguments:**
- `query` (required): The search query string (e.g., "neural networks protein structure", "single cell RNA-seq")
- `--max-papers` (optional): Maximum number of papers to retrieve (default: 10)

### Examples

Search for machine learning papers:
```bash
npx tsx ~/.deepagents/agent/skills/arxiv-search/arxiv_search.ts "deep learning drug discovery" --max-papers 5
```

Search for computational biology papers:
```bash
npx tsx ~/.deepagents/agent/skills/arxiv-search/arxiv_search.ts "protein folding prediction"
```

Search for bioinformatics methods:
```bash
npx tsx ~/.deepagents/agent/skills/arxiv-search/arxiv_search.ts "genome assembly algorithms"
```

## Output Format

The script returns formatted results with:
- **Title**: Paper title
- **Summary**: Abstract/summary text

Each paper is separated by blank lines for readability.

## Features

- **Relevance sorting**: Results ordered by relevance to query
- **Fast retrieval**: Direct API access with no authentication required
- **Simple interface**: Clean, easy-to-parse output
- **No API key required**: Free access to arXiv database

## Notes

- arXiv is particularly strong for:
  - Computer science (cs.LG, cs.AI, cs.CV)
  - Quantitative biology (q-bio)
  - Statistics (stat.ML)
  - Physics and mathematics
- Papers are preprints and may not be peer-reviewed
- Results include both recent uploads and older papers
- Best for computational/theoretical work in biology
