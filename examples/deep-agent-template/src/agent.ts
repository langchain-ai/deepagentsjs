/**
 * Deep Agent graph definition.
 *
 * This module wires together a `createDeepAgent(...)` graph with:
 *   - A structured workflow system prompt (plan → delegate → critique → finalize).
 *   - Two built-in tools: `utc_now` (current timestamp) and `confidence_check`
 *     (forces explicit confidence scoring for key claims).
 *   - Two predefined sub-agents: `researcher` (evidence gathering) and `critic`
 *     (adversarial review).
 *   - Human-in-the-loop interrupts on `execute` and `write_file` tool calls so
 *     a human can approve or reject potentially destructive actions.
 *
 * The compiled graph is exported as `graph` — this is the entrypoint referenced
 * by `langgraph.json` for local development and LangSmith deployment.
 */

import { createDeepAgent, type SubAgent } from "deepagents";
import { tool, context } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import * as z from "zod";

/**
 * Default LLM used by the orchestrator and (optionally) sub-agents.
 */
export const DEFAULT_MODEL = new ChatAnthropic({
  model: "claude-sonnet-4-6",
});

/**
 * The orchestrator's system prompt.  It prescribes a strict five-step workflow
 * and a quality bar that favours evidence over assumptions.
 */
export const SYSTEM_PROMPT = context`
  You are a rigorous execution-focused deep agent.

  Workflow you must follow:
  1. Write and maintain a todo list for non-trivial requests.
  2. Delegate focused fact-finding to subagents when helpful.
  3. Store intermediate drafts in files when the task is long.
  4. Before finalizing, run a brief internal critique for risks, gaps, and missing constraints.
  5. Return concise, actionable final output.

  Quality bar:
  - Prefer concrete evidence over assumptions.
  - State unresolved uncertainty explicitly.
  - Keep output compact unless the user asks for depth.
`;

/**
 * Returns the current UTC timestamp in ISO-8601 format.
 * Useful for grounding agent responses in real time.
 */
export const utcNow = tool(async () => new Date().toISOString(), {
  name: "utc_now",
  description: "Return the current UTC timestamp in ISO format.",
  schema: z.object({}),
});

/**
 * Forces the agent to assign an explicit numeric confidence score (0–1) to a
 * claim.  The score is clamped to [0, 1] and returned alongside the claim text.
 * This encourages calibrated uncertainty rather than over-confident assertions.
 */
export const confidenceCheck = tool(
  async ({ claim, confidence }) => {
    const bounded = Math.min(Math.max(confidence, 0), 1);
    return `claim='${claim}'; confidence=${bounded.toFixed(2)}`;
  },
  {
    name: "confidence_check",
    description: "Force explicit confidence scoring for key claims.",
    schema: z.object({
      claim: z.string().describe("The claim being assessed."),
      confidence: z.number().describe("Numeric confidence in [0, 1]."),
    }),
  }
);

/**
 * Pre-configured sub-agents that the orchestrator can delegate to via the
 * built-in `task` tool.
 *
 * - **researcher**: Gathers evidence, lists assumptions, and reports
 *   contradictions.  Has access to both `utc_now` and `confidence_check`.
 * - **critic**: Reviews drafts/plans for weak logic, untested assumptions, and
 *   missing constraints.  Only has `confidence_check` (no time tool needed).
 */
export const SUBAGENTS: SubAgent[] = [
  {
    name: "researcher",
    description:
      "Use for evidence collection and source-grounded fact finding.",
    systemPrompt:
      "You are a focused researcher. Gather evidence, list assumptions, and report contradictions clearly.",
    tools: [utcNow, confidenceCheck],
  },
  {
    name: "critic",
    description: "Use for adversarial review of drafts and plans.",
    systemPrompt:
      "You are a critical reviewer. Find weak logic, untested assumptions, and missing constraints.",
    tools: [confidenceCheck],
  },
];

/**
 * The compiled agent graph
 *
 * `interruptOn` enables human-in-the-loop approval for the `execute` (shell
 * commands) and `write_file` tools — the graph will pause and wait for human
 * confirmation before running those tools.
 */
export const agent = createDeepAgent({
  model: DEFAULT_MODEL,
  tools: [utcNow, confidenceCheck],
  systemPrompt: SYSTEM_PROMPT,
  subagents: SUBAGENTS,
  interruptOn: {
    execute: true,
    write_file: true,
  },
});
