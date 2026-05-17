import type {
  AnyBackendProtocol,
  BackendFactory,
} from "../backends/protocol.js";
import { resolveBackend } from "../backends/protocol.js";

import { BackendSkillProvider } from "./backend-provider.js";
import type { SkillMetadata } from "./discovery.js";
import type { LoadedSkill, SkillProvider } from "./provider.js";

/**
 * Construction options for `SkillRegistry`.
 */
export interface SkillRegistryOptions {
  /**
   * Mixed list of explicit `SkillProvider` instances and legacy string
   * source paths. Strings are wrapped lazily into `BackendSkillProvider`
   * instances during the first `list()` call.
   */
  skills: ReadonlyArray<string | SkillProvider>;

  /**
   * Backend used to wrap any string entries in `skills`. Optional when the
   * caller is sure they're only passing explicit providers; required when
   * any string entry is present. May be a factory since wrapping is
   * deferred to first use, when per-invocation state is available.
   */
  backend?: AnyBackendProtocol | BackendFactory;
}

/**
 * Internal coordination object that sits between the configured skill
 * sources and the middleware that consume them.
 *
 * Owns three things:
 *
 * - the merged `SkillMetadata` list across all configured providers
 * - the per-name lookup of which provider produced each skill
 * - the per-name `load()` cache so the underlying provider's `load` runs
 *   at most once per agent invocation regardless of how many consumers ask
 *
 * Construction is cheap. Discovery is lazy: the first `list(state)` call
 * wraps any string entries, runs `provider.list()` across every provider,
 * and builds the per-name provider lookup. `load(name)` triggers
 * discovery internally if it hasn't run yet.
 *
 * Not exported from the package index — `createDeepAgent` constructs the
 * registry internally and passes it to the middleware that need it.
 */
export class SkillRegistry {
  private readonly skills: ReadonlyArray<string | SkillProvider>;
  private readonly backend: AnyBackendProtocol | BackendFactory | undefined;

  /**
   * Memoized result of the first `list()` call. Holds the discovery
   * promise so concurrent and subsequent `list()` calls share one fetch.
   */
  private discoveryPromise: Promise<SkillMetadata[]> | undefined;

  /**
   * Per-skill-name lookup of the provider that produced the metadata
   * during discovery. Built by `discover()` and consulted by `load()` to
   * route each name to its owning provider.
   */
  private readonly providerByName = new Map<string, SkillProvider>();

  /**
   * Per-skill-name cache of in-flight or completed `load()` calls.
   * Ensures the underlying provider's `load` runs at most once per
   * invocation even when the activation tool and the code interpreter
   * both reach for the same skill.
   */
  private readonly loadCache = new Map<string, Promise<LoadedSkill>>();

  constructor(opts: SkillRegistryOptions) {
    this.skills = opts.skills;
    this.backend = opts.backend;
  }

  /**
   * Return the merged metadata across every configured provider.
   * Idempotent within a single registry instance. The first call resolves
   * string entries to `BackendSkillProvider` instances (which requires
   * state for factory-pattern backends, so `state` is threaded through).
   * Subsequent calls return the cached list and ignore the `state`
   * argument.
   */
  list(state?: unknown): Promise<SkillMetadata[]> {
    return this.ensureDiscovered(state);
  }

  /**
   * Return the full `LoadedSkill` for a skill by name. Cached after the
   * first call so multiple consumers (the `skill` tool, the code
   * interpreter session) share one fetch. Triggers discovery internally
   * if it hasn't run yet. Throws when the skill is unknown to every
   * configured provider.
   */
  async load(name: string, state?: unknown): Promise<LoadedSkill> {
    await this.ensureDiscovered(state);

    const cached = this.loadCache.get(name);
    if (cached !== undefined) {
      return cached;
    }

    const owner = this.providerByName.get(name);
    if (owner === undefined) {
      throw new Error(
        `SkillRegistry: no provider exposes a skill named '${name}'`,
      );
    }

    const pending = owner.load(name);
    this.loadCache.set(name, pending);

    try {
      return await pending;
    } catch (err) {
      this.loadCache.delete(name);
      throw err;
    }
  }

  /**
   * Synchronization point used by both `list` and `load` to make sure
   * discovery has run. The first call kicks off `discover()` and
   * memoizes its promise; subsequent calls return the same promise so
   * the underlying provider walks happen exactly once per registry
   * instance. The returned metadata array is what `list()` exposes
   * publicly; `load()` calls this purely for the side effect of
   * populating `providerByName`.
   */
  private ensureDiscovered(state: unknown): Promise<SkillMetadata[]> {
    if (this.discoveryPromise === undefined) {
      this.discoveryPromise = this.discover(state);
    }
    return this.discoveryPromise;
  }

  /**
   * One-shot discovery. Wraps string entries, runs `provider.list()` across
   * every provider, and builds the per-name provider lookup. Later
   * providers win on name collision (matches the existing "last source
   * wins" rule).
   */
  private async discover(state: unknown): Promise<SkillMetadata[]> {
    const providers = await this.materializeProviders(state);
    const merged = new Map<string, SkillMetadata>();

    for (const provider of providers) {
      const entries = await this.safeList(provider);
      for (const entry of entries) {
        merged.set(entry.name, entry);
        this.providerByName.set(entry.name, provider);
      }
    }

    return [...merged.values()];
  }

  /**
   * Resolve any string entries in `skills` to `BackendSkillProvider`
   * instances, leaving explicit providers untouched. Throws if a string
   * entry is present and no backend was configured.
   */
  private async materializeProviders(state: unknown): Promise<SkillProvider[]> {
    let resolvedBackend: AnyBackendProtocol | undefined;
    const ensureBackend = async (): Promise<AnyBackendProtocol> => {
      if (resolvedBackend !== undefined) {
        return resolvedBackend;
      }
      if (this.backend === undefined) {
        throw new Error(
          "SkillRegistry: a string skill source was provided but no backend is configured to read it from",
        );
      }
      resolvedBackend = await resolveBackend(this.backend, { state });
      return resolvedBackend;
    };

    const providers: SkillProvider[] = [];
    for (const entry of this.skills) {
      if (typeof entry === "string") {
        const backend = await ensureBackend();
        providers.push(
          new BackendSkillProvider({ backend, sourcePath: entry }),
        );
        continue;
      }
      providers.push(entry);
    }

    return providers;
  }

  /**
   * Run `provider.list()` and swallow failures so a single broken
   * provider doesn't take down discovery for every other provider. The
   * failure is logged via `console.debug` for diagnostics.
   */
  private async safeList(provider: SkillProvider): Promise<SkillMetadata[]> {
    try {
      return await provider.list();
    } catch (error) {
      console.debug(
        `[SkillRegistry] provider '${provider.id}' failed to list:`,
        error,
      );
      return [];
    }
  }
}
