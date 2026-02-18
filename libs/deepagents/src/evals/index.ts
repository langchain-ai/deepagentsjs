/**
 * @module evals
 *
 * Eval harness for deepagents. Provides a shared agent instance, a
 * {@link runAgent} helper that invokes it and returns a structured
 * {@link AgentTrajectory}, and a set of custom vitest matchers for
 * asserting trajectory properties.
 *
 * Results are automatically logged to LangSmith as experiment feedback
 * via the `langsmith/vitest` integration so every eval run is tracked
 * as an experiment.
 *
 * ## Quick start
 *
 * ```ts
 * import * as ls from "langsmith/vitest";
 * import { expect } from "vitest";
 * import { agent, runAgent, getFinalText } from "./index.js";
 *
 * ls.describe("my evals", () => {
 *   ls.test("reads a file", { inputs: { query: "Read /foo.md" } }, async ({ inputs }) => {
 *     const result = await runAgent(agent, {
 *       query: inputs.query,
 *       initialFiles: { "/foo.md": "hello world" },
 *     });
 *
 *     expect(result).toHaveAgentSteps(2);
 *     expect(result).toHaveToolCallRequests(1);
 *     expect(result).toHaveFinalTextContaining("hello", true);
 *   });
 * });
 * ```
 *
 * ## Custom matchers
 *
 * Importing this module registers four custom vitest matchers on
 * `expect(trajectory)`:
 *
 * | Matcher | Description |
 * |---------|-------------|
 * | `toHaveAgentSteps(n)` | Exact number of AIMessage steps. |
 * | `toHaveToolCallRequests(n)` | Total tool calls across all steps. |
 * | `toHaveToolCallInStep(step, match)` | A specific tool call exists in a 1-indexed step. |
 * | `toHaveFinalTextContaining(text, ci?)` | The last step's text includes a substring. |
 *
 * Each matcher logs corresponding feedback to LangSmith automatically.
 *
 * ## Customising the agent
 *
 * For evals that need a non-default configuration (custom system prompt,
 * subagents, extra tools, etc.) import {@link createDeepAgent} and build
 * a one-off agent inside the test:
 *
 * ```ts
 * import { createDeepAgent, runAgent } from "./index.js";
 *
 * const customAgent = createDeepAgent({ systemPrompt: "You are a pirate." });
 * const result = await runAgent(customAgent, { query: "Say hello" });
 * ```
 */

import { v4 as uuidv4 } from "uuid";
import { expect } from "vitest";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import * as ls from "langsmith/vitest";
import type { ReactAgent } from "langchain";
import { createDeepAgent } from "../index.js";
import { createFileData, fileDataToString } from "../backends/utils.js";
import type { FileData } from "../backends/protocol.js";

export { createDeepAgent } from "../index.js";

/**
 * Shared deepagent instance used by all eval tests that don't need a
 * custom configuration. Change the model here to re-run every eval
 * against a different provider or model version.
 */
export const agent = createDeepAgent({
  model: "anthropic:claude-sonnet-4-5-20250929",
});

/**
 * A single model → tool-result turn in the agent trajectory.
 *
 * @property index   - 1-based position in the trajectory.
 * @property action  - The AIMessage the model produced (may contain tool calls).
 * @property observations - ToolMessages returned by the tool executor for
 *   each tool call in `action`.
 */
export interface AgentStep {
  index: number;
  action: AIMessage;
  observations: ToolMessage[];
}

/**
 * The full trajectory of an agent invocation, including intermediate
 * steps and the final state of all files.
 *
 * @property steps - Ordered list of {@link AgentStep}s.
 * @property files - Snapshot of every file in agent state after the run,
 *   keyed by absolute path with contents as plain strings.
 */
export interface AgentTrajectory {
  steps: AgentStep[];
  files: Record<string, string>;
}

/**
 * Normalise the heterogeneous `files` value from agent state into a
 * simple `Record<string, string>`.
 *
 * Handles three representations:
 * 1. Plain strings (returned by some backends).
 * 2. {@link FileData} objects with a `content` array of lines.
 * 3. `null`/`undefined` (no files) → empty object.
 *
 * @throws {TypeError} If `rawFiles` is not an object or contains an
 *   unrecognised file representation.
 */
function coerceResultFilesToStrings(rawFiles: unknown): Record<string, string> {
  if (rawFiles == null) return {};
  if (typeof rawFiles !== "object" || Array.isArray(rawFiles)) {
    throw new TypeError(`Expected files to be object, got ${typeof rawFiles}`);
  }

  const files: Record<string, string> = {};
  for (const [path, fileData] of Object.entries(
    rawFiles as Record<string, unknown>,
  )) {
    if (typeof fileData === "string") {
      files[path] = fileData;
      continue;
    }
    if (
      typeof fileData === "object" &&
      fileData != null &&
      "content" in fileData
    ) {
      files[path] = fileDataToString(fileData as FileData);
      continue;
    }
    throw new TypeError(
      `Unexpected file representation for ${path}: ${typeof fileData}`,
    );
  }
  return files;
}

/**
 * Render a human-readable summary of a trajectory for use in assertion
 * failure messages. Each step is printed with its tool calls or text
 * preview, e.g.:
 *
 * ```
 * step 1:
 *   - read_file {"file_path":"/foo.md"}
 * step 2:
 *   text: The 3rd word on the 2nd line is "three".
 * ```
 */
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
 * Extract the text content of the last step in a trajectory.
 *
 * Returns an empty string when the trajectory has no steps or the final
 * message has non-string content (e.g. a content-block array).
 *
 * @example
 * ```ts
 * const result = await runAgent(agent, { query: "What is 2+2?" });
 * expect(getFinalText(result).trim()).toBe("4");
 * ```
 */
