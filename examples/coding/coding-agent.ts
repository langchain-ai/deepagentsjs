/* eslint-disable no-console */
import { createDeepAgent, type SubAgent } from "../../src/index.js";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import "dotenv/config";
import { spawn } from "child_process";
import { promisify } from "util";
import { code_reviewer_agent, test_generator_agent } from "./subagents.js";
import { get_coding_instructions } from "./coding_instructions.js";

// LangSmith tracing setup
if (process.env.LANGCHAIN_TRACING_V2 !== "false") {
  process.env.LANGCHAIN_TRACING_V2 = "true";
  if (!process.env.LANGCHAIN_PROJECT) {
    process.env.LANGCHAIN_PROJECT = "coding-agent";
  }
}

// Execute bash command tool
const executeBash = tool(
  async ({ command, timeout = 30000 }: { command: string; timeout?: number }) => {
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      const timeoutId = setTimeout(() => {
        child.kill();
        resolve({
          returncode: -1,
          stdout,
          stderr: stderr + "\nProcess timed out",
        });
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        resolve({
          returncode: code || 0,
          stdout,
          stderr,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timeoutId);
        resolve({
          returncode: -1,
          stdout,
          stderr: err.message,
        });
      });
    });
  },
  {
    name: "execute_bash",
    description: "Execute a bash command and return the result",
    schema: z.object({
      command: z.string().describe("The bash command to execute"),
      timeout: z.number().optional().default(30000).describe("Timeout in milliseconds"),
    }),
  },
);

// HTTP request tool
const httpRequest = tool(
  async ({
    url,
    method = "GET",
    headers = {},
    data,
  }: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    data?: any;
  }) => {
    try {
      const fetchOptions: RequestInit = {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      };

      if (data && method !== "GET") {
        fetchOptions.body = JSON.stringify(data);
      }

      const response = await fetch(url, fetchOptions);
      const responseData = await response.text();
      
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data: responseData,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  {
    name: "http_request",
    description: "Make an HTTP request to a URL",
    schema: z.object({
      url: z.string().describe("The URL to make the request to"),
      method: z.string().optional().default("GET").describe("HTTP method"),
      headers: z.record(z.string()).optional().default({}).describe("HTTP headers"),
      data: z.any().optional().describe("Request body data"),
    }),
  },
);

// Web search tool (mock implementation)
const webSearch = tool(
  async ({ query, maxResults = 5 }: { query: string; maxResults?: number }) => {
    // This is a placeholder - in a real implementation you'd use a search API
    return {
      results: [
        {
          title: `Search result for: ${query}`,
          url: `https://example.com/search?q=${encodeURIComponent(query)}`,
          snippet: `This is a mock search result for the query: ${query}`,
        },
      ],
      query,
      maxResults,
    };
  },
  {
    name: "web_search",
    description: "Search the web for information",
    schema: z.object({
      query: z.string().describe("The search query"),
      maxResults: z.number().optional().default(5).describe("Maximum number of results"),
    }),
  },
);


// Get coding instructions
const codingInstructions = get_coding_instructions();

// Create the coding agent
const agent = createDeepAgent({
  tools: [executeBash, httpRequest, webSearch],
  instructions: codingInstructions,
  subagents: [code_reviewer_agent, test_generator_agent],
  isLocalFileSystem: true,
}).withConfig({ recursionLimit: 1000 });

// Example usage function
async function main() {
  console.log("Starting coding agent...");
  
  if (process.env.LANGCHAIN_TRACING_V2 === "true") {
    console.log(`LangSmith tracing enabled for project: ${process.env.LANGCHAIN_PROJECT}`);
    console.log(`LangSmith endpoint: ${process.env.LANGCHAIN_ENDPOINT || "https://api.smith.langchain.com"}`);
  }
  
  const result = await agent.invoke({
    messages: [
      { 
        role: "user", 
        content: "Create a simple Node.js Express server with a health check endpoint and write tests for it" 
      }
    ],
  });
  console.log(result);
}

export { agent, executeBash, httpRequest, webSearch };

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
