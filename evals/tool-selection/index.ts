import * as ls from "langsmith/vitest";
import { beforeEach, expect, vi } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import type { EvalRunner } from "@deepagents/evals";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
function spiedTool(
  fn: (...args: any[]) => any,
  config: { name: string; description: string; schema: any },
) {
  const spy = vi.fn(fn);
  return { tool: tool(spy, config), spy };
}

const { tool: slackSendDm, spy: slackSendDmSpy } = spiedTool(
  ({ user_id, message }) => `Sent DM to ${user_id}: ${message}`,
  {
    name: "slack_send_dm",
    description: "Send a direct message to a user on Slack.",
    schema: z.object({ user_id: z.string(), message: z.string() }),
  },
);

const { tool: slackPostChannel, spy: slackPostChannelSpy } = spiedTool(
  ({ channel, message }) => `Posted to #${channel}: ${message}`,
  {
    name: "slack_post_channel",
    description: "Post a message to a Slack channel.",
    schema: z.object({ channel: z.string(), message: z.string() }),
  },
);

const { tool: githubCreateIssue, spy: githubCreateIssueSpy } = spiedTool(
  ({ repo, title, body }) => `Created issue '${title}' in ${repo} - ${body}`,
  {
    name: "github_create_issue",
    description: "Create a new GitHub issue.",
    schema: z.object({ repo: z.string(), title: z.string(), body: z.string() }),
  },
);

const { tool: githubCreatePr, spy: githubCreatePrSpy } = spiedTool(
  ({ repo, title, head, base }) =>
    `Created PR '${title}' in ${repo} (${head} -> ${base})`,
  {
    name: "github_create_pr",
    description: "Create a pull request on GitHub.",
    schema: z.object({
      repo: z.string(),
      title: z.string(),
      head: z.string(),
      base: z.string(),
    }),
  },
);

const { tool: linearCreateIssue, spy: linearCreateIssueSpy } = spiedTool(
  ({ team, title, description }) =>
    `Created Linear issue '${title}' in ${team} - ${description}`,
  {
    name: "linear_create_issue",
    description: "Create a new issue in Linear.",
    schema: z.object({
      team: z.string(),
      title: z.string(),
      description: z.string(),
    }),
  },
);

const { tool: gmailSendEmail, spy: gmailSendEmailSpy } = spiedTool(
  ({ to, subject, body }) => `Sent email to ${to}: ${subject} - ${body}`,
  {
    name: "gmail_send_email",
    description: "Send an email via Gmail.",
    schema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
  },
);

const { tool: webSearch, spy: webSearchSpy } = spiedTool(
  ({ query }) => `Search results for: ${query}`,
  {
    name: "web_search",
    description: "Search the web for information.",
    schema: z.object({ query: z.string() }),
  },
);

const { tool: calendarCreateEvent, spy: calendarCreateEventSpy } = spiedTool(
  ({ title, date, attendees }) =>
    `Created event '${title}' on ${date} with ${Array.isArray(attendees) ? attendees.join(", ") : ""}`,
  {
    name: "calendar_create_event",
    description: "Create a calendar event.",
    schema: z.object({
      title: z.string(),
      date: z.string(),
      attendees: z.array(z.string()),
    }),
  },
);

