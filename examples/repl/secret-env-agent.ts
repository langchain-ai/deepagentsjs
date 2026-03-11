/**
 * Secret Environment Variables Example
 *
 * Demonstrates how the REPL's env system provides secret isolation.
 * The agent can pass API keys to allowed tools without ever seeing
 * the real values — they appear as opaque placeholders inside the REPL.
 *
 * Configuration:
 * - `env.API_KEY` → secret, only allowed in `http_request` tool
 * - `env.BASE_URL` → plain, restricted to `http_request` tool
 * - `env.APP_NAME` → plain, unrestricted (available everywhere)
 */
import "dotenv/config";
import dedent from "dedent";
import { z } from "zod";
import { tool } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { createDeepAgent } from "deepagents";
import { createQuickJSMiddleware } from "@langchain/quickjs";

const model = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
  temperature: 0,
});

const httpRequest = tool(
  async (input) => {
    const res = await fetch(input.url, {
      headers: input.headers ? JSON.parse(input.headers) : {},
    });
    return res.text();
  },
  {
    name: "http_request",
    description: "Make an HTTP GET request",
    schema: z.object({
      url: z.string().describe("The URL to fetch"),
      headers: z.string().optional().describe("JSON-encoded headers object"),
    }),
  },
);

const agent = createDeepAgent({
  model,
  systemPrompt: dedent`
    You are an API integration agent. Use the REPL to build requests
    and process API responses. Use env variables for credentials —
    never hardcode secrets.
  `,
  tools: [httpRequest],
  middleware: [
    createQuickJSMiddleware({
      ptc: ["http_request"],
      env: {
        API_KEY: {
          value: process.env.API_KEY || "sk-example-key",
          secret: true,
          allowedTools: ["http_request"],
        },
        BASE_URL: {
          value: "https://api.example.com",
          allowedTools: ["http_request"],
        },
        APP_NAME: "my-agent",
      },
    }),
  ],
});

const result = await agent.invoke({
  messages: [
    new HumanMessage(dedent`
      Fetch the list of users from the API at env.BASE_URL/users,
      using env.API_KEY for authentication. Parse the response and
      write a summary to /users.md.
    `),
  ],
});

const last = result.messages[result.messages.length - 1];
// eslint-disable-next-line no-console
console.log(
  typeof last.content === "string" ? last.content.slice(0, 500) : last.content,
);
