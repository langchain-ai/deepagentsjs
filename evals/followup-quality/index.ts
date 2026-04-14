import type { EvalRunner } from "@deepagents/evals";
import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner, getFinalText } from "@deepagents/evals";



type FollowupCase = {
  name: string;
  query: string;
  mustContainOneOf: string[];
  mustNotContain?: string[];
};

const CASES: FollowupCase[] = [
  {
    name: "vague data analysis",
    query: "Analyze my data",
    mustContainOneOf: [
      "which data",
      "what data",
      "data source",
      "file",
      "dataset",
    ],
  },
  {
    name: "vague send report",
    query: "Send a report to my team every week",
    mustContainOneOf: [
      "report",
      "include",
      "format",
      "deliver",
      "email",
      "slack",
    ],
    mustNotContain: ["what time every week", "which day every week"],
  },
  {
    name: "vague monitor system",
    query: "Monitor our production system and alert me if something goes wrong",
    mustContainOneOf: [
      "metric",
      "threshold",
      "signal",
      "alert",
      "pagerduty",
      "slack",
      "email",
    ],
  },
  {
    name: "vague summarize emails",
    query: "I want you to summarize my email every day",
    mustContainOneOf: [
      "format",
      "brief",
      "detail",
      "how should",
      "delivery",
      "email",
      "slack",
    ],
  },
  {
    name: "vague customer support",
    query: "Help me respond to customer questions faster",
    mustContainOneOf: [
      "where",
      "channel",
      "email",
      "slack",
      "support",
      "domain",
      "product",
    ],
  },
  {
    name: "detailed calendar brief",
    query:
      "Every morning at 5am, look at my Google Calendar and send me a brief of what's upcoming for the day",
    mustContainOneOf: [
      "how should i send",
      "where should i send",
      "email",
      "slack",
      "sms",
    ],
    mustNotContain: ["what time should", "when should i run", "which schedule"],
  },
];

export function defineFollowupQualitySuite(runner: EvalRunner): void {
      for (const testCase of CASES) {
        ls.test(
          testCase.name,
          { inputs: { query: testCase.query } },
          async () => {
            const result = await runner.run({ query: testCase.query });
            const answer = getFinalText(result).toLowerCase();
  
            // Follow-up quality baseline: ask at least one clarification question.
            expect(answer.includes("?")).toBe(true);
  
            const hasRelevantSignal = testCase.mustContainOneOf.some((needle) =>
              answer.includes(needle.toLowerCase()),
            );
            expect(hasRelevantSignal).toBe(true);
  
            for (const forbidden of testCase.mustNotContain ?? []) {
              expect(answer).not.toContain(forbidden.toLowerCase());
            }
  
            ls.logFeedback({ key: "agent_steps", score: result.steps.length });
            ls.logFeedback({
              key: "followup_has_question_mark",
              score: answer.includes("?") ? 1 : 0,
            });
            ls.logFeedback({
              key: "followup_relevant_signal",
              score: hasRelevantSignal ? 1 : 0,
            });
            ls.logFeedback({ key: "case_name", value: testCase.name });
          },
        );
      }
}
