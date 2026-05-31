import type { AgentMiddleware } from "langchain";

/**
 * Middleware names that provide essential agent capabilities and cannot
 * be excluded via `excludedMiddleware`.
 *
 * - `FilesystemMiddleware` backs all built-in file tools and enforces
 *   filesystem permissions.
 * - `SubAgentMiddleware` backs the `task` tool for subagent delegation.
 */
export const REQUIRED_MIDDLEWARE_NAMES = new Set([
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
   *
   * @default undefined
   */
  enabled?: boolean;

  /**
   * Override the default GP subagent description shown to the model.
   *
   * @default undefined (uses `DEFAULT_GENERAL_PURPOSE_DESCRIPTION`)
   */
  description?: string;

  /**
   * Override the default GP subagent system prompt.
   *
   * When both this and `HarnessProfile.baseSystemPrompt` are set, this
   * more-specific value wins for the GP subagent.
   *
   * @default undefined (uses `DEFAULT_SUBAGENT_PROMPT`)
   */
  systemPrompt?: string;
}

/**
 * User-facing options for creating a {@link HarnessProfile}.
 *
 * Accepts plain arrays and records; the factory function converts them
 * to their frozen counterparts. All fields are optional — an empty
 * object produces a no-op profile.
 */
export interface HarnessProfileOptions {
  /**
   * Replaces the default `BASE_AGENT_PROMPT` when set.
   *
   * Use this when a model requires a fundamentally different base
   * prompt rather than an additive suffix. Most profiles should prefer
   * `systemPromptSuffix` instead.
   *
   * @default undefined (keeps the default base prompt)
   */
  baseSystemPrompt?: string;

  /**
   * Text appended to the assembled base prompt with a blank-line
   * separator (`\n\n`).
   *
   * This is the primary mechanism for model-specific prompt tuning.
   * Applied uniformly to the main agent, declarative subagents, and
   * the auto-added general-purpose subagent.
   *
   * @default undefined (no suffix appended)
   */
  systemPromptSuffix?: string;

  /**
   * Per-tool description replacements keyed by tool name.
   *
   * Allows profiles to rewrite tool descriptions for models that
   * respond better to different phrasing. Keys that don't match any
   * tool in the final tool set are silently ignored.
   *
   * @default {} (no overrides)
   */
  toolDescriptionOverrides?: Record<string, string>;

  /**
   * Tool names to remove from the agent's visible tool set.
   *
   * Applied via a filtering middleware after all tool-injecting
   * middleware have run, so it catches both user-provided and
   * middleware-provided tools.
   *
   * @default [] (no tools excluded)
   */
  excludedTools?: string[];

  /**
   * Middleware names to remove from the assembled middleware stack.
   *
   * Matched against each middleware's `.name` property. Cannot include
   * required scaffolding names (`FilesystemMiddleware`,
   * `SubAgentMiddleware`) — attempting to do so throws at construction
   * time.
   *
   * @default [] (no middleware excluded)
   */
  excludedMiddleware?: string[];

  /**
   * Additional middleware appended to the stack after user middleware.
   *
   * Can be a static array or a zero-arg factory that returns fresh
   * instances per agent construction (important when middleware carries
   * mutable state).
   *
   * @default [] (no extra middleware)
   */
  extraMiddleware?: AgentMiddleware[] | (() => AgentMiddleware[]);

  /**
   * Configuration for the auto-added general-purpose subagent.
   *
   * @default undefined (GP subagent uses all defaults)
   */
  generalPurposeSubagent?: GeneralPurposeSubagentConfig;
}

/**
 * Frozen runtime harness profile that shapes agent behavior at
 * assembly time.
 *
 * Created by {@link createHarnessProfile} from user-provided
 * {@link HarnessProfileOptions}. Collection types are narrowed
 * (arrays → `Set`, records frozen) and all fields are required.
 * The object is frozen via `Object.freeze()` to prevent mutation
 * after construction.
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
  baseSystemPrompt: string | undefined;

  /**
   * Text appended to the assembled base prompt with a blank-line
   * separator (`\n\n`).
   *
   * This is the primary mechanism for model-specific prompt tuning.
   * Applied uniformly to the main agent, declarative subagents, and
   * the auto-added general-purpose subagent.
   */
  systemPromptSuffix: string | undefined;

  /**
   * Per-tool description replacements keyed by tool name.
   *
   * Allows profiles to rewrite tool descriptions for models that
   * respond better to different phrasing. Keys that don't match any
   * tool in the final tool set are silently ignored.
   */
  toolDescriptionOverrides: Record<string, string>;

  /**
   * Tool names to remove from the agent's visible tool set.
   *
   * Applied via a filtering middleware after all tool-injecting
   * middleware have run, so it catches both user-provided and
   * middleware-provided tools.
   */
  excludedTools: Set<string>;

  /**
   * Middleware names to remove from the assembled middleware stack.
   *
   * Matched against each middleware's `.name` property. Cannot include
   * required scaffolding names (`FilesystemMiddleware`,
   * `SubAgentMiddleware`) — attempting to do so throws at construction
   * time.
   */
  excludedMiddleware: Set<string>;

  /**
   * Additional middleware appended to the stack after user middleware.
   *
   * Can be a static array or a zero-arg factory that returns fresh
   * instances per agent construction (important when middleware carries
   * mutable state).
   */
  extraMiddleware: AgentMiddleware[] | (() => AgentMiddleware[]);

  /**
   * Configuration for the auto-added general-purpose subagent.
   */
  generalPurposeSubagent: GeneralPurposeSubagentConfig | undefined;
}

/**
 * Type guard: is this a fully-constructed HarnessProfile (frozen with
 * Set fields) or raw options?
 *
 * Options use arrays for `excludedTools`; profiles use `Set`. We
 * distinguish by checking whether `excludedTools` has a `.has` method
 * (present on Set, absent on Array).
 */
export function isHarnessProfile(
  value: HarnessProfile | HarnessProfileOptions,
): value is HarnessProfile {
  return (
    value.excludedTools != null &&
    typeof (value.excludedTools as Set<string>).has === "function" &&
    !Array.isArray(value.excludedTools)
  );
}

/**
 * Resolve middleware to a concrete array, invoking the factory if
 * needed.
 *
 * @internal
 */
export function resolveMiddleware(
  middleware: AgentMiddleware[] | (() => AgentMiddleware[]),
): AgentMiddleware[] {
  if (typeof middleware === "function") {
    return middleware();
  }
  return middleware;
}
