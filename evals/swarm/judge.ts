/**
 * LLM-as-judge scoring for swarm vs baseline evals.
 *
 * Uses claude-sonnet-4-6 to evaluate agent output quality against
 * per-pattern rubrics. Returns a numeric score (0-1) and reasoning.
 */
import { z } from "zod";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentTrajectory } from "@deepagents/evals";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const JudgeResultSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("Quality score from 0 (worst) to 1 (best)"),
  reasoning: z
    .string()
    .describe("Brief explanation of why this score was assigned"),
});

export type JudgeResult = z.infer<typeof JudgeResultSchema>;

// ---------------------------------------------------------------------------
// Rubrics
// ---------------------------------------------------------------------------

const RUBRICS: Record<string, string> = {
  "classify-and-act": `Evaluate the agent's ticket classification and handling output.

Criteria (equal weight):
1. Classification accuracy — Did the agent assign correct categories (billing, technical, account, or other) based on ticket content?
2. Urgent ticket handling — Were high-urgency tickets identified and given detailed analysis with concrete next steps?
3. Completeness — Were all tickets addressed, not just a subset?
4. Structure — Is the output organized and easy to parse (e.g., grouped by category or presented in a table)?
5. Actionability — Do urgent ticket analyses include specific recommended actions?

Score 1.0 if all criteria are fully met. Score 0.0 if the output is missing, irrelevant, or addresses fewer than half the tickets.`,

  "fanout-and-synthesize": `Evaluate the agent's security vulnerability review output.

Criteria (equal weight):
1. Coverage — Did the agent review all (or nearly all) source files, not just a sample?
2. Vulnerability detection — Were real vulnerabilities identified with correct type labels (SQL injection, path traversal, XSS, command injection, insecure deserialization)?
3. False positive rate — Did the agent avoid flagging clean code as vulnerable?
4. Specificity — Are findings cited with file names and line numbers?
5. Synthesis quality — Is there a coherent summary that ties individual findings together and highlights the most critical issues?

Score 1.0 if all criteria are fully met. Score 0.0 if the output is missing or irrelevant.`,

  "adversarial-verification": `Evaluate the agent's bug-finding and verification output.

Criteria (equal weight):
1. Two-phase process — Is there evidence of both a finding phase and a separate verification phase?
2. Confirmation discipline — Were reported issues actually confirmed as real before being included in the final report?
3. False positive filtering — Were unconfirmed or questionable findings excluded from the final report?
4. Precision of findings — Are confirmed bugs described with file, line number, and vulnerability type?
5. Completeness — Were most real vulnerabilities found before verification filtering?

Score 1.0 if all criteria are fully met. Score 0.0 if the output is missing or irrelevant.`,

  "generate-and-filter": `Evaluate the agent's test generation and filtering output.

Criteria (equal weight):
1. Diversity — Do tests cover multiple angles: happy path, error handling, and security?
2. Specificity — Do tests have concrete inputs and expected behaviors, not just descriptions?
3. Deduplication — Were redundant tests removed or consolidated?
4. Quality filtering — Is there evidence of evaluating tests before presenting the final set?
5. Coverage value — Do the remaining tests provide genuine coverage of the auth module's functionality (register, login, middleware, changePassword, deleteUser)?

Score 1.0 if all criteria are fully met. Score 0.0 if the output is missing or irrelevant.`,

  "loop-until-done": `Evaluate the agent's exhaustive vulnerability-finding output.

Criteria (equal weight):
1. Exhaustiveness — Did the agent appear to keep searching until findings were exhausted, rather than stopping after a single pass?
2. Termination discipline — Is there evidence it stopped only when a round surfaced no new vulnerabilities (not arbitrarily early)?
3. Deduplication — Are findings distinct, without the same vulnerability reported multiple times?
4. Specificity — Are findings cited with file names and vulnerability types?
5. Breadth — Were vulnerabilities found across many files, not just a small subset?

Score 1.0 if all criteria are fully met. Score 0.0 if the output is missing or irrelevant.`,
};

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Cap a string to `max` chars, marking truncation.
 */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/**
 * Extract the agent's deliverable for judge evaluation.
 *
 * Reads, in priority order: the results artifact (`/results/output.json`),
 * any other written files, the final eval observations (where
 * `console.log` output lands), and the final AI message. Each section is
 * capped so a large run can't blow up the judge prompt.
 */
