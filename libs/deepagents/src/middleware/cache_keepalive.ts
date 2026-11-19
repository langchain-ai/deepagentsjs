/**
 * Keep the Anthropic prompt cache warm while a slow tool runs.
 *
 * Anthropic's default prompt-cache entry lives five minutes from the start of
 * the last request that wrote or read it. When a tool runs longer than that (a
 * build, a test suite, a subagent), the next model call misses the cache and
 * re-writes the whole conversation at the cache-write price. This middleware
 * re-sends the previous model request with `max_tokens: 1` before the entry
 * expires: the API reads the cached prefix, refreshes its timer, and returns one
 * token, so the ping costs one cache read and one output token.
 */
import { createMiddleware, AIMessage } from "langchain";
import type { ModelRequest } from "langchain";
import { omitPayload } from "@langchain/core/tracers/tracer_langchain";

/**
 * Import langchain for type inference
 */
import type * as _langchain from "langchain";

import { isAnthropicModel } from "../utils.js";

/** Ping one minute before Anthropic's five-minute cache entry would expire. */
const DEFAULT_INTERVAL_MS = 240_000;

/** Bounds the cost of a hung tool to a handful of cache reads. */
const DEFAULT_MAX_PINGS = 6;

/** Dollars a ping must be expected to save before it is sent. */
const DEFAULT_MIN_EXPECTED_SAVINGS = 0.05;

/** Model calls whose tool calls never ran (rejected, interrupted) are dropped past this. */
const MAX_TRACKED_CALLS = 64;

/** Trace tag on every ping, so pings can be filtered out of turn and call counts. */
export const CACHE_KEEPALIVE_PING_TAG = "cache_keepalive";

/** LangGraph's `messages` stream skips model runs carrying this tag. */
const NOSTREAM_TAG = "nostream";

/**
 * Prompt-cache prices of a model, in dollars per million tokens.
 *
 * Used to skip pings that would cost more than the cache miss they prevent.
 *
 * @example
 * ```ts
 * // Claude Opus 5.5 list prices: cache read $0.20, 5-minute cache write $5.
 * const pricing: CachePricing = { cacheRead: 0.2, cacheWrite: 5 };
 * ```
 */
export interface CachePricing {
  /** Price of reading cached prompt tokens. */
  cacheRead: number;
  /** Price of writing prompt tokens to the cache (the TTL the requests use). */
  cacheWrite: number;
}

/**
 * Dollars a ping is expected to save for a prompt of `promptTokens` tokens.
 *
 * A ping reads the cached prompt and outputs nothing; skipping it means the
 * next request writes the prompt again instead of reading it. While a tool
 * call runs, that next request is certain, so the saving is the miss's extra
 * cost minus the ping's cost.
 */
export function expectedCacheSavings(
  pricing: CachePricing,
  promptTokens: number,
): number {
  const missCost =
    (promptTokens * (pricing.cacheWrite - pricing.cacheRead)) / 1e6;
  const pingCost = (promptTokens * pricing.cacheRead) / 1e6;
  return missCost - pingCost;
}

/**
 * Options for {@link anthropicCacheKeepaliveMiddleware}.
 */
export interface AnthropicCacheKeepaliveMiddlewareOptions {
  /**
   * Milliseconds between the start of the last model request and the next
   * ping. Keep it under the cache entry's five-minute TTL.
   * @default 240000
   */
  interval?: number;
  /**
   * Most pings sent while one batch of tool calls runs.
   * @default 6
   */
  maxPings?: number;
  /**
   * The model's cache prices. When unset, every long tool call is pinged
   * regardless of prompt size.
   */
  pricing?: CachePricing;
  /**
   * Dollars a ping must be expected to save, per `pricing`, before pings start
   * for a tool call. Prompts whose size the model response did not report are
   * always pinged.
   * @default 0.05
   */
  minExpectedSavings?: number;
}

type ModelHandler = (request: ModelRequest) => Promise<AIMessage> | AIMessage;

/** The last model request whose tool calls are now running. */
interface PendingCall {
  request: ModelRequest;
  handler: ModelHandler;
  startedAt: number;
  promptTokens?: number;
  activeTools: number;
  pings: number;
  stop: AbortController;
}

/** Model fields a ping overrides: one output token and no streaming. */
const PING_MODEL_FIELDS = {
  maxTokens: 1,
  streaming: false,
  disableStreaming: true,
};

/** The chat model instance behind `model`, resolving a configurable model. */
async function baseModel(model: ModelRequest["model"]) {
  return model.getName() === "ConfigurableModel"
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (model as any)._getModelInstance()
    : model;
}

/**
 * Whether `model` uses extended thinking with a token budget.
 *
 * The budget is tied to `max_tokens`, so a one-token ping would change it, and
 * Anthropic keys the message cache on it. Adaptive thinking has no budget and
 * pings normally.
 */
async function usesBudgetThinking(
  model: ModelRequest["model"],
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((await baseModel(model)) as any).thinking?.type === "enabled";
}

/**
 * Return a copy of `model` that asks for one output token and never streams.
 *
 * The Anthropic API rejects `max_tokens: 0` with streaming, extended thinking,
 * structured output or a forced tool choice; one token avoids those limits. JS
 * chat models read `max_tokens` from the instance rather than call options, so
 * the ping shadows those fields on an object whose prototype is the original
 * instance. Everything else, tools and cache markers included, stays the same,
 * so the prefix the ping reads matches the original request byte for byte.
 */
