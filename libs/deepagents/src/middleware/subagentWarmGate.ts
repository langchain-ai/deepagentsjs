/**
 * Serialize-first cache warming for parallel `task` fan-out.
 *
 * When the main agent dispatches N subagents of the same type in one turn
 * (N `task` tool_calls in a single assistant message), the framework runs
 * them concurrently. Each is a fresh agent invocation with a byte-identical
 * system+tools prefix, so the FIRST request of that type writes that prefix
 * to Anthropic's prompt cache (1.25x input) and every later request within
 * the cache TTL can READ it (0.1x).
 *
 * Concurrent dispatch defeats that: all N fire before any has written the
 * cache, so all N cache-MISS and all N pay the write. For an 8-wide coder
 * fan-out with a ~25K prefix that's ~7 redundant writes (~$0.66 on Sonnet)
 * per build.
 *
 * This gate makes the first dispatch of a type the "warmer": it proceeds
 * immediately, and siblings of the same type wait a short window for the
 * warmer's first model response to land (writing the shared prefix) before
 * proceeding — so they cache-read instead of re-writing. Keyed by
 * subagent_type because same type == same compiled graph == same cached
 * prefix (the coding prefix is static across websites/turns, so warming is
 * even shared across builds). Self-heals via a TTL just under the cache
 * lifetime: once the window lapses the type goes cold again and the next
 * dispatch re-warms.
 *
 * Single dispatches are unaffected — with no recent warmer of that type the
 * caller IS the warmer and returns immediately. Worst case (a warmer that
 * dies before its first model call, or a first response slower than the
 * warm window) degrades to today's behavior: a stampede, never a hang —
 * `gate()` only ever returns immediately or sleeps a bounded interval.
 */

export interface WarmGateClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const defaultClock: WarmGateClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** ~3–5s observed first-response; 10s gives margin over reminders + the call. */
export const DEFAULT_WARM_MS = 10_000;
/** Just under Anthropic's 5-minute ephemeral cache TTL. */
export const DEFAULT_WARM_TTL_MS = 240_000;

export class SubagentWarmGate {
  /** subagent_type -> epoch ms when the current warmer for that cold type began. */
  private readonly warmStartedAt = new Map<string, number>();

  constructor(
    private readonly warmMs: number = DEFAULT_WARM_MS,
    private readonly ttlMs: number = DEFAULT_WARM_TTL_MS,
    private readonly clock: WarmGateClock = defaultClock,
  ) {}

  /**
   * Hold a sibling dispatch until the shared prefix for `type` is warm.
   * Returns immediately for the warmer (cold type) and for callers arriving
   * after the warm window; sleeps the remaining window for early siblings.
   */
  async gate(type: string): Promise<void> {
    const now = this.clock.now();
    const startedAt = this.warmStartedAt.get(type);

    // Cold type — never warmed, or the last warm is older than the cache
    // TTL. This caller is the warmer: mark and proceed immediately.
    if (startedAt == null || now - startedAt >= this.ttlMs) {
      this.warmStartedAt.set(type, now);
      return;
    }

    // A warmer started recently. Wait out the remaining warm window so its
    // first model response has written the shared prefix, then cache-read.
    const remaining = this.warmMs - (now - startedAt);
    if (remaining > 0) await this.clock.sleep(remaining);
  }
}

/**
 * Process-global gate. The prompt cache is keyed per API key + prefix
 * bytes, so a single shared instance correctly coordinates every concurrent
 * `task` dispatch in the process (including across websites, whose coding
 * prefix is identical).
 */
export const subagentWarmGate = new SubagentWarmGate();
