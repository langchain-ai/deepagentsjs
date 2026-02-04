/**
 * Authentication utilities for LangSmith Sandbox.
 *
 * This module provides authentication credential resolution for the LangSmith Sandbox API.
 *
 * @packageDocumentation
 */

import type { LangSmithSandboxOptions } from "./types.js";

/**
 * Authentication credentials for LangSmith Sandbox API.
 */
export interface LangSmithCredentials {
  /** LangSmith API key */
  apiKey: string;
}

/**
 * Get the authentication API key for LangSmith Sandbox API.
 *
 * Authentication is resolved in the following priority order:
 *
 * 1. **Explicit API key**: If `options.apiKey` is provided, it is used directly.
 * 2. **LANGSMITH_API_KEY**: Primary environment variable for LangSmith.
 * 3. **LANGCHAIN_API_KEY**: Alternative environment variable (for compatibility).
 *
 * If no API key is found, an error is thrown with setup instructions.
 *
 * ## Environment Variable Setup
 *
 * ```bash
 * # Get your API key from https://smith.langchain.com
 * export LANGSMITH_API_KEY=your_api_key_here
 * ```
 *
 * @param options - Optional authentication configuration from LangSmithSandboxOptions
 * @returns The authentication API key string
 * @throws {Error} If no authentication API key is available
 *
 * @example
 * ```typescript
 * // With explicit API key
 * const apiKey = getAuthApiKey({ apiKey: "lsv2_..." });
 *
 * // Using environment variables (auto-detected)
 * const apiKey = getAuthApiKey();
 *
 * // From LangSmithSandboxOptions
 * const options: LangSmithSandboxOptions = {
 *   templateName: "default",
 *   auth: { apiKey: "lsv2_..." }
 * };
 * const apiKey = getAuthApiKey(options.auth);
 * ```
 */
export function getAuthApiKey(
  options?: LangSmithSandboxOptions["auth"],
): string {
  // Priority 1: Explicit API key in options
  if (options?.apiKey) {
    return options.apiKey;
  }

  // Priority 2: LANGSMITH_API_KEY environment variable
  const langsmithKey = process.env.LANGSMITH_API_KEY;
  if (langsmithKey) {
    return langsmithKey;
  }

  // Priority 3: LANGCHAIN_API_KEY environment variable (compatibility)
  const langchainKey = process.env.LANGCHAIN_API_KEY;
  if (langchainKey) {
    return langchainKey;
  }

  // No API key found - throw descriptive error
  throw new Error(
    "LangSmith authentication required. Provide an API key using one of these methods:\n\n" +
      "1. Set LANGSMITH_API_KEY environment variable:\n" +
      "   Get your API key from https://smith.langchain.com\n" +
      "   Run: export LANGSMITH_API_KEY=your_api_key_here\n\n" +
      "2. Set LANGCHAIN_API_KEY environment variable (alternative)\n\n" +
      "3. Pass API key directly in options:\n" +
      '   new LangSmithSandbox({ templateName: "default", auth: { apiKey: "..." } })',
  );
}

/**
 * Get authentication credentials for LangSmith Sandbox API.
 *
 * This function returns the credentials needed for the LangSmith API.
 *
 * @param options - Optional authentication configuration from LangSmithSandboxOptions
 * @returns Complete authentication credentials
 * @throws {Error} If no authentication API key is available
 */
export function getAuthCredentials(
  options?: LangSmithSandboxOptions["auth"],
): LangSmithCredentials {
  return {
    apiKey: getAuthApiKey(options),
  };
}
