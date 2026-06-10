import { type BaseMessage } from "langchain";
import type { Runnable } from "@langchain/core/runnables";
import { HumanMessage } from "@langchain/core/messages";
import {
  createSubAgent,
  type SubAgent,
  type CreateSubAgentOptions,
  type SubagentSpecsPayload,
} from "deepagents";

const VARIANT_TTL_MS = 60_000;
const VARIANT_MAX_ENTRIES = 64;

const SCHEMA_MAX_BYTES = 4096;
const SCHEMA_MAX_DEPTH = 5;
const SCHEMA_MAX_PROPERTIES = 32;

/**
 * TTL cache for dynamically compiled subagent variants.
 *
 * Stores runnables keyed by a string identifier. Entries expire after
 * `ttlMs` of inactivity. When the cache reaches `maxEntries`, the
 * least-recently-used entry is evicted.
 */
export class VariantCache {
  private entries = new Map<
    string,
    { value: Runnable; lastAccessed: number }
  >();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    ttlMs: number = VARIANT_TTL_MS,
    maxEntries: number = VARIANT_MAX_ENTRIES,
  ) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Return a cached runnable or create one via `factory` on cache miss.
   *
   * Sweeps expired entries before lookup. Cache hits refresh the
   * last-accessed timestamp. Evicts LRU when at capacity.
   */
  getOrCreate(key: string, factory: () => Runnable): Runnable {
    this.sweep();

    const cached = this.entries.get(key);
    if (cached) {
      cached.lastAccessed = Date.now();
      return cached.value;
    }

    if (this.entries.size >= this.maxEntries) {
      this.evictLru();
    }

    const value = factory();
    this.entries.set(key, { value, lastAccessed: Date.now() });
    return value;
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Remove entries that haven't been accessed within the TTL window.
   */
  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastAccessed > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Evict the least-recently-used entry.
   */
  private evictLru(): void {
    if (this.entries.size === 0) return;
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }
}

/**
 * Validate that a response schema does not exceed size, depth, or
 * property-count limits.
 *
 * @throws Error if any limit is exceeded.
 */
export function validateResponseSchema(schema: Record<string, unknown>): void {
  const serialized = JSON.stringify(schema);
  if (serialized.length > SCHEMA_MAX_BYTES) {
    throw new Error(
      `responseSchema exceeds ${SCHEMA_MAX_BYTES} byte limit (${serialized.length} bytes)`,
    );
  }

  function check(
    node: Record<string, unknown>,
    depth: number,
    propCount: { value: number },
  ): void {
    if (depth > SCHEMA_MAX_DEPTH) {
      throw new Error(
        `responseSchema exceeds maximum nesting depth of ${SCHEMA_MAX_DEPTH}`,
      );
    }
    const props = node.properties;
    if (props != null && typeof props === "object" && !Array.isArray(props)) {
      const propObj = props as Record<string, unknown>;
      propCount.value += Object.keys(propObj).length;
      if (propCount.value > SCHEMA_MAX_PROPERTIES) {
        throw new Error(
          `responseSchema exceeds maximum of ${SCHEMA_MAX_PROPERTIES} properties`,
        );
      }
      for (const value of Object.values(propObj)) {
        if (
          value != null &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          check(value as Record<string, unknown>, depth + 1, propCount);
        }
      }
    }
    const items = node.items;
    if (items != null && typeof items === "object" && !Array.isArray(items)) {
      check(items as Record<string, unknown>, depth + 1, propCount);
    }
  }

  check(schema, 0, { value: 0 });
}

/**
 * Extract the output from a subagent invocation result.
 *
 * Checks for `structuredResponse` first (returned when `responseFormat`
 * is set), then falls back to the last AI message's text content.
 */
function extractOutput(result: Record<string, unknown>): unknown {
  if (!("messages" in result)) {
    throw new Error(
      "Subagent must return a state containing a 'messages' key.",
    );
  }

  const structured = result.structuredResponse;
  if (structured != null) {
    return structured;
  }

  const messages = result.messages as BaseMessage[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "ai") {
      const text = (msg as { text?: string }).text?.trim();
      if (text) return text;
    }
  }

  return "Task completed";
}

/**
 * Internal entry representing a single configured subagent.
 *
 * Lazily compiles the base runnable on first invocation.
 * Schema-constrained variants are compiled on demand via `VariantCache`.
 */
class SubagentEntry {
  /** Subagent name used for dispatch routing. */
  name: string;

  /** Human-readable description for prompt rendering. */
  description: string;

