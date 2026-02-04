/**
 * Authentication utilities for Daytona Sandbox.
 *
 * This module provides authentication credential resolution for the Daytona SDK.
 *
 * @packageDocumentation
 */

import type { DaytonaSandboxOptions } from "./types.js";

/**
 * Authentication credentials for Daytona API.
 */
export interface DaytonaCredentials {
  /** Daytona API key */
  apiKey: string;

  /** Daytona API URL */
  apiUrl: string;

  /** Target region */
  target?: string;
}

/** Default Daytona API URL */
const DEFAULT_API_URL = "https://app.daytona.io/api";

/**
 * Get the API key for Daytona API.
 *
 * Authentication is resolved in the following priority order:
 *
 * 1. **Explicit API key**: If `options.apiKey` is provided, it is used directly.
 * 2. **DAYTONA_API_KEY**: Environment variable for Daytona API key.
 *
 * If no API key is found, an error is thrown with setup instructions.
 *
 * ## Environment Variable Setup
 *
 * ```bash
 * # Get your API key from https://app.daytona.io
 * export DAYTONA_API_KEY=your_api_key_here
 * ```
 *
 * @param options - Optional authentication configuration from DaytonaSandboxOptions
 * @returns The API key string
 * @throws {Error} If no API key is available
 *
 * @example
 * ```typescript
 * // With explicit API key
 * const apiKey = getAuthApiKey({ apiKey: "my-api-key" });
 *
 * // Using environment variables (auto-detected)
 * const apiKey = getAuthApiKey();
 *
 * // From DaytonaSandboxOptions
 * const options: DaytonaSandboxOptions = {
 *   auth: { apiKey: "my-api-key" }
 * };
 * const apiKey = getAuthApiKey(options.auth);
 * ```
 */
export function getAuthApiKey(options?: DaytonaSandboxOptions["auth"]): string {
  // Priority 1: Explicit API key in options
  if (options?.apiKey) {
    return options.apiKey;
  }

  // Priority 2: DAYTONA_API_KEY environment variable
  const apiKey = process.env.DAYTONA_API_KEY;
  if (apiKey) {
    return apiKey;
  }

  // No API key found - throw descriptive error
  throw new Error(
    "Daytona authentication required. Provide an API key using one of these methods:\n\n" +
      "1. Set DAYTONA_API_KEY environment variable:\n" +
      "   Get your API key from https://app.daytona.io\n" +
      "   Run: export DAYTONA_API_KEY=your_api_key_here\n\n" +
      "2. Pass API key directly in options:\n" +
      "   new DaytonaSandbox({ auth: { apiKey: '...' } })",
  );
}

/**
 * Get the API URL for Daytona API.
 *
 * URL is resolved in the following priority order:
 *
 * 1. **Explicit API URL**: If `options.apiUrl` is provided, it is used directly.
 * 2. **DAYTONA_API_URL**: Environment variable for Daytona API URL.
 * 3. **Default**: Uses the default Daytona API URL.
 *
 * @param options - Optional authentication configuration from DaytonaSandboxOptions
 * @returns The API URL string
 */
export function getAuthApiUrl(options?: DaytonaSandboxOptions["auth"]): string {
  // Priority 1: Explicit API URL in options
  if (options?.apiUrl) {
    return options.apiUrl;
  }

  // Priority 2: DAYTONA_API_URL environment variable
  const apiUrl = process.env.DAYTONA_API_URL;
  if (apiUrl) {
    return apiUrl;
  }

  // Priority 3: Default URL
  return DEFAULT_API_URL;
}

/**
 * Get authentication credentials for Daytona API.
 *
 * This function returns the credentials needed for the Daytona SDK.
 *
 * @param options - Optional authentication configuration from DaytonaSandboxOptions
 * @param target - Optional target region
 * @returns Complete authentication credentials
 * @throws {Error} If no API key is available
 */
export function getAuthCredentials(
  options?: DaytonaSandboxOptions["auth"],
  target?: string,
): DaytonaCredentials {
  return {
    apiKey: getAuthApiKey(options),
    apiUrl: getAuthApiUrl(options),
    target: target ?? process.env.DAYTONA_TARGET,
  };
}
