/**
 * Authentication utilities for Vercel Sandbox.
 *
 * This module provides authentication credential resolution for the Vercel Sandbox SDK.
 * It supports multiple authentication methods with a defined priority order.
 *
 * @packageDocumentation
 */

import type { VercelSandboxOptions } from "./types.js";

/**
 * Authentication credentials for Vercel Sandbox API.
 */
export interface VercelCredentials {
  /** Authentication token (OIDC or access token) */
  token: string;
  /** Team ID (required for access token auth, optional for OIDC) */
  teamId?: string;
  /** Project ID (required for access token auth, optional for OIDC) */
  projectId?: string;
}

/**
 * Get the authentication token for Vercel Sandbox API.
 *
 * Authentication is resolved in the following priority order:
 *
 * 1. **Explicit token**: If `options.token` is provided, it is used directly.
 * 2. **VERCEL_OIDC_TOKEN**: Environment variable set by Vercel during deployment
 *    or via `vercel link && vercel env pull`.
 * 3. **VERCEL_TOKEN**: Personal access token from Vercel dashboard.
 *
 * If no token is found, an error is thrown with setup instructions.
 *
 * ## Environment Variable Setup
 *
 * ### Option 1: Vercel OIDC Token (Recommended for local development)
 *
 * ```bash
 * # Link your project to Vercel
 * vercel link
 *
 * # Pull environment variables (creates .env.local)
 * vercel env pull
 *
 * # The VERCEL_OIDC_TOKEN will be automatically set
 * ```
 *
 * ### Option 2: Access Token (For CI/CD or external environments)
 *
 * ```bash
 * # Generate a token at https://vercel.com/account/tokens
 * # Get your team ID from team settings
 * # Get your project ID from project settings
 * export VERCEL_TOKEN=your_token_here
 * export VERCEL_TEAM_ID=your_team_id
 * export VERCEL_PROJECT_ID=your_project_id
 * ```
 *
 * @param options - Optional authentication configuration from VercelSandboxOptions
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
 * // From VercelSandboxOptions
 * const options: VercelSandboxOptions = {
 *   auth: { type: "oidc", token: "my-oidc-token" }
 * };
 * const token = getAuthToken(options.auth);
 * ```
 */
export function getAuthToken(options?: VercelSandboxOptions["auth"]): string {
  // Priority 1: Explicit token in options
  if (options?.token) {
    return options.token;
  }

  // Priority 2: VERCEL_OIDC_TOKEN environment variable
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  if (oidcToken) {
    return oidcToken;
  }

  // Priority 3: VERCEL_TOKEN environment variable (fallback)
  const accessToken = process.env.VERCEL_TOKEN;
  if (accessToken) {
    return accessToken;
  }

  // No token found - throw descriptive error
  throw new Error(
    "Vercel authentication required. Provide a token using one of these methods:\n\n" +
      "1. Set up OIDC token (recommended for local development):\n" +
      "   Run `vercel link && vercel env pull` to set up automatically.\n\n" +
      "2. Set access token with team/project IDs (for CI/CD):\n" +
      "   - VERCEL_TOKEN: Generate at https://vercel.com/account/tokens\n" +
      "   - VERCEL_TEAM_ID: From your team settings\n" +
      "   - VERCEL_PROJECT_ID: From your project settings\n\n" +
      "3. Pass credentials directly in options:\n" +
      "   new VercelSandbox({ auth: { type: 'access_token', token: '...', teamId: '...', projectId: '...' } })",
  );
}

/**
 * Get all authentication credentials for Vercel Sandbox API.
 *
 * This function returns the complete set of credentials needed for the Vercel SDK,
 * including token, teamId, and projectId when using access token authentication.
 *
 * @param options - Optional authentication configuration from VercelSandboxOptions
 * @returns Complete authentication credentials
 * @throws {Error} If no authentication token is available
 */
export function getAuthCredentials(
  options?: VercelSandboxOptions["auth"],
): VercelCredentials {
  const token = getAuthToken(options);

  // Get teamId: explicit option > environment variable
  const teamId = options?.teamId ?? process.env.VERCEL_TEAM_ID;

  // Get projectId: explicit option > environment variable
  const projectId = options?.projectId ?? process.env.VERCEL_PROJECT_ID;

  return {
    token,
    teamId,
    projectId,
  };
}
