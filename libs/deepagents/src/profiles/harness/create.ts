import type { HarnessProfile, HarnessProfileOptions } from "./types.js";
import { REQUIRED_MIDDLEWARE_NAMES } from "./types.js";

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
 * frozen counterparts, and returns a frozen object.
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
 * An empty no-op profile used as the default when no registered
 * profile matches. Avoids creating a new object on every miss.
 */
export const EMPTY_HARNESS_PROFILE: HarnessProfile = createHarnessProfile();
