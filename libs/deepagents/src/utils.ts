import type { BaseLanguageModel } from "@langchain/core/language_models/base";

/**
 * Detect whether a model is an Anthropic model.
 *
 * Used to gate Anthropic-specific prompt caching optimizations
 * (cache_control breakpoints).
 */
export function isAnthropicModel(model: BaseLanguageModel | string): boolean {
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
 * Extract the provider name from a model instance for profile lookup.
 *
 * Checks `_defaultConfig.modelProvider` (ConfigurableModel) and falls
 * back to known model class name → provider mappings.
 *
 * @internal
 */
export function getModelProvider(model: BaseLanguageModel): string | undefined {
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
  model: BaseLanguageModel,
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
