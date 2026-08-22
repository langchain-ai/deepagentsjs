import { z } from "zod";
import { tool } from "langchain";

/**
 * You.com web search tool for Deep Agents
 * 
 * Provides web search capabilities using the You.com Search API.
 * Supports both authenticated (with YDC_API_KEY) and keyless usage.
 */

interface YouComSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface YouComSearchResponse {
  results: {
    web?: YouComSearchResult[];
  };
}

/**
 * You.com web search tool
 */
export const youcomSearch = tool(
  async ({
    query,
    maxResults = 5,
    includeRawContent = false,
  }: {
    query: string;
    maxResults?: number;
    includeRawContent?: boolean;
  }) => {
    try {
      const apiKey = process.env.YDC_API_KEY;
      const baseUrl = "https://api.you.com/v1/agents/search";
      
      const params = new URLSearchParams({
        query,
        count: maxResults.toString(),
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "deepagents-youcom-integration/1.0",
      };

      // Add API key if available
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${baseUrl}?${params}`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(
            "You.com API authentication failed. Please check your YDC_API_KEY environment variable."
          );
        } else if (response.status === 429) {
          throw new Error(
            "You.com API rate limit exceeded. Please try again later or add a YDC_API_KEY for higher limits."
          );
        } else if (response.status === 402) {
          throw new Error(
            "You.com API quota exceeded. Please add a YDC_API_KEY or try again later."
          );
        }
        throw new Error(
          `You.com API error: ${response.status} ${response.statusText}`
        );
      }

      const data: YouComSearchResponse = await response.json();
      const webResults = data.results?.web || [];

      if (webResults.length === 0) {
        return "No search results found for the given query.";
      }

      // Format results for the agent
      const formattedResults = webResults.slice(0, maxResults).map((result, index) => {
        let formattedResult = `${index + 1}. **${result.title}**\n   URL: ${result.url}`;
        
        if (result.snippet) {
          formattedResult += `\n   ${result.snippet}`;
        }
        
        return formattedResult;
      }).join("\n\n");

      const summary = `Found ${webResults.length} search results for "${query}":

${formattedResults}`;

      return summary;
    } catch (error) {
      if (error && typeof error === 'object' && 'message' in error) {
        return `Search error: ${(error as Error).message}`;
      }
      return `Search error: An unexpected error occurred while searching.`;
    }
  },
  {
    name: "youcom_search",
    description: "Search the web using You.com's search API. Provides current web information with high-quality results and source citations.",
    schema: z.object({
      query: z.string().describe("The search query to find information about"),
      maxResults: z
        .number()
        .optional()
        .default(5)
        .describe("Maximum number of search results to return (1-20)"),
      includeRawContent: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to include raw content from pages (currently not implemented)"),
    }),
  }
);