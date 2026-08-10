import { z } from "zod/v4";
import type { HarnessProfile } from "./types.js";
import { resolveMiddleware } from "./types.js";
import { createHarnessProfile } from "./create.js";

const POISONED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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
 * converts them to `Set`.
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
