import { expect } from "vitest";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import * as ls from "langsmith/vitest";

/**
 * A single agent step consisting of the model's action (an {@link AIMessage})
 * and any tool-call observations that followed.
 */
export interface AgentStep {
  /** 1-based step index within the trajectory. */
  index: number;
  /** The model's response for this step. */
  action: AIMessage;
  /** Tool-call results returned in this step (empty when the step is text-only). */
  observations: ToolMessage[];
}

/**
 * The full trajectory produced by an agent run, including all steps and
 * the final file-system state.
 */
export interface AgentTrajectory {
  /** Ordered list of agent steps (action + observations). */
  steps: AgentStep[];
  /** Map of file paths to their string contents at the end of the run. */
  files: Record<string, string>;
}

/**
 * Invocation parameters passed to {@link EvalRunner.run}.
 *
 * These describe *what* to send to the agent, not *how* the agent is
 * configured. Use {@link EvalRunner.extend} to customise agent
 * configuration (system prompt, tools, subagents, etc.).
 */
export interface RunAgentParams {
  /** The user message to send to the agent. */
  query: string;
  /** Optional seed files to pre-populate the agent's file system. */
  initialFiles?: Record<string, string>;
}

/**
 * A named eval runner that can execute an agent and return a trajectory.
 *
 * Register implementations via {@link registerRunner} and look them up
 * with {@link getRunner}.
 */
export interface EvalRunner {
  /** Unique identifier for this runner (e.g. `"sonnet-4-5"`). */
  name: string;
  /** Run the agent with the given params and return the resulting trajectory. */
  run(params: RunAgentParams): Promise<AgentTrajectory>;
  /**
   * Return a new runner with runner-specific configuration overrides
   * (e.g. `systemPrompt`, `tools`, `subagents`) baked in.
   *
   * The returned runner shares the same {@link name} but creates a fresh
   * agent incorporating the overrides on each {@link run} call.
   */
  extend(overrides: Record<string, unknown>): EvalRunner;
}

const runners: Record<string, EvalRunner> = {};

/**
 * Register an {@link EvalRunner} so it can be resolved by name.
 *
 * @param runner - The runner instance to register (keyed by `runner.name`).
 */
export function registerRunner(runner: EvalRunner): void {
  runners[runner.name] = runner;
}

/**
 * Get a registered runner by name.
 *
 * @param name - The runner name (must match a previously registered runner).
 * @throws If no runner is registered under that name.
 */
export function getRunner(name: string): EvalRunner {
  const runner = runners[name];
  if (!runner) {
    const available = Object.keys(runners).join(", ");
    throw new Error(`Unknown eval runner "${name}". Available: ${available}`);
  }
  return runner;
}

let _resolved: EvalRunner | null = null;

/**
 * Return the runner specified by the `EVAL_RUNNER` environment variable.
 *
 * The result is cached — subsequent calls return the same instance.
 *
 * @throws If `EVAL_RUNNER` is not set or names an unregistered runner.
 */
export function getDefaultRunner(): EvalRunner {
  const name = process.env.EVAL_RUNNER;
  if (!name) {
    const available = Object.keys(runners).join(", ");
    throw new Error(
      `No eval runner specified (use EVAL_RUNNER env var). Available: ${available}`,
    );
  }
  if (_resolved == null) {
    _resolved = getRunner(name);
  }
  return _resolved;
}

/**
 * Parse raw LangGraph invoke output into an {@link AgentTrajectory}.
 *
 * Walks the message array (skipping the first HumanMessage) and groups
 * each {@link AIMessage} with subsequent {@link ToolMessage}s into steps.
 *
 * @param messages - The `result.messages` array from a LangGraph invoke.
 * @param files    - Optional `result.files` map (FileData or plain strings).
 */
export function parseTrajectory(
  messages: unknown[],
  files?: Record<string, unknown>,
): AgentTrajectory {
  const steps: AgentStep[] = [];
  let currentStep: AgentStep | null = null;

  for (const msg of messages.slice(1)) {
    if (AIMessage.isInstance(msg)) {
      if (currentStep != null) {
        steps.push(currentStep);
      }
      currentStep = {
        index: steps.length + 1,
        action: msg,
        observations: [],
      };
    } else if (ToolMessage.isInstance(msg)) {
      if (currentStep != null) {
        currentStep.observations.push(msg);
      }
    }
  }

  if (currentStep != null) {
    steps.push(currentStep);
  }

  return {
    steps,
    files: coerceFiles(files),
  };
}

/**
 * Normalise the files map returned by LangGraph into plain `Record<string, string>`.
 * Accepts either plain string values or `{ content: string[] }` FileData objects.
 */
function coerceFiles(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`Expected files to be object, got ${typeof raw}`);
  }

  const files: Record<string, string> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      files[path] = value;
      continue;
    }
    if (typeof value === "object" && value != null && "content" in value) {
      const content = (value as { content: string[] }).content;
      files[path] = Array.isArray(content)
        ? content.join("\n")
        : String(content);
      continue;
    }
    throw new TypeError(
      `Unexpected file representation for ${path}: ${typeof value}`,
    );
  }
  return files;
}

/** Format a trajectory for human-readable assertion failure messages. */
function prettyTrajectory(trajectory: AgentTrajectory): string {
  const lines: string[] = [];
  for (const step of trajectory.steps) {
    lines.push(`step ${step.index}:`);
    const toolCalls = step.action.tool_calls ?? [];
    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        lines.push(`  - ${tc.name} ${JSON.stringify(tc.args)}`);
      }
    } else {
      const text =
        typeof step.action.content === "string" ? step.action.content : "";
      const textPreview = text.trim().replace(/\n/g, "\\n");
      lines.push(`  text: ${textPreview}`);
    }
  }
  return lines.join("\n");
}

