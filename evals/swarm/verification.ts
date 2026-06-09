/**
 * Pattern verification for swarm vs baseline evals.
 *
 * Inspects tool call sequences in the trajectory to verify the agent
 * followed the expected workflow shape. Checks process, not output quality.
 */
import type { AgentTrajectory } from "@deepagents/evals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationResult {
  score: number;
  details: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all tool call args text from the trajectory, keyed by tool name.
 */
function collectToolCallText(
  trajectory: AgentTrajectory,
): { toolName: string; argsText: string }[] {
  const entries: { toolName: string; argsText: string }[] = [];

  for (const step of trajectory.steps) {
    for (const tc of step.action.tool_calls ?? []) {
      entries.push({
        toolName: tc.name,
        argsText: JSON.stringify(tc.args),
      });
    }
  }

  return entries;
}

/**
 * Check if a specific subagent was dispatched in the trajectory.
 *
 * For baseline: looks for `task` tool calls whose args mention the subagent name.
 * For swarm: looks for `eval` tool calls whose code references the subagent name.
 *
 * @param trajectory - The trajectory to inspect.
 * @param subagentName - The subagent name to look for.
 * @param condition - The condition to check against.
 * @returns Whether the subagent was dispatched.
 */
export function hasSubagentDispatch(
  trajectory: AgentTrajectory,
  subagentName: string,
  condition: "swarm" | "swarm_task" | "baseline",
): boolean {
  const entries = collectToolCallText(trajectory);
  const needle = subagentName.toLowerCase();

  if (condition === "baseline") {
    return entries.some(
      (e) =>
        e.toolName === "task" && e.argsText.toLowerCase().includes(needle),
    );
  }

  // Swarm and swarm_task conditions: subagent names appear in eval tool code
  return entries.some(
    (e) => e.toolName === "eval" && e.argsText.toLowerCase().includes(needle),
  );
}

/**
 * Check whether the trajectory contains evidence of a specific swarm
 * API call (e.g. "create", "run", "rows").
 *
 * Only meaningful for the swarm condition. Scans eval tool call args
 * for the given API method name.
 *
 * @param trajectory - The trajectory to inspect.
 * @param methodName - The swarm API method (e.g. "create", "run").
 * @returns Whether the API call was found.
 */
export function hasSwarmApiCall(
  trajectory: AgentTrajectory,
  methodName: string,
): boolean {
  const entries = collectToolCallText(trajectory);

  return entries.some(
    (e) => e.toolName === "eval" && e.argsText.includes(methodName),
  );
}

// ---------------------------------------------------------------------------
// Per-pattern verification
// ---------------------------------------------------------------------------

interface PatternSpec {
  required: string[];
  optional: string[];
}

const PATTERN_SPECS: Record<string, PatternSpec> = {
  "classify-and-act": {
    required: ["classifier"],
    optional: ["handler"],
  },
  "fanout-and-synthesize": {
    required: ["reviewer"],
    optional: [],
  },
  "adversarial-verification": {
    required: ["bug-finder", "verifier"],
    optional: [],
  },
  "generate-and-filter": {
    required: ["test-generator", "evaluator"],
    optional: [],
  },
  "loop-until-done": {
    required: ["bug-finder"],
    optional: [],
  },
};

/**
 * Verify that the agent's trajectory follows the expected workflow shape
 * for a given pattern and condition.
 *
 * Inspects tool call sequences and arguments to check whether the agent
 * dispatched the right subagents in the right order. Returns a score
 * (0 or 1) and a details array listing what was found or missing.
 *
 * @param trajectory - The agent's full trajectory.
 * @param pattern - Pattern name (e.g. "classify-and-act").
 * @param condition - Which condition was run.
 * @returns A score (0 or 1) and details array.
 */
export function verifyPattern(
  trajectory: AgentTrajectory,
  pattern: string,
  condition: "swarm" | "swarm_task" | "baseline",
): VerificationResult {
  const spec = PATTERN_SPECS[pattern];
  if (!spec) {
    return {
      score: 0,
      details: [
        `Unknown pattern "${pattern}". Available: ${Object.keys(PATTERN_SPECS).join(", ")}`,
      ],
    };
  }

  const details: string[] = [];
  let allRequiredFound = true;

  // Check required subagents
  for (const name of spec.required) {
    if (hasSubagentDispatch(trajectory, name, condition)) {
      details.push(`required subagent "${name}": found`);
    } else {
      details.push(`required subagent "${name}": MISSING`);
      allRequiredFound = false;
    }
  }

  // Check optional subagents
  for (const name of spec.optional) {
    if (hasSubagentDispatch(trajectory, name, condition)) {
      details.push(`optional subagent "${name}": found`);
    } else {
      details.push(`optional subagent "${name}": not found`);
    }
  }

  // Condition-specific API usage checks
  if (condition === "swarm") {
    const usesCreate = hasSwarmApiCall(trajectory, "create");
    const usesRun = hasSwarmApiCall(trajectory, "run");
    details.push(`swarm API create: ${usesCreate ? "found" : "not found"}`);
    details.push(`swarm API run: ${usesRun ? "found" : "not found"}`);
  } else if (condition === "swarm_task") {
    const usesSwarmTask = hasSwarmApiCall(trajectory, "swarmTask");
    details.push(`swarmTask dispatch: ${usesSwarmTask ? "found" : "not found"}`);
  }

  return {
    score: allRequiredFound ? 1 : 0,
    details,
  };
}
