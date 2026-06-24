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

export interface ProviderConfig<T extends string = string> {
  /** Unique id, e.g. "anthropic" */
  id: T;
  /** Shown in the "Select your provider" prompt */
  title: string;
  /** Default model, e.g. "openai:gpt-5.4-mini" */
  defaultModel: string;
  /** LangChain chat model package, e.g. "@langchain/openai" */
  dependency: string;
  /** Extra constructor args for the coordinator model as raw JS, e.g. `reasoning: { effort: "low", summary: "auto" }` */
  coordinatorModelConfig?: string;
  /** Credential vars to prompt for + write to the env file */
  env: EnvVarSpec[];
}

export function createProvider<T extends string>(
  config: ProviderConfig<T>,
): ProviderConfig<T> {
  return config;
}