/**
 * Extract the text content of the last agent step.
 *
 * Returns an empty string if the trajectory has no steps or the last
 * step's content is not a plain string.
 */
export function getFinalText(trajectory: AgentTrajectory): string {
  if (trajectory.steps.length === 0) return "";
  const last = trajectory.steps[trajectory.steps.length - 1];
  return typeof last.action.content === "string" ? last.action.content : "";
}

/** Count total tool-call requests across all steps in a trajectory. */
function getToolCallCount(trajectory: AgentTrajectory): number {
  return trajectory.steps.reduce(
    (sum, step) => sum + (step.action.tool_calls?.length ?? 0),
    0,
  );
}

// ---------------------------------------------------------------------------
// Custom vitest matchers (hard — fail the test on mismatch)
// ---------------------------------------------------------------------------

/**
 * Custom vitest matchers for asserting on {@link AgentTrajectory} values.
 *
 * Each matcher also logs LangSmith feedback so results appear in the
 * experiment dashboard.
 *
 * For efficiency expectations (step counts, tool calls) that should be
 * tracked but never fail the test, call `ls.logFeedback()` directly
 * in your test instead of using these matchers.
 */
interface CustomMatchers {
  /** Assert the trajectory has exactly `expected` agent steps. */
  toHaveAgentSteps(expected: number): void;
  /** Assert the trajectory contains exactly `expected` total tool-call requests. */
  toHaveToolCallRequests(expected: number): void;
  /**
   * Assert that a specific step (1-indexed) contains a tool call matching
   * the given name and optional argument constraints.
   */
  toHaveToolCallInStep(
    step: number,
    match: {
      name: string;
      argsContains?: Record<string, unknown>;
      argsEquals?: Record<string, unknown>;
    },
  ): void;
  /** Assert the final step's text content contains the given substring. */
  toHaveFinalTextContaining(text: string, caseInsensitive?: boolean): void;
}

declare module "vitest" {
  interface Assertion extends CustomMatchers {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}

expect.extend({
  toHaveAgentSteps(received: AgentTrajectory, expected: number) {
    const actual = received.steps.length;

    ls.logFeedback({ key: "agent_steps", score: actual });
    ls.logFeedback({ key: "expected_num_agent_steps", score: expected });
    ls.logFeedback({
      key: "match_num_agent_steps",
      score: actual === expected ? 1 : 0,
    });

    return {
      pass: actual === expected,
      message: () =>
        `expected ${expected} agent steps but got ${actual}\n\ntrajectory:\n${prettyTrajectory(received)}`,
      actual,
      expected,
    };
  },

  toHaveToolCallRequests(received: AgentTrajectory, expected: number) {
    const actual = getToolCallCount(received);

    ls.logFeedback({ key: "tool_call_requests", score: actual });
    ls.logFeedback({
      key: "expected_num_tool_call_requests",
      score: expected,
    });
    ls.logFeedback({
      key: "match_num_tool_call_requests",
      score: actual === expected ? 1 : 0,
    });

    return {
      pass: actual === expected,
      message: () =>
        `expected ${expected} tool call requests but got ${actual}\n\ntrajectory:\n${prettyTrajectory(received)}`,
      actual,
      expected,
    };
  },

  toHaveToolCallInStep(
    received: AgentTrajectory,
    stepNum: number,
    match: {
      name: string;
      argsContains?: Record<string, unknown>;
      argsEquals?: Record<string, unknown>;
    },
  ) {
    if (stepNum <= 0) {
      return {
        pass: false,
        message: () => "step must be positive (1-indexed)",
      };
    }

    if (stepNum > received.steps.length) {
      return {
        pass: false,
        message: () =>
          `expected at least ${stepNum} steps but trajectory has ${received.steps.length}\n\ntrajectory:\n${prettyTrajectory(received)}`,
      };
    }

    const step = received.steps[stepNum - 1];
    const toolCalls = step.action.tool_calls ?? [];

    let matches = toolCalls.filter((tc) => tc.name === match.name);

    if (match.argsContains != null) {
      matches = matches.filter(
        (tc) =>
          typeof tc.args === "object" &&
          tc.args != null &&
          Object.entries(match.argsContains!).every(
            ([k, v]) => (tc.args as Record<string, unknown>)[k] === v,
          ),
      );
    }

    if (match.argsEquals != null) {
      matches = matches.filter(
        (tc) => JSON.stringify(tc.args) === JSON.stringify(match.argsEquals),
      );
    }

    return {
      pass: matches.length > 0,
      message: () =>
        `expected step ${stepNum} to have tool call ${JSON.stringify(match)}\n\nactual tool calls: ${JSON.stringify(toolCalls)}\n\ntrajectory:\n${prettyTrajectory(received)}`,
    };
  },

  toHaveFinalTextContaining(
    received: AgentTrajectory,
    text: string,
    caseInsensitive = false,
  ) {
    const finalText = getFinalText(received);

    if (received.steps.length === 0) {
      return {
        pass: false,
        message: () =>
          `expected final text to contain ${JSON.stringify(text)} but trajectory has no steps`,
      };
    }

    const haystack = caseInsensitive ? finalText.toLowerCase() : finalText;
    const needle = caseInsensitive ? text.toLowerCase() : text;

    return {
      pass: haystack.includes(needle),
      message: () =>
        `expected final text to contain ${JSON.stringify(text)} (caseInsensitive=${caseInsensitive})\n\nactual final text: ${JSON.stringify(finalText)}`,
      actual: finalText,
      expected: text,
    };
  },
});
