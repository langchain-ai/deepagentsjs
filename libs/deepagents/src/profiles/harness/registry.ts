import { validateProfileKey } from "../keys.js";
import type { HarnessProfile, HarnessProfileOptions } from "./types.js";
import { isHarnessProfile } from "./types.js";
import { createHarnessProfile, EMPTY_HARNESS_PROFILE } from "./create.js";
import { mergeProfiles } from "./merge.js";
import { loadBuiltinProfiles } from "./builtins/index.js";

const registry = new Map<string, HarnessProfile>();

/**
 * Set of keys that existed after builtin bootstrap completed.
 *
 * Used by {@link hasUserRegisteredProfiles} to distinguish user
 * registrations from built-in ones (for logging verbosity).
 */
let builtinKeys = new Set<string>();
let builtinsLoaded = false;

/**
 * Ensure lazy-loaded builtin profiles have been registered.
 *
 * Called by the public `registerHarnessProfile` and lookup functions.
 * Built-in registration modules call `registerHarnessProfileImpl`
 * directly to avoid re-entrant bootstrap.
 *
 * @internal
 */
export function ensureBuiltinsLoaded(): void {
  if (builtinsLoaded) return;
  builtinsLoaded = true;
  loadBuiltinProfiles();
}

/**
 * Snapshot the current registry keys as the builtin baseline.
 *
 * Called by the builtin loader after all built-in profiles are
 * registered. This allows {@link hasUserRegisteredProfiles} to
 * distinguish user registrations from built-ins.
 *
 * @internal
 */
export function snapshotBuiltinKeys(): void {
  builtinKeys = new Set(registry.keys());
}

/**
 * Core registration implementation. Does not trigger lazy bootstrap.
 *
 * Used by built-in profile modules during bootstrap. External callers
 * should use {@link registerHarnessProfile} instead.
 *
 * @internal
 */
export function registerHarnessProfileImpl(
  key: string,
  profile: HarnessProfile,
): void {
  key = validateProfileKey(key);
  const existing = registry.get(key);
  if (existing !== undefined) {
    registry.set(key, mergeProfiles(existing, profile));
  } else {
    registry.set(key, profile);
  }
}

/**
 * Register a harness profile for a provider or specific model.
 *
 * Accepts either a pre-built {@link HarnessProfile} (from
 * {@link createHarnessProfile}) or raw {@link HarnessProfileOptions}
 * that will be validated and frozen automatically.
 *
 * Registrations are **additive**: if a profile already exists under
 * `key`, the new profile is merged on top. The incoming profile's
 * fields win on scalar conflicts; set fields union; middleware
 * sequences merge by name.
 *
 * @param key - Either a bare provider (`"openai"`) for provider-wide
 *   defaults, or `"provider:model"` for a per-model override.
 * @param profile - A `HarnessProfile` or options to build one from.
 * @throws {Error} When `key` is malformed or profile validation
 *   fails.
 *
 * @example
 * ```typescript
 * import { registerHarnessProfile } from "@langchain/deepagents";
 *
 * registerHarnessProfile("openai", {
 *   systemPromptSuffix: "Respond concisely.",
 * });
 *
 * registerHarnessProfile("openai:gpt-5.4", {
 *   excludedTools: ["execute"],
 * });
 * ```
 */
export function registerHarnessProfile(
  key: string,
  profile: HarnessProfile | HarnessProfileOptions,
): void {
  ensureBuiltinsLoaded();
  const resolved = isHarnessProfile(profile)
    ? profile
    : createHarnessProfile(profile);
  registerHarnessProfileImpl(key, resolved);
}

/**
 * Look up the {@link HarnessProfile} for a model spec string.
 *
 * Resolution order:
 *
 * 1. **Exact match** on `spec` (e.g., `"openai:gpt-5.4"`).
 * 2. **Provider prefix** (everything before `:`) when `spec` contains
 *    a colon and both halves are non-empty.
 * 3. When both exist, they are **merged** (provider as base, exact as
 *    override).
 * 4. `undefined` when nothing matches.
 *
 * Malformed specs (empty, multiple colons, empty halves) return
 * `undefined` without consulting the registry.
 *
 * @param spec - Model spec in `"provider:model"` format, or a bare
 *   provider/model identifier.
 * @returns The matching profile, or `undefined`.
 */