async function pingModel(model: ModelRequest["model"]) {
  return Object.assign(
    Object.create(await baseModel(model)),
    PING_MODEL_FIELDS,
  );
}

/**
 * Return `request` as a ping: same prompt, one output token, tagged so LangGraph's
 * `messages` stream skips the empty reply. Tags change only the callbacks, not
 * the request sent to the API.
 */
async function pingRequest(request: ModelRequest): Promise<ModelRequest> {
  const settings = request.modelSettings ?? {};
  const tags = Array.isArray(settings.tags) ? settings.tags : [];
  return {
    ...request,
    model: await pingModel(request.model),
    modelSettings: {
      ...settings,
      tags: [...tags, NOSTREAM_TAG, CACHE_KEEPALIVE_PING_TAG],
    },
  };
}

function toolCallIds(message: AIMessage): string[] {
  return (message.tool_calls ?? [])
    .map((call) => call.id)
    .filter((id): id is string => !!id);
}

/** Resolve after `ms`, or early with `true` once `signal` aborts. */
function waitOrStop(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Creates a middleware that re-reads the Anthropic prompt cache while a long
 * tool call runs.
 *
 * Pings start only for tool calls that follow an Anthropic model call, stop as
 * soon as the last of those tool calls finishes, and stop for good after
 * `maxPings` pings or the first ping error, so a hung tool costs at most
 * `maxPings` cache reads. With `pricing`, pings are skipped when the prompt is
 * too small for a cache miss to cost `minExpectedSavings` more than a ping.
 * Requests that use extended thinking with a token budget are never pinged,
 * since a ping would change the budget and miss the cache. Pings appear in
 * traces as model calls with one output token, tagged
 * `cache_keepalive` and `nostream` so they never reach a `messages` stream.
 * Requests to other providers pass through untouched.
 *
 * @experimental This middleware is experimental and may change in a future release.
 *
 * @example
 * ```ts
 * import { createDeepAgent, anthropicCacheKeepaliveMiddleware } from "deepagents";
 *
 * const agent = createDeepAgent({
 *   model: "anthropic:claude-opus-5-5",
 *   middleware: [anthropicCacheKeepaliveMiddleware()],
 * });
 * ```
 */
export function anthropicCacheKeepaliveMiddleware(
  options: AnthropicCacheKeepaliveMiddlewareOptions = {},
) {
  const {
    interval = DEFAULT_INTERVAL_MS,
    maxPings = DEFAULT_MAX_PINGS,
    pricing,
    minExpectedSavings = DEFAULT_MIN_EXPECTED_SAVINGS,
  } = options;
  const pending = new Map<string, PendingCall>();
  let warnedThinking = false;

  const pingable = async (request: ModelRequest): Promise<boolean> => {
    if (!isAnthropicModel(request.model)) return false;
    if (!(await usesBudgetThinking(request.model))) return true;
    if (!warnedThinking) {
      warnedThinking = true;
      // oxlint-disable-next-line no-console
      console.warn(
        "Prompt-cache keep-alive is off for requests with budgeted extended thinking: a ping would change the thinking budget and miss the cache.",
      );
    }
    return false;
  };

  const pays = (call: PendingCall): boolean => {
    if (pricing === undefined || call.promptTokens === undefined) return true;
    return (
      expectedCacheSavings(pricing, call.promptTokens) >= minExpectedSavings
    );
  };

  const register = (response: AIMessage, call: PendingCall): void => {
    for (const id of toolCallIds(response)) pending.set(id, call);
    for (const oldest of pending.keys()) {
      if (pending.size <= MAX_TRACKED_CALLS) break;
      pending.delete(oldest);
    }
  };

  const pingLoop = async (call: PendingCall): Promise<void> => {
    while (call.pings < maxPings) {
      const delay = Math.max(call.startedAt + interval - Date.now(), 0);
      if (await waitOrStop(delay, call.stop.signal)) return;
      call.startedAt = Date.now();
      call.pings += 1;
      try {
        await call.handler(await pingRequest(call.request));
      } catch (error) {
        // A best-effort ping must never fail the running tool call.
        // oxlint-disable-next-line no-console
        console.warn(
          "Prompt-cache keep-alive ping failed; stopping pings.",
          error,
        );
        return;
      }
    }
  };

  return createMiddleware({
    name: "AnthropicCacheKeepaliveMiddleware",
    tracePolicy: { processInputs: omitPayload },

    async wrapModelCall(request, handler) {
      const startedAt = Date.now();
      const response = await handler(request);
      if (
        AIMessage.isInstance(response) &&
        (await pingable(request as ModelRequest))
      ) {
        register(response, {
          request: request as ModelRequest,
          handler: handler as ModelHandler,
          startedAt,
          promptTokens: response.usage_metadata?.input_tokens,
          activeTools: 0,
          pings: 0,
          stop: new AbortController(),
        });
      }
      return response;
    },

    async wrapToolCall(request, handler) {
      const id = request.toolCall.id ?? "";
      const call = pending.get(id);
      pending.delete(id);
      if (call === undefined || !pays(call)) return handler(request);
      call.activeTools += 1;
      if (call.activeTools === 1) {
        call.stop = new AbortController();
        void pingLoop(call);
      }
      try {
        return await handler(request);
      } finally {
        call.activeTools -= 1;
        if (call.activeTools === 0) call.stop.abort();
      }
    },
  });
}