  private spec: SubAgent;
  private compileOptions: CreateSubAgentOptions;
  private runnableBacked: boolean;
  private runnable: Runnable | null;

  constructor(opts: {
    name: string;
    description: string;
    spec: SubAgent;
    compileOptions: CreateSubAgentOptions;
    runnableBacked: boolean;
    runnable: Runnable | null;
  }) {
    this.name = opts.name;
    this.description = opts.description;
    this.spec = opts.spec;
    this.compileOptions = opts.compileOptions;
    this.runnableBacked = opts.runnableBacked;
    this.runnable = opts.runnable;
  }

  /**
   * Return the base runnable, compiling lazily on first access.
   */
  baseRunnable(): Runnable {
    if (this.runnable != null) {
      return this.runnable;
    }
    const runnable = createSubAgent(this.spec, this.compileOptions);
    this.runnable = runnable;
    return runnable;
  }

  /**
   * Return a schema-constrained variant runnable for this spec.
   *
   * Recompiles the agent with `responseFormat` set to the given schema.
   * Variants are cached in the provided `VariantCache` keyed by
   * `name::normalizedSchemaJson`.
   *
   * @throws Error if this is a runnable-backed entry (no spec to recompile).
   */
  variantRunnable(
    responseSchema: Record<string, unknown>,
    cache: VariantCache,
  ): Runnable {
    if (this.runnableBacked) {
      throw new Error(
        `responseSchema cannot be used with runnable-backed subagent "${this.name}"; ` +
          "dynamic schemas require a declarative SubAgent spec.",
      );
    }

    const cacheKey = `${this.name}::${JSON.stringify(responseSchema, Object.keys(responseSchema).sort())}`;
    return cache.getOrCreate(cacheKey, () =>
      createSubAgent(
        { ...this.spec, responseFormat: responseSchema },
        this.compileOptions,
      ),
    );
  }
}

/**
 * Invoke subagents recreated from specs exposed by `createDeepAgent`.
 *
 * Receives the specs payload from configurable, lazily compiles agents
 * using `createSubAgent`, caches schema-constrained variants via
 * `VariantCache`, and invokes agents directly.
 */
export class SubagentDispatcher {
  private entries: Map<string, SubagentEntry> = new Map();
  private variantCache: VariantCache = new VariantCache();

  constructor(payload: SubagentSpecsPayload) {
    for (const sub of payload.subagents) {
      if (sub.runnableBacked && sub.runnable) {
        this.entries.set(
          sub.name,
          new SubagentEntry({
            name: sub.name,
            description: sub.description,
            spec: sub.spec,
            compileOptions: payload.compileOptions,
            runnableBacked: true,
            runnable: sub.runnable,
          }),
        );
      } else {
        this.entries.set(
          sub.name,
          new SubagentEntry({
            name: sub.name,
            description: sub.description,
            spec: sub.spec,
            compileOptions: payload.compileOptions,
            runnableBacked: false,
            runnable: null,
          }),
        );
      }
    }
  }

  /**
   * Configured subagent names and descriptions for prompt rendering.
   */
  get subagentDescriptions(): Array<{ name: string; description: string }> {
    return [...this.entries.values()].map((e) => ({
      name: e.name,
      description: e.description,
    }));
  }

  /**
   * Invoke one configured subagent and return its extracted output.
   *
   * @param description - Task description for the subagent.
   * @param subagentType - Name of the subagent to invoke.
   * @param responseSchema - Optional JSON Schema for structured output.
   * @returns Extracted output — string (text) or object (structured).
   */
  async invoke(
    description: string,
    subagentType: string,
    responseSchema?: Record<string, unknown>,
  ): Promise<unknown> {
    const entry = this.entries.get(subagentType);
    if (!entry) {
      const available = [...this.entries.keys()].join(", ");
      throw new Error(
        `Unknown subagent type "${subagentType}". Available: ${available}`,
      );
    }

    let subagent: Runnable;
    if (responseSchema != null) {
      validateResponseSchema(responseSchema);
      subagent = entry.variantRunnable(responseSchema, this.variantCache);
    } else {
      subagent = entry.baseRunnable();
    }

    const state = this.prepareState(description);
    const config = {
      configurable: { ls_agent_type: "subagent" },
      metadata: { lc_agent_name: subagentType },
    };

    const result = (await subagent.invoke(state, config)) as Record<
      string,
      unknown
    >;
    return extractOutput(result);
  }

  /**
   * Build the input state for a subagent invocation.
   */
  private prepareState(description: string): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    state.messages = [new HumanMessage({ content: description })];
    return state;
  }
}
