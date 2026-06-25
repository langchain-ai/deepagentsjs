import { MODEL_PROVIDER_CONFIG } from "langchain/chat_models/universal";
import { JSONValue } from "../types.js";

export type ProviderAwareFile = {
  /** Path relative to project root, e.g. "worker/env.d.ts" */
  path: string;
  /** Returns the file content, optionally using provider config for string injection */
  getContent: (config: { providerConfig: ProviderConfig }) => string;
};

export type EnvVarSpec = {
  /** Env var name, e.g. "OPENAI_API_KEY" */
  name: string;
  /** Prompt label, e.g. "OpenAI API key" */
  prompt?: string;
  /** Whether the user must enter a value (default: false — may skip and fill .env later) */
  required?: boolean;
  /** Prefill value */
  default?: string;
};

type ProviderKey = keyof typeof MODEL_PROVIDER_CONFIG;
export interface ProviderConfig<T extends ProviderKey = ProviderKey> {
  /** Unique ID, one of `keyof typeof MODEL_PROVIDER_CONFIG` from langchain/chat_models/universal */
  id: T;
  /** Shown in the "Select your provider" prompt */
  title: string;
  /** Default model, e.g. "openai:gpt-5.4-mini" */
  defaultModel: string;
  /** LangChain chat model package, e.g. "@langchain/openai" */
  package: string;
  /** Extra constructor options for the coordinator model, e.g. `{ reasoning: { effort: "low", summary: "auto" } }` */
  coordinatorModelConfig?: Record<string, JSONValue>;
  /** Credential vars to prompt for + write to the env file */
  env: EnvVarSpec[];
}

export function createProvider<T extends ProviderKey>(
  config: Omit<ProviderConfig<T>, "package">,
): ProviderConfig<T> {
  return {
    ...config,
    package: MODEL_PROVIDER_CONFIG[config.id].package,
  };
}
