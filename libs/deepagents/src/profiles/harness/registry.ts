import { validateProfileKey } from "../keys.js";
import type { HarnessProfile, HarnessProfileOptions } from "./types.js";
import { isHarnessProfile } from "./types.js";
import { createHarnessProfile, EMPTY_HARNESS_PROFILE } from "./create.js";
import { mergeProfiles } from "./merge.js";
import { loadBuiltinProfiles } from "./builtins/index.js";

/**
 * Process-global symbol key for the harness profile registry. The `.v1`
 * suffix is a version gate — bump it when the {@link HarnessProfileRegistry}
 * shape changes in a breaking way so that incompatible versions coexist
 * on `globalThis` without corrupting each other.
 */
const PROFILE_REGISTRY_KEY = Symbol.for("deepagents.harness-profiles.v1");

/**
 * Process-global registry state, keyed by a versioned symbol so that
 * duplicate package installs (transient deps resolving to different
 * copies of deepagents) share a single profile registry.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/for
 */
interface HarnessProfileRegistry {
  /**
   * Registered profiles keyed by model spec (e.g., `"anthropic:claude-opus-4-7"`).
   */
  profiles: Map<string, HarnessProfile>;

  /**
   * Keys that existed after built-in bootstrap, used to detect user registrations.
   */
  builtinKeys: Set<string>;

  /**
   * Whether built-in profiles have been lazy-loaded into the registry.
   */
  builtinsLoaded: boolean;
}

/**
 * Returns the process-global registry, creating it on first access.
 */
function getHarnessProfileRegistry(): HarnessProfileRegistry {
  const global = globalThis as Record<symbol, unknown>;
  if (global[PROFILE_REGISTRY_KEY] == null) {
    global[PROFILE_REGISTRY_KEY] = {
      profiles: new Map<string, HarnessProfile>(),
      builtinKeys: new Set<string>(),
      builtinsLoaded: false,
    };
  }
  return global[PROFILE_REGISTRY_KEY] as HarnessProfileRegistry;
}

/**
 * Options for resolving a harness profile from model metadata.
 */
export interface ResolveHarnessProfileOpts {
  /**
   * Model spec string (e.g., `"anthropic:claude-opus-4-7"`).
   */
  spec?: string;

  /**
   * Provider name extracted from a model instance (e.g., `"anthropic"`).
   */
  providerHint?: string;

  /**
   * Model identifier extracted from a model instance (e.g., `"claude-opus-4-7"`).
   */
  identifierHint?: string;
}

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
  const registry = getHarnessProfileRegistry();
  if (registry.builtinsLoaded) return;
  registry.builtinsLoaded = true;
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
  const registry = getHarnessProfileRegistry();
  registry.builtinKeys = new Set(registry.profiles.keys());
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
  const { profiles } = getHarnessProfileRegistry();
  const existing = profiles.get(key);
  if (existing !== undefined) {
    profiles.set(key, mergeProfiles(existing, profile));
  } else {
    profiles.set(key, profile);
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

  const { profiles } = getHarnessProfileRegistry();
  const exact = profiles.get(spec);
  const base = provider ? profiles.get(provider) : undefined;

  if (exact !== undefined && base !== undefined) {
    return mergeProfiles(base, exact);
  }

  return exact ?? base;
}

/**
 * Resolve the harness profile for a model, falling back to the
 * empty default when nothing matches.
 *
 * When `spec` is set (the original model parameter), it drives the
 * lookup directly. When absent (pre-built model instance),
 * `providerHint` and `identifierHint` are used to construct lookup
 * keys.
 *
 * @param opts - Model metadata used to resolve the profile.
 * @returns The resolved profile (never `undefined`).
 *
 * @internal
 */
export function resolveHarnessProfile(
  opts: ResolveHarnessProfileOpts = {},
): HarnessProfile {
  const { spec, providerHint, identifierHint } = opts;
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
  const registry = getHarnessProfileRegistry();
  for (const key of registry.profiles.keys()) {
    if (!registry.builtinKeys.has(key)) {
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
 * Reset the registry to its empty state. For testing only.
 *
 * @internal
 */
export function _resetRegistryForTesting(): void {
  const registry = getHarnessProfileRegistry();
  registry.profiles.clear();
  registry.builtinKeys = new Set();
  registry.builtinsLoaded = false;
}
