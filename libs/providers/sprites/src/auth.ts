/**
 * Authentication utilities for the Sprites Sandbox.
 *
 * This module provides authentication credential resolution for the Sprites
 * SDK.
 *
 * @packageDocumentation
 */

import type { SpritesSandboxOptions } from "./types.js";

/**
 * Authentication credentials for the Sprites API.
 */
export interface SpritesCredentials {
  /** Sprites API token */
  token: string;

  /** Sprites API base URL */
  baseURL: string;
}

/** Default Sprites API URL */
const DEFAULT_BASE_URL = "https://api.sprites.dev";

/**
 * Get the API token for the Sprites API.
 *
 * Authentication is resolved in the following priority order:
 *
 * 1. **Explicit token**: If `options.token` is provided, it is used directly.
 * 2. **SPRITES_TOKEN**: Environment variable for the Sprites API token.
 *
 * If no token is found, an error is thrown with setup instructions.
 *
 * ## Environment Variable Setup
 *
 * ```bash
 * # Create a token with the Sprites CLI: sprite tokens create
 * export SPRITES_TOKEN=your_token_here
 * ```
 *
 * @param options - Optional authentication configuration from SpritesSandboxOptions
 * @returns The API token string
 * @throws {Error} If no token is available
 *
 * @example
 * ```typescript
 * // With explicit token
 * const token = getAuthToken({ token: "my-token" });
 *
 * // Using environment variables (auto-detected)
 * const token = getAuthToken();
 * ```
 */
export function getAuthToken(options?: SpritesSandboxOptions["auth"]): string {
  // Priority 1: Explicit token in options
  if (options?.token) {
    return options.token;
  }

  // Priority 2: SPRITES_TOKEN environment variable
  const token = process.env.SPRITES_TOKEN;
  if (token) {
    return token;
  }

  // No token found - throw descriptive error
  throw new Error(
    "Sprites authentication required. Provide a token using one of these methods:\n\n" +
      "1. Set the SPRITES_TOKEN environment variable:\n" +
      "   Create a token with the Sprites CLI (https://docs.sprites.dev):\n" +
      "   sprite tokens create\n" +
      "   export SPRITES_TOKEN=your_token_here\n\n" +
      "2. Pass the token directly in options:\n" +
      "   new SpritesSandbox({ auth: { token: '...' } })",
  );
}

/**
 * Get the base URL for the Sprites API.
 *
 * URL is resolved in the following priority order:
 *
 * 1. **Explicit base URL**: If `options.baseURL` is provided, it is used directly.
 * 2. **SPRITES_API_URL**: Environment variable for the Sprites API URL.
 * 3. **Default**: `https://api.sprites.dev`.
 *
 * @param options - Optional authentication configuration from SpritesSandboxOptions
 * @returns The base URL string
 */
export function getAuthBaseURL(
  options?: SpritesSandboxOptions["auth"],
): string {
  // Priority 1: Explicit base URL in options
  if (options?.baseURL) {
    return options.baseURL;
  }

  // Priority 2: SPRITES_API_URL environment variable
  const baseURL = process.env.SPRITES_API_URL;
  if (baseURL) {
    return baseURL;
  }

  // Priority 3: Default URL
  return DEFAULT_BASE_URL;
}

/**
 * Get authentication credentials for the Sprites API.
 *
 * This function returns the credentials needed for the Sprites SDK.
 *
 * @param options - Optional authentication configuration from SpritesSandboxOptions
 * @returns Complete authentication credentials
 * @throws {Error} If no token is available
 */
export function getAuthCredentials(
  options?: SpritesSandboxOptions["auth"],
): SpritesCredentials {
  return {
    token: getAuthToken(options),
    baseURL: getAuthBaseURL(options),
  };
}
