export interface EnvVarSpec {
  /** Env var name, e.g. "OPENAI_API_KEY" */
  name: string;
  /** Prompt label, e.g. "OpenAI API key" */
  prompt?: string;
  /** Whether the user must enter a value (default: false — may skip and fill .env later) */
  required?: boolean;
  /** Prefill value */
  default?: string;
}

export interface ProviderConfig<T extends string = string> {
  /** Unique id, e.g. "anthropic" */
  id: T;
  /** Shown in the "Select your provider" prompt */
  title: string;
  /** Default model, e.g. "gpt-5.4" */
  defaultModel: string;
  /** Required dependencies to merge into package.json */
  dependencies: string[];
  /** Credential vars to prompt for + write to the env file */
  env: EnvVarSpec[];
}

export function createProvider<T extends string>(
  config: ProviderConfig<T>,
): ProviderConfig<T> {
  return config;
}