const ALL_TOOLS = [
  slackSendDm,
  slackPostChannel,
  githubCreateIssue,
  githubCreatePr,
  linearCreateIssue,
  gmailSendEmail,
  webSearch,
  calendarCreateEvent,
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

export function toolSelectionSuite(runner: EvalRunner): void {
  ls.test(
    "direct request slack dm",
    {
      inputs: {
        query: "Send a Slack DM to user U12345 saying 'Hello from evals'",
      },
    },
    async ({ inputs }) => {
      const result = await runner
        .extend({ tools: [...ALL_TOOLS] })
        .run({ query: inputs.query });

      expect(slackSendDmSpy).toHaveBeenCalled();
      expect(slackSendDmSpy.mock.calls[0][0].user_id).toContain("U12345");
      expect(result).toHaveFinalTextContaining("U12345", true);
    },
  );

  ls.test(
    "direct request github pr",
    {
      inputs: {
        query:
          "Create a pull request in repo langchain-ai/deepagents with title 'fix: typo' from branch fix-typo to main",
      },
    },
    async ({ inputs }) => {
      const result = await runner
        .extend({ tools: [...ALL_TOOLS] })
        .run({ query: inputs.query });

      expect(githubCreatePrSpy).toHaveBeenCalled();
      expect(githubCreatePrSpy.mock.calls[0][0].repo).toContain(
        "langchain-ai/deepagents",
      );
      expect(result).toHaveFinalTextContaining("fix-typo", true);
    },
  );

  ls.test(
    "direct request multiple tools",
    {
      inputs: {
        query:
          "Create an issue titled 'Bug: crash on login' in the Linear team 'engineering' and also create a GitHub issue in repo org/app with the same title and body 'Tracking in Linear'",
      },
    },
    async ({ inputs }) => {
      const result = await runner
        .extend({ tools: [...ALL_TOOLS] })
        .run({ query: inputs.query });

      expect(linearCreateIssueSpy).toHaveBeenCalled();
      expect(githubCreateIssueSpy).toHaveBeenCalled();
      expect(result).toHaveFinalTextContaining("crash on login", true);
    },
  );

  ls.test(
    "indirect schedule meeting",
    {
      inputs: {
        query:
          "Schedule a team standup for tomorrow at 10am with alice@co.com and bob@co.com",
      },
    },
    async ({ inputs }) => {
      const result = await runner
        .extend({ tools: [...ALL_TOOLS] })
        .run({ query: inputs.query });

      expect(calendarCreateEventSpy).toHaveBeenCalled();
      expect(result).toHaveFinalTextContaining("standup", true);
    },
  );

  ls.test(
    "indirect notify team",
    {
      inputs: {
        query: "Notify the #deployments channel that v2.0 has been released",
      },
    },
    async ({ inputs }) => {
      const result = await runner
        .extend({ tools: [...ALL_TOOLS] })
        .run({ query: inputs.query });

      expect(slackPostChannelSpy).toHaveBeenCalled();
      expect(result).toHaveFinalTextContaining("v2.0", true);
    },
  );

  ls.test(
    "indirect email report",
    {
      inputs: {
        query:
          "Email the weekly status report to manager@company.com with subject 'Week 10 Status'",
      },
    },
    async ({ inputs }) => {
      const result = await runner
        .extend({ tools: [...ALL_TOOLS] })
        .run({ query: inputs.query });

      expect(gmailSendEmailSpy).toHaveBeenCalled();
      expect(result).toHaveFinalTextContaining("Week 10", true);
    },
  );

  ls.test(
    "chain search then email",
    {
      inputs: {
        query:
          "Search for 'LangGraph 0.3 release notes' and email a summary to team@co.com with subject 'LangGraph Update'",
      },
    },
    async ({ inputs }) => {
      const result = await runner
        .extend({ tools: [...ALL_TOOLS] })
        .run({ query: inputs.query });

      expect(webSearchSpy).toHaveBeenCalled();
      expect(gmailSendEmailSpy).toHaveBeenCalled();
      expect(result).toHaveFinalTextContaining("team@co.com", true);
    },
  );

  ls.test(
    "chain create issue then notify",
    {
      inputs: {
        query:
          "Create a GitHub issue in org/backend titled 'Fix memory leak' with body 'OOM in prod', then post a message to #incidents saying the issue was created",
      },
    },
    async ({ inputs }) => {
      const result = await runner
        .extend({ tools: [...ALL_TOOLS] })
        .run({ query: inputs.query });

      expect(githubCreateIssueSpy).toHaveBeenCalled();
      expect(slackPostChannelSpy).toHaveBeenCalled();
      expect(result).toHaveFinalTextContaining("memory leak", true);
    },
  );
}