export function getFinalText(trajectory: AgentTrajectory): string {
  if (trajectory.steps.length === 0) return "";
  const last = trajectory.steps[trajectory.steps.length - 1];
  return typeof last.action.content === "string" ? last.action.content : "";
}

/**
 * Count the total number of tool call requests across every step in the
 * trajectory. A single step may contain multiple parallel tool calls;
 * each one counts individually.
 */
function getToolCallCount(trajectory: AgentTrajectory): number {
  return trajectory.steps.reduce(
    (sum, step) => sum + (step.action.tool_calls?.length ?? 0),
    0,
  );
}

/**
 * Parse a raw `agent.invoke()` result into a structured
 * {@link AgentTrajectory}. Walks the `messages` array (skipping the
 * initial HumanMessage) and groups consecutive AIMessage → ToolMessage
 * sequences into {@link AgentStep}s.
 *
 * @throws {TypeError} If `result.messages` is not an array.
 */
function trajectoryFromResult(
  result: Record<string, unknown>,
): AgentTrajectory {
  const steps: AgentStep[] = [];
  let currentStep: AgentStep | null = null;

  const messages = result.messages;
  if (!Array.isArray(messages)) {
    throw new TypeError(
      `Expected result.messages to be array, got ${typeof messages}`,
    );
  }

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
    files: coerceResultFilesToStrings(result.files),
  };
}

/**
 * Custom matcher interface for {@link AgentTrajectory} assertions.
 * Automatically registered via `expect.extend()` when this module is
 * imported.
 */
interface CustomMatchers {
  /**
   * Assert that the trajectory contains exactly `expected` agent steps
   * (AIMessage turns). Logs `agent_steps`, `expected_num_agent_steps`,
   * and `match_num_agent_steps` feedback to LangSmith.
   *
   * @example
   * ```ts
   * expect(result).toHaveAgentSteps(2);
   * ```
   */
  toHaveAgentSteps(expected: number): void;

  /**
   * Assert the total number of tool call requests across all steps.
   * A single step with two parallel tool calls counts as 2. Logs
   * `tool_call_requests`, `expected_num_tool_call_requests`, and
   * `match_num_tool_call_requests` feedback to LangSmith.
   *
   * @example
   * ```ts
   * expect(result).toHaveToolCallRequests(1);
   * ```
   */
  toHaveToolCallRequests(expected: number): void;

  /**
   * Assert that a specific 1-indexed step contains a tool call matching
   * the given name and (optionally) argument constraints.
   *
   * - `argsContains` — every key/value must appear in the tool call's args.
   * - `argsEquals`   — the tool call's args must deep-equal this object.
   *
   * At most one of `argsContains` / `argsEquals` should be provided.
   *
   * @example
   * ```ts
   * expect(result).toHaveToolCallInStep(1, {
   *   name: "read_file",
   *   argsContains: { file_path: "/foo.md" },
   * });
   * ```
   */
  toHaveToolCallInStep(
    step: number,
    match: {
      name: string;
      argsContains?: Record<string, unknown>;
      argsEquals?: Record<string, unknown>;
    },
  ): void;

  /**
   * Assert that the final step's text content includes `text` as a
   * substring. Pass `caseInsensitive = true` for a case-folded
   * comparison.
   *
   * @example
   * ```ts
   * expect(result).toHaveFinalTextContaining("three", true);
   * ```
   */
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

/**
 * Invoke a deepagent with a user query and optional pre-seeded files,
 * returning a structured {@link AgentTrajectory} for assertions.
 *
 * Each call creates a fresh thread (random UUID) so tests are fully
 * isolated. Inputs and outputs are logged to LangSmith via
 * `ls.logOutputs()` so they appear in the experiment UI.
 *
 * @param agent  - A compiled deepagent (from {@link createDeepAgent} or
 *   the shared {@link agent} export).
 * @param params.query - The user message to send.
 * @param params.initialFiles - Optional map of `path → content` strings
 *   to pre-populate in the agent's state backend before invocation.
 *   Each value is converted to a {@link FileData} via
 *   {@link createFileData}.
 * @returns The parsed trajectory including all agent steps and the
 *   final file state.
 *
 * @example
 * ```ts
 * const result = await runAgent(agent, {
 *   query: "Read /data.txt and reverse the lines into /out.txt.",
 *   initialFiles: { "/data.txt": "alpha\nbeta\ngamma\n" },
 * });
 * expect(result).toHaveAgentSteps(3);
 * expect(result.files["/out.txt"].trimEnd().split("\n"))
 *   .toEqual(["gamma", "beta", "alpha"]);
 * ```
 *
 * @throws {TypeError} If the agent returns a non-object result or the
 *   `messages` field is missing / not an array.
 */
export async function runAgent(
  agent: ReactAgent<any>,
  params: {
    query: string;
    initialFiles?: Record<string, string>;
  },
): Promise<AgentTrajectory> {
  const inputs: Record<string, unknown> = {
    messages: [{ role: "user", content: params.query }],
  };

  if (params.initialFiles != null) {
    const files: Record<string, FileData> = {};
    for (const [filePath, content] of Object.entries(params.initialFiles)) {
      files[filePath] = createFileData(content);
    }
    inputs.files = files;
  }

  const threadId = uuidv4();
  const config = { configurable: { thread_id: threadId } };

  ls.logOutputs(inputs);
  const result = await agent.invoke(inputs, config);
  ls.logOutputs(result);

  if (typeof result !== "object" || result == null) {
    throw new TypeError(
      `Expected invoke result to be object, got ${typeof result}`,
    );
  }

  return trajectoryFromResult(result as Record<string, unknown>);
}