function extractOutputForJudge(trajectory: AgentTrajectory): string {
  const parts: string[] = [];

  // 1. Files written (artifact first), capped per file.
  const fileEntries = Object.entries(trajectory.files);
  const artifactFirst = fileEntries.sort(([a], [b]) =>
    a.endsWith("results/output.json") ? -1 : b.endsWith("results/output.json") ? 1 : 0,
  );
  if (artifactFirst.length > 0) {
    parts.push("## Files Written by Agent");
    for (const [path, content] of artifactFirst) {
      parts.push(`### ${path}\n${cap(content, 8000)}`);
    }
  }

  // 2. The final tool observation(s) — where console.log output lands.
  for (let i = trajectory.steps.length - 1; i >= 0; i--) {
    const obs = trajectory.steps[i].observations;
    if (obs.length > 0) {
      const text = obs
        .map((o) => (typeof o.content === "string" ? o.content : ""))
        .filter(Boolean)
        .join("\n");
      if (text.trim()) {
        parts.push("## Final Tool Output\n" + cap(text, 6000));
      }
      break;
    }
  }

  // 3. The agent's closing message.
  if (trajectory.steps.length > 0) {
    const last = trajectory.steps[trajectory.steps.length - 1];
    if (typeof last.action.content === "string" && last.action.content.trim()) {
      parts.push("## Agent's Final Response\n" + cap(last.action.content, 4000));
    }
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score agent output using an LLM judge against a pattern-specific rubric.
 *
 * Sends the agent's final text output and written files to claude-sonnet-4-6,
 * which returns a structured score (0-1) and reasoning. The rubric is looked
 * up by pattern name from the built-in registry.
 *
 * @param trajectory - The agent's full trajectory.
 * @param pattern - Pattern name (e.g. "classify-and-act").
 * @param query - The original query given to the agent.
 * @returns Score and reasoning from the judge.
 */
export async function judgeOutput(
  trajectory: AgentTrajectory,
  pattern: string,
  query: string,
): Promise<JudgeResult> {
  const rubric = RUBRICS[pattern];
  if (!rubric) {
    throw new Error(
      `Unknown pattern "${pattern}". Available: ${Object.keys(RUBRICS).join(", ")}`,
    );
  }

  const model = new ChatAnthropic({
    model: "claude-sonnet-4-6",
    temperature: 0,
  });

  const structured = model.withStructuredOutput(JudgeResultSchema);

  const agentOutput = extractOutputForJudge(trajectory);

  const messages = [
    new SystemMessage(
      `You are an expert evaluator scoring the quality of an AI agent's output.\n\n` +
        `## Rubric\n\n${rubric}\n\n` +
        `Score on a continuous scale from 0.0 to 1.0. Be calibrated: reserve ` +
        `scores above 0.9 for genuinely excellent output and scores below 0.2 ` +
        `for clearly failing output. Most adequate-but-imperfect output should ` +
        `fall between 0.4 and 0.8.\n\n` +
        `Provide brief, specific reasoning referencing concrete evidence from ` +
        `the output.`,
    ),
    new HumanMessage(
      `## Task Given to the Agent\n\n${query}\n\n` +
        `## Agent Output\n\n${agentOutput || "(no output produced)"}`,
    ),
  ];

  return structured.invoke(messages);
}

// ---------------------------------------------------------------------------
// Pattern adherence judge (reads the trajectory, not just the output)
// ---------------------------------------------------------------------------

/**
 * Per-pattern description of the workflow shape an LLM judge looks for.
 * Phrased in terms of *what the agent did*, not which named tool it used,
 * so invoke-mode and agent-mode dispatch both count.
 */
const PATTERN_WORKFLOWS: Record<string, string> = {
  "classify-and-act":
    "A two-stage workflow: (1) every ticket is classified into a category, " +
    "then (2) the urgent/high-priority tickets specifically are given a " +
    "deeper, separate analysis. Acting on a filtered subset (only the " +
    "urgent ones) in stage 2 is the key signal.",
  "fanout-and-synthesize":
    "A fan-out then synthesize workflow: each source file is reviewed " +
    "(in parallel or sequentially), and the per-file findings are then " +
    "synthesized into a coherent summary. Both the per-file pass and the " +
    "synthesis step should be present.",
  "adversarial-verification":
    "A two-phase workflow: (1) a finding phase that surfaces candidate bugs, " +
    "then (2) a SEPARATE verification phase that independently checks each " +
    "candidate, with unconfirmed findings filtered out before the final " +
    "report. The independence of the verify phase is the key signal.",
  "generate-and-filter":
    "A generate-then-filter workflow: test cases are generated from multiple " +
    "angles (happy path, error handling, security), then evaluated and " +
    "deduplicated so only unique, high-value tests survive. Both generation " +
    "and a distinct filtering/dedup step should be present.",
  "loop-until-done":
    "An iterative discovery loop: the agent searches for vulnerabilities in " +
    "successive rounds, accumulating and deduping findings against what it " +
    "has already found, and continues spawning rounds until a round surfaces " +
    "nothing new — only then stopping. The key signals are the repeated " +
    "rounds and the accumulating de-duplicated finding set, not a single pass.",
};

/**
 * Render a compact transcript of the trajectory for pattern judging.
 *
 * Includes each step's tool calls (the orchestration code/args — small and
 * the primary signal) and a truncated observation (confirmation). Caps
 * total size so a large run can't blow up the prompt.
 */
function buildTrajectoryTranscript(trajectory: AgentTrajectory): string {
  const lines: string[] = [];

  for (const step of trajectory.steps) {
    const calls = step.action.tool_calls ?? [];
    for (const tc of calls) {
      const args = JSON.stringify(tc.args);
      lines.push(`STEP ${step.index} CALL ${tc.name}: ${cap(args, 2000)}`);
    }
    if (calls.length === 0 && typeof step.action.content === "string") {
      const txt = step.action.content.trim();
      if (txt) lines.push(`STEP ${step.index} TEXT: ${cap(txt, 500)}`);
    }
    const obsText = step.observations
      .map((o) => (typeof o.content === "string" ? o.content : ""))
      .filter(Boolean)
      .join(" | ");
    if (obsText.trim()) {
      lines.push(`  OUTPUT: ${cap(obsText, 800)}`);
    }
  }

  return cap(lines.join("\n"), 40000);
}

/**
 * Judge whether the agent's trajectory followed the expected workflow for a
 * pattern, by reading the actual orchestration (eval code / task dispatches)
 * and tool outputs.
 *
 * Robust to invoke-mode vs agent-mode dispatch (a classifying `run` counts
 * as classification whether or not a "classifier" subagent is named) — which
 * the mechanical string-match verifier cannot see.
 *
 * @param trajectory - The agent's full trajectory.
 * @param pattern - Pattern name (e.g. "classify-and-act").
 * @param condition - "swarm", "swarm_task", or "baseline".
 * @returns Score (0-1) and reasoning.
 */
export async function judgePattern(
  trajectory: AgentTrajectory,
  pattern: string,
  condition: "swarm" | "swarm_task" | "baseline",
): Promise<JudgeResult> {
  const workflow = PATTERN_WORKFLOWS[pattern];
  if (!workflow) {
    throw new Error(
      `Unknown pattern "${pattern}". Available: ${Object.keys(PATTERN_WORKFLOWS).join(", ")}`,
    );
  }

  const model = new ChatAnthropic({
    model: "claude-sonnet-4-6",
    temperature: 0,
  });
  const structured = model.withStructuredOutput(JudgeResultSchema);

  const toolingNotes: Record<string, string> = {
    swarm:
      "This agent orchestrates via a sandboxed code interpreter: tool calls " +
      'named "eval" contain JavaScript using a swarm API (create/run/rows). ' +
      "Classification or analysis done via a `run(...)` call counts even if no " +
      "subagent is named (invoke mode is legitimate).",
    swarm_task:
      "This agent orchestrates via a sandboxed code interpreter: tool calls " +
      'named "eval" contain JavaScript using `tools.swarmTask()` for dispatch. ' +
      "It supports invoke mode (single model call, no tools) and agent mode " +
      "(full agentic loop). Both count as valid dispatch.",
    baseline:
      "This agent orchestrates via direct tool calls (e.g. a `task` tool that " +
      "dispatches subagents, plus file tools). Read the dispatched instructions " +
      "to determine what work each step performed.",
  };
  const toolingNote = toolingNotes[condition];

  const transcript = buildTrajectoryTranscript(trajectory);

  const messages = [
    new SystemMessage(
      "You are evaluating whether an AI agent followed an expected WORKFLOW " +
        "SHAPE — not the quality of its output. Judge process, not results.\n\n" +
        `## Expected workflow\n\n${workflow}\n\n` +
        `## How this agent works\n\n${toolingNote}\n\n` +
        "Score 0.0 to 1.0: 1.0 = the workflow is clearly present with all its " +
        "stages; 0.5 = partially followed (e.g. a stage missing or merged); " +
        "0.0 = the workflow was not followed. Cite concrete steps in your reasoning.",
    ),
    new HumanMessage(
      `## Agent trajectory (tool calls + outputs)\n\n${transcript || "(empty trajectory)"}`,
    ),
  ];

  return structured.invoke(messages);
}
