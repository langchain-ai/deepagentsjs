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
 * An empty no-op profile used as the default when no registered
 * profile matches. Avoids creating a new object on every miss.
 */
export const EMPTY_HARNESS_PROFILE: HarnessProfile = createHarnessProfile();

/**
 * Zod schema for the general-purpose subagent config section of an
 * external harness profile config file.
 */
export const generalPurposeSubagentConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    description: z.string().optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

/**
 * Zod schema for parsing a harness profile from an external JSON or
 * YAML config file.
 *
 * Uses `.strict()` to reject unknown keys (catches typos early). Array
 * fields (`excludedTools`, `excludedMiddleware`) accept arrays of
 * strings; the result is passed to {@link createHarnessProfile} which
 * converts them to `ReadonlySet`.
 *
 * Does not include `extraMiddleware` — middleware instances cannot be
 * represented in JSON/YAML.
 *
 * @example
 * ```typescript
 * import { readFileSync } from "fs";
 * import YAML from "yaml";
 *
 * const raw = YAML.parse(readFileSync("profile.yaml", "utf-8"));
 * const config = harnessProfileConfigSchema.parse(raw);
 * const profile = createHarnessProfile(config);
 * ```
 */
export const harnessProfileConfigSchema = z
  .object({
    baseSystemPrompt: z.string().optional(),
    systemPromptSuffix: z.string().optional(),
    toolDescriptionOverrides: z.record(z.string(), z.string()).optional(),
    excludedTools: z.array(z.string()).optional(),
    excludedMiddleware: z.array(z.string()).optional(),
    generalPurposeSubagent: generalPurposeSubagentConfigSchema.optional(),
  })
  .strict();

/**
 * TypeScript type inferred from the Zod config schema.
 *
 * Represents the JSON/YAML-compatible shape of a harness profile. This
 * is the type of data that comes out of `harnessProfileConfigSchema.parse()`.
 */
export type HarnessProfileConfigData = z.infer<
  typeof harnessProfileConfigSchema
>;

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
  enabled?: boolean;

  /**
   * Override the default GP subagent description shown to the model.
   */
  description?: string;

  /**
   * Override the default GP subagent system prompt.
   *
   * When both this and `HarnessProfile.baseSystemPrompt` are set, this
   * more-specific value wins for the GP subagent.
   */
  systemPrompt?: string;
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
  toolDescriptionOverrides: Readonly<Record<string, string>>;

  /**
   * Tool names to remove from the agent's visible tool set.
   *
   * Applied via a filtering middleware after all tool-injecting
   * middleware have run, so it catches both user-provided and
   * middleware-provided tools.
   */
  excludedTools: ReadonlySet<string>;

  /**
   * Middleware names to remove from the assembled middleware stack.
   *
   * Matched against each middleware's `.name` property. Cannot include
   * required scaffolding names (`FilesystemMiddleware`,
   * `SubAgentMiddleware`) — attempting to do so throws at construction
   * time.
   */
  excludedMiddleware: ReadonlySet<string>;

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
  for (const name of options.excludedMiddleware ?? []) {
    validateExcludedMiddlewareName(name);
  }

  const toolDescriptionOverrides = Object.freeze(
    Object.assign(
      Object.create(null) as Record<string, string>,
      options.toolDescriptionOverrides,
    ),
  );

  const generalPurposeSubagent = options.generalPurposeSubagent
    ? Object.freeze({ ...options.generalPurposeSubagent })
    : undefined;

  const profile: HarnessProfile = {
    baseSystemPrompt: options.baseSystemPrompt,
    systemPromptSuffix: options.systemPromptSuffix,
    toolDescriptionOverrides,
    excludedTools: new Set(options.excludedTools),
    excludedMiddleware: new Set(options.excludedMiddleware),
    extraMiddleware: options.extraMiddleware ?? [],
    generalPurposeSubagent,
  };

  return Object.freeze(profile);
}

/**
 * Recursively check an object for prototype-pollution keys.
 *
 * Rejects `__proto__`, `constructor`, and `prototype` at any nesting
 * depth. Called before Zod parsing so poisoned payloads never reach
 * schema validation.
 */
function rejectPoisonedKeys(value: unknown, path = ""): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }

  for (const key of Object.keys(value)) {
    if (POISONED_KEYS.has(key)) {
      throw new Error(
        `Rejected dangerous key "${key}" at ${path || "root"} in harness profile config.`,
      );
    }

    rejectPoisonedKeys(
      (value as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
    );
  }
}

/**
 * Parse an untrusted JSON/YAML object into a validated
 * {@link HarnessProfile}.
 *
 * Combines Zod schema validation with prototype-pollution protection
 * and profile construction validation. Use this for any config data
 * that originates from files, network, or user input.
 *
 * @param data - Raw object from `JSON.parse()` or `YAML.parse()`.
 * @returns A frozen, validated `HarnessProfile`.
 * @throws {z.ZodError} When the data fails schema validation.
 * @throws {Error} When profile-level validation fails (e.g.,
 *   scaffolding violation in `excludedMiddleware`).
 */
export function parseHarnessProfileConfig(data: unknown): HarnessProfile {
  rejectPoisonedKeys(data);
  const parsed = harnessProfileConfigSchema.parse(data);
  return createHarnessProfile(parsed);
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

/**
 * Serialize a {@link HarnessProfile} to a JSON-compatible object.
 *
 * Omits `undefined` fields and `extraMiddleware` (runtime-only).
 * Throws if `extraMiddleware` contains instances — callers should
 * strip it before serializing if they've set it.
 *
 * @param profile - The profile to serialize.
 * @returns A plain object matching {@link HarnessProfileConfigData}.
 * @throws {Error} When `extraMiddleware` is non-empty (cannot be
 *   serialized to JSON).
 */
export function serializeProfile(
  profile: HarnessProfile,
): HarnessProfileConfigData {
  const middleware = resolveMiddleware(profile.extraMiddleware);
  if (middleware.length > 0) {
    throw new Error(
      "Cannot serialize a HarnessProfile with non-empty extraMiddleware — " +
        "middleware instances are runtime-only and have no JSON representation.",
    );
  }

  const result: Record<string, unknown> = {};

  if (profile.baseSystemPrompt !== undefined) {
    result.baseSystemPrompt = profile.baseSystemPrompt;
  }

  if (profile.systemPromptSuffix !== undefined) {
    result.systemPromptSuffix = profile.systemPromptSuffix;
  }

  if (Object.keys(profile.toolDescriptionOverrides).length > 0) {
    result.toolDescriptionOverrides = { ...profile.toolDescriptionOverrides };
  }

  if (profile.excludedTools.size > 0) {
    result.excludedTools = [...profile.excludedTools];
  }

  if (profile.excludedMiddleware.size > 0) {
    result.excludedMiddleware = [...profile.excludedMiddleware];
  }

  if (profile.generalPurposeSubagent !== undefined) {
    const gp: Record<string, unknown> = {};

    if (profile.generalPurposeSubagent.enabled !== undefined) {
      gp.enabled = profile.generalPurposeSubagent.enabled;
    }

    if (profile.generalPurposeSubagent.description !== undefined) {
      gp.description = profile.generalPurposeSubagent.description;
    }

    if (profile.generalPurposeSubagent.systemPrompt !== undefined) {
      gp.systemPrompt = profile.generalPurposeSubagent.systemPrompt;
    }

    if (Object.keys(gp).length > 0) {
      result.generalPurposeSubagent = gp;
    }
  }

  return result as HarnessProfileConfigData;
}