export function getHarnessProfile(spec: string): HarnessProfile | undefined {
  if (spec.split(":").length > 2) {
    return undefined;
  }

  const colonIdx = spec.indexOf(":");
  const hasColon = colonIdx !== -1;
  const provider = hasColon ? spec.slice(0, colonIdx) : undefined;
  const model = hasColon ? spec.slice(colonIdx + 1) : undefined;

  if (hasColon && (!provider || !model)) {
    return undefined;
  }

  ensureBuiltinsLoaded();

  const exact = registry.get(spec);
  const base = provider ? registry.get(provider) : undefined;

  if (exact !== undefined && base !== undefined) {
    return mergeProfiles(base, exact);
  }

  return exact ?? base;
}

/**
 * Resolve the harness profile for a model, falling back to the
 * empty default when nothing matches.
 *
 * When `spec` is a string (the original model parameter), it drives
 * the lookup directly. When `undefined` (pre-built model instance),
 * `providerHint` and `identifierHint` are used to construct lookup
 * keys.
 *
 * @param spec - Original model spec string, or `undefined` for
 *   pre-built model instances.
 * @param providerHint - Provider name extracted from a model instance.
 * @param identifierHint - Model identifier extracted from a model
 *   instance.
 * @returns The resolved profile (never `undefined`).
 *
 * @internal
 */
export function resolveHarnessProfile(
  spec?: string,
  providerHint?: string,
  identifierHint?: string,
): HarnessProfile {
  if (spec !== undefined) {
    return getHarnessProfile(spec) ?? EMPTY_HARNESS_PROFILE;
  }

  if (providerHint && identifierHint && !identifierHint.includes(":")) {
    const profile = getHarnessProfile(`${providerHint}:${identifierHint}`);
    if (profile) {
      return profile;
    }
  }
  if (identifierHint && identifierHint.includes(":")) {
    const profile = getHarnessProfile(identifierHint);
    if (profile) {
      return profile;
    }
  }
  if (providerHint) {
    const profile = getHarnessProfile(providerHint);
    if (profile) {
      return profile;
    }
  }

  return EMPTY_HARNESS_PROFILE;
}

/**
 * Returns `true` when at least one profile was registered by user
 * code (as opposed to built-in bootstrap).
 *
 * Used to calibrate log verbosity — a "no match" miss is
 * unsurprising when only built-ins are loaded.
 *
 * @internal
 */
export function hasUserRegisteredProfiles(): boolean {
  ensureBuiltinsLoaded();
  for (const key of registry.keys()) {
    if (!builtinKeys.has(key)) {
      return true;
    }
  }
  return false;
}

/**
 * Apply a profile's prompt overlay to a base prompt string.
 *
 * - `baseSystemPrompt` (when set) replaces `basePrompt` entirely.
 * - `systemPromptSuffix` (when set) is appended with `\n\n`.
 *
 * Both are independently optional. A profile that sets only the suffix
 * layers it on top of whatever base the caller passes in.
 *
 * Used uniformly for the main agent, declarative subagents, and the
 * auto-added general-purpose subagent.
 *
 * @param profile - The harness profile to apply.
 * @param basePrompt - The default base prompt (e.g., `BASE_AGENT_PROMPT`).
 * @returns The assembled prompt string.
 */
export function applyProfilePrompt(
  profile: HarnessProfile,
  basePrompt: string,
): string {
  const prompt =
    profile.baseSystemPrompt !== undefined
      ? profile.baseSystemPrompt
      : basePrompt;
  if (profile.systemPromptSuffix !== undefined) {
    return `${prompt}\n\n${profile.systemPromptSuffix}`;
  }
  return prompt;
}

/**
 * Reset the registry to empty state. For testing only.
 *
 * @internal
 */
export function _resetRegistryForTesting(): void {
  registry.clear();
  builtinKeys = new Set();
  builtinsLoaded = false;
}
