import { z } from "zod/v4";
import type { AgentMiddleware } from "langchain";

/**
 * Dangerous keys to reject when parsing external config objects.
 * Prevents prototype-pollution attacks from untrusted JSON/YAML input.
 */
const POISONED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Middleware names that provide essential agent capabilities and cannot
 * be excluded via `excludedMiddleware`.
 *
 * - `FilesystemMiddleware` backs all built-in file tools and enforces
 *   filesystem permissions.
 * - `SubAgentMiddleware` backs the `task` tool for subagent delegation.
 */
export const REQUIRED_MIDDLEWARE_NAMES: ReadonlySet<string> = new Set([
  "FilesystemMiddleware",
  "SubAgentMiddleware",
]);

/**
 * Configuration for the auto-added general-purpose subagent.
 *
 * All fields use three-state semantics: `undefined` inherits the
 * default, an explicit value overrides it. This allows model-level
 * profiles to selectively override provider-level defaults without
 * clobbering fields they don't care about.
 */
export interface GeneralPurposeSubagentConfig {
  /**
   * Whether to auto-add the general-purpose subagent.
   *
   * - `undefined` — inherit the default (enabled).
   * - `true` — force inclusion even if a provider profile disables it.
   * - `false` — disable the GP subagent entirely.
   */
  readonly enabled?: boolean;

  /**
   * Override the default GP subagent description shown to the model.
   */
  readonly description?: string;

  /**
   * Override the default GP subagent system prompt.
   *
   * When both this and `HarnessProfile.baseSystemPrompt` are set, this
   * more-specific value wins for the GP subagent.
   */
  readonly systemPrompt?: string;
}

/**
 * Frozen runtime harness profile that shapes agent behavior at
 * assembly time.
 *
 * Created by {@link createHarnessProfile} from user-provided options.
 * All collection fields are frozen/readonly to prevent mutation after
 * construction.
 *
 * Profiles are **orthogonal to model selection**: they control prompt
 * assembly, tool visibility, middleware composition, and subagent
 * configuration — not which model is used.
 */
export interface HarnessProfile {
  /**
   * Replaces the default `BASE_AGENT_PROMPT` when set.
   *
   * Use this when a model requires a fundamentally different base
   * prompt rather than an additive suffix. Most profiles should prefer
   * `systemPromptSuffix` instead.
   */
  readonly baseSystemPrompt: string | undefined;

  /**
   * Text appended to the assembled base prompt with a blank-line
   * separator (`\n\n`).
   *
   * This is the primary mechanism for model-specific prompt tuning.
   * Applied uniformly to the main agent, declarative subagents, and
   * the auto-added general-purpose subagent.
   */
  readonly systemPromptSuffix: string | undefined;

  /**
   * Per-tool description replacements keyed by tool name.
   *
   * Allows profiles to rewrite tool descriptions for models that
   * respond better to different phrasing. Keys that don't match any
   * tool in the final tool set are silently ignored.
   */
  readonly toolDescriptionOverrides: Readonly<Record<string, string>>;

  /**
   * Tool names to remove from the agent's visible tool set.
   *
   * Applied via a filtering middleware after all tool-injecting
   * middleware have run, so it catches both user-provided and
   * middleware-provided tools.
   */
  readonly excludedTools: ReadonlySet<string>;

  /**
   * Middleware names to remove from the assembled middleware stack.
   *
   * Matched against each middleware's `.name` property. Cannot include
   * required scaffolding names (`FilesystemMiddleware`,
   * `SubAgentMiddleware`) — attempting to do so throws at construction
   * time.
   */
  readonly excludedMiddleware: ReadonlySet<string>;

  /**
   * Additional middleware appended to the stack after user middleware.
   *
   * Can be a static array or a zero-arg factory that returns fresh
   * instances per agent construction (important when middleware carries
   * mutable state).
   */
  readonly extraMiddleware:
    | readonly AgentMiddleware[]
    | (() => readonly AgentMiddleware[]);

  /** Configuration for the auto-added general-purpose subagent. */
  readonly generalPurposeSubagent:
    | Readonly<GeneralPurposeSubagentConfig>
    | undefined;
}

/**
 * User-facing options for creating a {@link HarnessProfile}.
 *
 * Accepts plain arrays and records; the factory function converts them
 * to their frozen/readonly counterparts. All fields are optional — an
 * empty object produces a no-op profile.
 */
export interface HarnessProfileOptions {
  /** @see {@link HarnessProfile.baseSystemPrompt} */
  baseSystemPrompt?: string;

  /** @see {@link HarnessProfile.systemPromptSuffix} */
  systemPromptSuffix?: string;

  /** @see {@link HarnessProfile.toolDescriptionOverrides} */
  toolDescriptionOverrides?: Record<string, string>;

  /** @see {@link HarnessProfile.excludedTools} */
  excludedTools?: string[];

  /** @see {@link HarnessProfile.excludedMiddleware} */
  excludedMiddleware?: string[];

  /** @see {@link HarnessProfile.extraMiddleware} */
  extraMiddleware?: AgentMiddleware[] | (() => AgentMiddleware[]);

  /** @see {@link HarnessProfile.generalPurposeSubagent} */
  generalPurposeSubagent?: GeneralPurposeSubagentConfig;
}

/**
 * Validate the grammar of an `excludedMiddleware` entry.
 *
 * Runs at profile construction time so malformed entries fail
 * immediately. Checks:
 *
 * 1. Non-empty, non-whitespace string.
 * 2. No colons (class-path `module:Class` syntax is reserved).
 * 3. No underscore prefix (private middleware is not part of the
 *    exclusion surface).
 * 4. Not a required scaffolding name.
 *
 * @param name - The middleware name to validate.
 * @throws {Error} When the name violates any rule.
 */
function validateExcludedMiddlewareName(name: string): void {
  if (!name || !name.trim()) {
    throw new Error(
      "excludedMiddleware entries must be non-empty, non-whitespace strings.",
    );
  }

  if (name.includes(":")) {
    throw new Error(
      `excludedMiddleware entries must be plain middleware names; ` +
        `class-path syntax is not supported, got "${name}".`,
    );
  }

  if (name.startsWith("_")) {
    throw new Error(
      `excludedMiddleware entry "${name}" cannot start with "_" ` +
        `(underscore-prefixed names refer to private middleware not ` +
        `part of the public exclusion surface).`,
    );
  }

  if (REQUIRED_MIDDLEWARE_NAMES.has(name)) {
    throw new Error(
      `Cannot exclude required middleware "${name}" — it provides ` +
        `essential agent capabilities that the runtime depends on.`,
    );
  }
}

/**
 * Create a frozen {@link HarnessProfile} from user-provided options.
 *
 * Validates all fields, converts mutable collections to their
 * readonly/frozen counterparts, and returns a deeply frozen object.
 * Empty options produce a no-op profile (all defaults).
 *
 * @param options - Partial profile configuration.
 * @returns A frozen, validated `HarnessProfile`.
 * @throws {Error} When any field violates validation rules (invalid
 *   middleware names, scaffolding exclusion attempts).
 *
 * @example
 * ```typescript
 * const profile = createHarnessProfile({
 *   systemPromptSuffix: "Think step by step.",
 *   excludedTools: ["execute"],
 * });
 * ```
 */
export function createHarnessProfile(
  options: HarnessProfileOptions = {},
): HarnessProfile {

}
