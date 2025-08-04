import { ChatAnthropic } from "@langchain/anthropic";
import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { LanguageModelLike } from "./types.js";

/**
 * Default model configuration matching Python's get_default_model()
 * Returns a ChatAnthropic instance with claude-sonnet-4-20250514 and maxTokens: 64000
 */
export function getDefaultModel(): ChatAnthropic {
  return new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    maxTokens: 64000,
  });
}

/**
 * Type alias for the default model instance
 * Useful for type annotations and function signatures
 */
export type DefaultModelType = ChatAnthropic;

/**
 * Interface for model configuration options
 * Extends the basic Anthropic configuration with Deep Agents specific settings
 */
export interface ModelConfig {
  /** The model name to use */
  model?: string;
  /** Maximum number of tokens to generate */
  maxTokens?: number;
  /** Temperature for response generation */
  temperature?: number;
  /** API key for Anthropic (optional, can be set via environment) */
  apiKey?: string;
  /** Additional model parameters */
  [key: string]: any;
}

/**
 * Factory function to create a ChatAnthropic instance with custom configuration
 * Provides flexibility while maintaining defaults that match Python implementation
 */
export function createAnthropicModel(config: ModelConfig = {}): ChatAnthropic {
  const defaultConfig: ModelConfig = {
    model: "claude-sonnet-4-20250514",
    maxTokens: 64000,
  };

  const mergedConfig = { ...defaultConfig, ...config };

  return new ChatAnthropic(mergedConfig);
}

/**
 * Type guard to check if a model is a ChatAnthropic instance
 * Useful for runtime type checking in model handling
 */
export function isChatAnthropic(model: any): model is ChatAnthropic {
  return model instanceof ChatAnthropic;
}

/**
 * Type guard to check if a model is a valid language model
 * Useful for validating model parameters in function signatures
 */
export function isLanguageModel(model: any): model is BaseLanguageModel {
  return model && typeof model.invoke === "function";
}

/**
 * Utility function to resolve a LanguageModelLike to a concrete model instance
 * Handles both string model names and existing model instances
 */
export function resolveModel(model: LanguageModelLike | null | undefined): BaseLanguageModel {
  if (!model) {
    return getDefaultModel();
  }

  if (typeof model === "string") {
    // If it's a string, create a ChatAnthropic with that model name
    return createAnthropicModel({ model });
  }

  if (isLanguageModel(model)) {
    return model;
  }

  // Fallback to default model if we can't resolve the input
  return getDefaultModel();
}

/**
 * Constants for commonly used model names
 * Provides easy access to model identifiers
 */
export const MODEL_NAMES = {
  CLAUDE_SONNET_4: "claude-sonnet-4-20250514",
  CLAUDE_3_5_SONNET: "claude-3-5-sonnet-20241022",
  CLAUDE_3_HAIKU: "claude-3-haiku-20240307",
} as const;

/**
 * Type for model name constants
 */
export type ModelName = typeof MODEL_NAMES[keyof typeof MODEL_NAMES];

/**
 * Default export for convenience
 * Matches Python's pattern of importing get_default_model directly
 */
export default getDefaultModel;
