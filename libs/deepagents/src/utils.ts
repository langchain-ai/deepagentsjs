import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { RunnableInterface } from "@langchain/core/runnables";

/**
 * Detect whether a model is an Anthropic model.
 *
 * Used to gate Anthropic-specific prompt caching optimizations
 * (cache_control breakpoints).
 *
 * Accepts the wider `RunnableInterface` shape (the type of `request.model`
 * inside `wrapModelCall`, aliased as `AgentLanguageModelLike` in langchain)
 * because the function only depends on `.getName()`, which is part of the
 * Runnable contract. `BaseLanguageModel` extends `Runnable`, so existing
 * call sites still type-check.
 */
export function isAnthropicModel(
  model: BaseLanguageModel | RunnableInterface<unknown, unknown> | string,
): boolean {
  if (typeof model === "string") {
    if (model.includes(":")) return model.split(":")[0] === "anthropic";
    return model.startsWith("claude");
  }
  if (model.getName() === "ConfigurableModel") {
    return (model as any)._defaultConfig?.modelProvider === "anthropic";
  }
  return model.getName() === "ChatAnthropic";
}

/**
 * A one-shot promise whose settlement is controlled externally.
 *
 * Use this when one part of a workflow must wait for an event that is owned
 * elsewhere—for example, a queued mutation waiting for the worker that will
 * push it. `Deferred` is awaitable because it implements `PromiseLike`, and
 * `.promise` is available when a concrete `Promise` is required.
 *
 * The first call to `resolve` or `reject` wins; later calls are ignored. This
 * class deliberately does not provide cancellation, reset, or notification
 * semantics. It models exactly one eventual outcome.
 */
export class Deferred<T = void> implements PromiseLike<T> {
  readonly promise: Promise<T>;

  private settled = false;
  private resolvePromise!: (value: T | PromiseLike<T>) => void;
  private rejectPromise!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(value: T | PromiseLike<T>): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolvePromise(value);
  }

  reject(reason?: unknown): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.rejectPromise(reason);
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }
}

/**
 * Detect whether a model is an AWS Bedrock Converse model.
 *
 * Accepts the wider `RunnableInterface` shape (the type of `request.model`
 * inside `wrapModelCall`, aliased as `AgentLanguageModelLike` in langchain)
 * because the function only depends on `.getName()`, which is part of the
 * Runnable contract. `BaseLanguageModel` extends `Runnable`, so existing
 * call sites still type-check.
 */
export function isBedrockConverseModel(
  model: BaseLanguageModel | RunnableInterface<unknown, unknown> | string,
): boolean {
  if (typeof model === "string") {
    // Explicit provider prefix (`bedrock:` or `aws:`) — both map to
    // ChatBedrockConverse in langchain's initChatModel.
    const colonIdx = model.indexOf(":");
    if (colonIdx !== -1) {
      const prefix = model.slice(0, colonIdx);
      if (prefix === "bedrock" || prefix === "aws") return true;
    }

    return model.startsWith("amazon.");
  }
  if (model.getName() === "ConfigurableModel") {
    const provider = (model as any)._defaultConfig?.modelProvider;
    return provider === "bedrock" || provider === "aws";
  }
  return model.getName() === "ChatBedrockConverse";
}

/**
 * Extract the provider name from a model instance for profile lookup.
 *
 * Checks `_defaultConfig.modelProvider` (ConfigurableModel) and falls
 * back to known model class name → provider mappings.
 *
 * @internal
 */
export function getModelProvider(
  model: BaseLanguageModel | RunnableInterface<unknown, unknown>,
): string | undefined {
  if (model.getName() === "ConfigurableModel") {
    return (model as any)._defaultConfig?.modelProvider as string | undefined;
  }
  const nameMap: Record<string, string> = {
    ChatAnthropic: "anthropic",
    ChatOpenAI: "openai",
    ChatGoogleGenerativeAI: "google",
  };
  return nameMap[model.getName()];
}

/**
 * Extract the model identifier from a model instance for profile
 * lookup.
 *
 * Checks `_defaultConfig.model`, `model_name`, and `modelName` in
 * that order.
 *
 * @internal
 */
export function getModelIdentifier(
  model: BaseLanguageModel | RunnableInterface<unknown, unknown>,
): string | undefined {
  const configurable =
    model.getName() === "ConfigurableModel"
      ? (model as any)._defaultConfig
      : undefined;
  return (
    configurable?.model ??
    (model as any).model_name ??
    (model as any).modelName ??
    undefined
  );
}
