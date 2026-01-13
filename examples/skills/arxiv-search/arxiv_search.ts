#!/usr/bin/env npx tsx
/**
 * arXiv Search.
 *
 * Searches the arXiv preprint repository for research papers.
 * Uses the arXiv API directly without requiring any dependencies.
 */

interface ArxivEntry {
  title: string;
  summary: string;
}

/**
 * Query arXiv for papers based on the provided search query.
 *
 * @param query - The search query string
 * @param maxPapers - Maximum number of papers to retrieve (default: 10)
 * @returns Formatted search results or an error message
 */
async function queryArxiv(query: string, maxPapers = 10): Promise<string> {
  try {
    // Build arXiv API URL
    const encodedQuery = encodeURIComponent(query);
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodedQuery}&start=0&max_results=${maxPapers}&sortBy=relevance&sortOrder=descending`;

    const response = await fetch(url);
    if (!response.ok) {
      return `Error: Failed to fetch from arXiv API (status ${response.status})`;
    }

    const xml = await response.text();

    // Parse XML response (simple regex-based parsing for portability)
    const entries: ArxivEntry[] = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    const titleRegex = /<title>([\s\S]*?)<\/title>/;
    const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;

    let match;
    while ((match = entryRegex.exec(xml)) !== null) {
      const entryXml = match[1];

      const titleMatch = titleRegex.exec(entryXml);
      const summaryMatch = summaryRegex.exec(entryXml);

      if (titleMatch && summaryMatch) {
        entries.push({
          title: titleMatch[1].trim().replace(/\s+/g, " "),
          summary: summaryMatch[1].trim().replace(/\s+/g, " "),
        });
      }
    }

    if (entries.length === 0) {
      return "No papers found on arXiv.";
    }

    return entries
      .map((paper) => `Title: ${paper.title}\nSummary: ${paper.summary}`)
      .join("\n\n");
  } catch (error) {
    return `Error querying arXiv: ${error}`;
  }
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npx tsx arxiv_search.ts <query> [--max-papers N]

Arguments:
  query           Search query string (required)
  --max-papers N  Maximum number of papers to retrieve (default: 10)

Examples:
  npx tsx arxiv_search.ts "deep learning drug discovery"
  npx tsx arxiv_search.ts "protein folding" --max-papers 5
`);
    process.exit(0);
  }

  const query = args[0];
  let maxPapers = 10;

  const maxPapersIndex = args.indexOf("--max-papers");
  if (maxPapersIndex !== -1 && args[maxPapersIndex + 1]) {
    maxPapers = parseInt(args[maxPapersIndex + 1], 10);
    if (isNaN(maxPapers) || maxPapers < 1) {
      console.error("Error: --max-papers must be a positive integer");
      process.exit(1);
    }
  }

  queryArxiv(query, maxPapers).then((result) => {
    console.log(result);
  });
}

main();
