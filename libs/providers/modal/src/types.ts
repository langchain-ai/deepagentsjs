/**
 * Type definitions for the Modal Sandbox backend.
 *
 * This module contains all type definitions for the @langchain/modal package,
 * including options and error types.
 */

import type { SandboxCreateParams } from "modal";
import { type SandboxErrorCode, SandboxError } from "deepagents";

/**
 * Fields from SandboxCreateParams that we wrap with a different API:
 * - `volumes` -> we accept volume names (strings), SDK needs Volume objects
 * - `secrets` -> we accept secret names (strings), SDK needs Secret objects
 *
 * Fields not exposed yet:
 * - `cloudBucketMounts`, `proxy`, `experimentalOptions`, `customDomain`
 * - `command`, `pty`, `encryptedPorts`, `h2Ports`, `unencryptedPorts`, `cloud`
 */
type WrappedSdkFields =
  | "secrets"
  | "volumes"
  | "cloudBucketMounts"
  | "proxy"
  | "experimentalOptions"
  | "customDomain"
  | "command"
  | "pty"
  | "encryptedPorts"
  | "h2Ports"
  | "unencryptedPorts"
  | "cloud";

/**
 * SDK options that pass through directly.
 */
type BaseSdkOptions = Omit<SandboxCreateParams, WrappedSdkFields>;

/**
 * Configuration options for creating a Modal Sandbox.
 *
 * Extends the Modal SDK's SandboxCreateParams with additional options
 * for app/image configuration and a simplified volumes/secrets API.
 *
 * @example
 * ```typescript
 * const options: ModalSandboxOptions = {
 *   appName: "my-sandbox-app",
 *   imageName: "python:3.12-slim",
 *   timeoutMs: 600_000, // 10 minutes
 *   memoryMiB: 2048, // 2GB
 *   initialFiles: {
 *     "/app/index.js": "console.log('Hello')",
 *   },
 * };
 * ```
 */
export interface ModalSandboxOptions extends BaseSdkOptions {
  /**
   * Name of the Modal App to associate the sandbox with.
   * If not provided, a default app name will be used.
   * The app will be created if it doesn't exist.
   *
   * @default "deepagents-sandbox"
   */
  appName?: string;

  /**
   * Docker image to use for the sandbox container.
   * Can be any public Docker image or a Modal Image reference.
   *
   * @default "alpine:3.21"
   *
   * @example
   * ```typescript
   * // Use Python image
   * imageName: "python:3.12-slim"
   *
   * // Use Node.js image
   * imageName: "node:20-slim"
   * ```
   */
  imageName?: string;

  /**
   * Modal Volume names to mount, mapped to their mount paths.
   * Volumes must be created beforehand in Modal.
   *
   * Unlike the SDK which requires Volume objects, we accept volume names
   * and look them up automatically.
   *
   * @example
   * ```typescript
   * volumes: {
   *   "/data": "my-data-volume",
   *   "/cache": "my-cache-volume"
   * }
   * ```
   */
  volumes?: Record<string, string>;

  /**
   * Modal Secret names to inject into the sandbox environment.
   * Secrets must be created beforehand in Modal.
   *
   * Unlike the SDK which requires Secret objects, we accept secret names
   * and look them up automatically.
   *
   * @example
   * ```typescript
   * secrets: ["my-api-keys", "database-credentials"]
   * ```
   */
  secrets?: string[];

  /**
   * Initial files to populate the sandbox with.
   *
   * Keys are file paths (relative to the working directory), values are file contents.
   * Parent directories will be created automatically if they don't exist.
   *
   * @example
   * ```typescript
   * initialFiles: {
   *   "/src/index.js": "console.log('Hello')",
   *   "/package.json": '{"name": "my-app"}',
   * }
   * ```
   */
  initialFiles?: Record<string, string | Uint8Array>;

  /**
   * Authentication configuration for Modal API.
   *
   * ### Environment Variable Setup
   *
   * ```bash
   * # Create a token at https://modal.com/settings/tokens
   * export MODAL_TOKEN_ID=your_token_id
   * export MODAL_TOKEN_SECRET=your_token_secret
   * ```
   *
   * Or pass the credentials directly in this auth configuration.
   */
  auth?: {
    /**
     * Modal token ID.
     * If not provided, reads from `MODAL_TOKEN_ID` environment variable.
     */
    tokenId?: string;

    /**
     * Modal token secret.
     * If not provided, reads from `MODAL_TOKEN_SECRET` environment variable.
     */
    tokenSecret?: string;
  };
}

/**
 * Error codes for Modal Sandbox operations.
 *
 * Used to identify specific error conditions and handle them appropriately.
 */
export type ModalSandboxErrorCode =
  | SandboxErrorCode
  /** Authentication failed - check token configuration */
  | "AUTHENTICATION_FAILED"
  /** Failed to create sandbox - check options and quotas */
  | "SANDBOX_CREATION_FAILED"
  /** Sandbox not found - may have been stopped or expired */
  | "SANDBOX_NOT_FOUND"
  /** Resource limits exceeded (CPU, memory, storage) */
  | "RESOURCE_LIMIT_EXCEEDED"
  /** Volume operation failed */
  | "VOLUME_ERROR";

const MODAL_SANDBOX_ERROR_SYMBOL = Symbol.for("modal.sandbox.error");

/**
 * Custom error class for Modal Sandbox operations.
 *
 * Provides structured error information including:
 * - Human-readable message
 * - Error code for programmatic handling
 * - Original cause for debugging
 *
 * @example
 * ```typescript
 * try {
 *   await sandbox.execute("some command");
 * } catch (error) {
 *   if (error instanceof ModalSandboxError) {
 *     switch (error.code) {
 *       case "NOT_INITIALIZED":
 *         await sandbox.initialize();
 *         break;
 *       case "COMMAND_TIMEOUT":
 *         console.error("Command took too long");
 *         break;
 *       default:
 *         throw error;
 *     }
 *   }
 * }
 * ```
 */
export class ModalSandboxError extends SandboxError {
  [MODAL_SANDBOX_ERROR_SYMBOL]: true;

  /** Error name for instanceof checks and logging */
  override readonly name = "ModalSandboxError";

  /**
   * Creates a new ModalSandboxError.
   *
   * @param message - Human-readable error description
   * @param code - Structured error code for programmatic handling
   * @param cause - Original error that caused this error (for debugging)
   */
  constructor(
    message: string,
    public readonly code: ModalSandboxErrorCode,
    public override readonly cause?: Error,
  ) {
    super(message, code as SandboxErrorCode, cause);
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, ModalSandboxError.prototype);
  }

  /**
   * Checks if the error is an instance of ModalSandboxError.
   *
   * @param error - The error to check
   * @returns True if the error is an instance of ModalSandboxError, false otherwise
   */
  static isInstance(error: unknown): error is ModalSandboxError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[MODAL_SANDBOX_ERROR_SYMBOL] === true
    );
  }
}
