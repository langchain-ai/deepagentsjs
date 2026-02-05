/**
 * Authentication utilities for Modal Sandbox.
 *
 * This module provides authentication credential resolution for the Modal SDK.
 *
 * @packageDocumentation
 */

import type { ModalSandboxOptions } from "./types.js";

/**
 * Authentication credentials for Modal API.
 */
export interface ModalCredentials {
  /** Modal token ID */
  tokenId: string;
  /** Modal token secret */
  tokenSecret: string;
}

/**
 * Get authentication credentials for Modal API.
 *
 * Credentials are resolved in the following priority order:
 *
 * 1. **Explicit options**: If `options.tokenId` and/or `options.tokenSecret` are provided,
 *    they are used directly.
 * 2. **Environment variables**: `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are used as fallbacks.
 *
 * ## Environment Variable Setup
 *
 * ```bash
 * # Go to https://modal.com/settings/tokens
 * # Create a new token and set the environment variables
 * export MODAL_TOKEN_ID=your_token_id
 * export MODAL_TOKEN_SECRET=your_token_secret
 * ```
 *
 * @param options - Optional authentication configuration from ModalSandboxOptions
 * @returns Complete authentication credentials
 * @throws {Error} If any credentials are missing
 *
 * @example
 * ```typescript
 * // With explicit credentials
 * const creds = getAuthCredentials({ tokenId: "...", tokenSecret: "..." });
 *
 * // Using environment variables (auto-detected)
 * const creds = getAuthCredentials();
 *
 * // From ModalSandboxOptions
 * const options: ModalSandboxOptions = {
 *   auth: { tokenId: "...", tokenSecret: "..." }
 * };
 * const creds = getAuthCredentials(options.auth);
 * ```
 */
export function getAuthCredentials(
  options?: ModalSandboxOptions["auth"],
): ModalCredentials {
  // Resolve token ID: explicit option first, then environment variable
  const tokenId = options?.tokenId || process.env.MODAL_TOKEN_ID;

  // Resolve token secret: explicit option first, then environment variable
  const tokenSecret = options?.tokenSecret || process.env.MODAL_TOKEN_SECRET;

  // Check what's missing and build appropriate error message
  const missingTokenId = !tokenId;
  const missingTokenSecret = !tokenSecret;

  if (missingTokenId || missingTokenSecret) {
    const missing: string[] = [];
    if (missingTokenId) missing.push("MODAL_TOKEN_ID");
    if (missingTokenSecret) missing.push("MODAL_TOKEN_SECRET");

    throw new Error(
      `Modal authentication required. Missing: ${missing.join(", ")}.\n\n` +
        "Provide credentials using one of these methods:\n\n" +
        "1. Set environment variables:\n" +
        "   Go to https://modal.com/settings/tokens\n" +
        "   Create a new token and run:\n" +
        "   export MODAL_TOKEN_ID=your_token_id\n" +
        "   export MODAL_TOKEN_SECRET=your_token_secret\n\n" +
        "2. Pass credentials directly in options:\n" +
        "   new ModalSandbox({ auth: { tokenId: '...', tokenSecret: '...' } })",
    );
  }

  return { tokenId, tokenSecret };
}
