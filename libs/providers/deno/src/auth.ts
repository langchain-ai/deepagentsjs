/**
 * Authentication utilities for Deno Sandbox.
 *
 * This module provides authentication credential resolution for the Deno Sandbox SDK.
 *
 * @packageDocumentation
 */

import type { DenoSandboxOptions } from "./types.js";

/**
 * Authentication credentials for Deno Sandbox API.
 */
export interface DenoCredentials {
  /** Deno Deploy access token */
  token: string;
}

/**
 * Get the authentication token for Deno Sandbox API.
 *
 * Authentication is resolved in the following priority order:
 *
 * 1. **Explicit token**: If `options.token` is provided, it is used directly.
 * 2. **DENO_DEPLOY_TOKEN**: Environment variable for Deno Deploy access token.
 *
 * If no token is found, an error is thrown with setup instructions.
 *
 * ## Environment Variable Setup
 *
 * ```bash
 * # Go to https://app.deno.com -> Settings -> Organization Tokens
 * # Create a new token and set it as environment variable
 * export DENO_DEPLOY_TOKEN=your_token_here
 * ```
 *
 * @param options - Optional authentication configuration from DenoSandboxOptions
 * @returns The authentication token string
 * @throws {Error} If no authentication token is available
 *
 * @example
 * ```typescript
 * // With explicit token
 * const token = getAuthToken({ token: "my-token" });
 *
 * // Using environment variables (auto-detected)
 * const token = getAuthToken();
 *
 * // From DenoSandboxOptions
 * const options: DenoSandboxOptions = {
 *   auth: { token: "my-token" }
 * };
 * const token = getAuthToken(options.auth);
 * ```
 */
export function getAuthToken(options?: DenoSandboxOptions["auth"]): string {
  // Priority 1: Explicit token in options
  if (options?.token) {
    return options.token;
  }

  // Priority 2: DENO_DEPLOY_TOKEN environment variable
  const deployToken = process.env.DENO_DEPLOY_TOKEN;
  if (deployToken) {
    return deployToken;
  }

  // No token found - throw descriptive error
  throw new Error(
    "Deno Deploy authentication required. Provide a token using one of these methods:\n\n" +
      "1. Set DENO_DEPLOY_TOKEN environment variable:\n" +
      "   Go to https://app.deno.com -> Settings -> Organization Tokens\n" +
      "   Create a new token and run: export DENO_DEPLOY_TOKEN=your_token_here\n\n" +
      "2. Pass token directly in options:\n" +
      "   new DenoSandbox({ auth: { token: '...' } })",
  );
}

/**
 * Get authentication credentials for Deno Sandbox API.
 *
 * This function returns the credentials needed for the Deno SDK.
 *
 * @param options - Optional authentication configuration from DenoSandboxOptions
 * @returns Complete authentication credentials
 * @throws {Error} If no authentication token is available
 */
export function getAuthCredentials(
  options?: DenoSandboxOptions["auth"],
): DenoCredentials {
  return {
    token: getAuthToken(options),
  };
}
