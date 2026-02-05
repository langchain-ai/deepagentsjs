/**
 * Type definitions for the Deno Sandbox backend.
 *
 * This module contains all type definitions for the @langchain/deno package,
 * including options and error types.
 */

/**
 * Supported regions for Deno Deploy sandboxes.
 *
 * Currently available regions:
 * - `ams`: Amsterdam
 * - `ord`: Chicago
 */
export type DenoSandboxRegion = "ams" | "ord";

/**
 * Sandbox lifetime configuration.
 *
 * - `"session"`: Sandbox shuts down when you close/dispose the client (default)
 * - Duration string: Keep sandbox alive for a specific time (e.g., "5m", "30s")
 */
export type SandboxLifetime = "session" | `${number}s` | `${number}m`;

/**
 * Configuration options for creating a Deno Sandbox.
 *
 * @example
 * ```typescript
 * const options: DenoSandboxOptions = {
 *   memoryMb: 1024, // 1GB memory
 *   lifetime: "5m", // 5 minutes
 *   region: "iad", // US East
 * };
 * ```
 */
export interface DenoSandboxOptions {
  /**
   * Amount of memory allocated to the sandbox in megabytes.
   *
   * Memory limits:
   * - Minimum: 768MB
   * - Maximum: 4096MB
   *
   * @default 768
   */
  memoryMb?: number;

  /**
   * Sandbox lifetime configuration.
   *
   * - `"session"`: Sandbox shuts down when you close/dispose the client (default)
   * - Duration string: Keep sandbox alive for a specific time (e.g., "5m", "30s")
   *
   * Supported duration suffixes: `s` (seconds), `m` (minutes).
   *
   * @default "session"
   */
  lifetime?: SandboxLifetime;

  /**
   * Region where the sandbox will be created.
   *
   * If not specified, the sandbox will be created in the default region.
   *
   * @see DenoSandboxRegion for available regions
   */
  region?: DenoSandboxRegion;

  /**
   * Initial files to create in the sandbox after initialization.
   *
   * A map of file paths to their contents. Files will be created
   * in the sandbox filesystem before any commands are executed.
   * Parent directories are created automatically.
   *
   * @example
   * ```typescript
   * const options: DenoSandboxOptions = {
   *   memoryMb: 1024,
   *   initialFiles: {
   *     "/home/app/index.js": "console.log('Hello')",
   *     "/home/app/package.json": '{"name": "test"}',
   *   },
   * };
   * ```
   */
  initialFiles?: Record<string, string>;

  /**
   * Authentication configuration for Deno Deploy API.
   *
   * ### Environment Variable Setup
   *
   * ```bash
   * # Go to https://app.deno.com -> Settings -> Organization Tokens
   * # Create a new token and set it as environment variable
   * export DENO_DEPLOY_TOKEN=your_token_here
   * ```
   *
   * Or pass the token directly in this auth configuration.
   */
  auth?: {
    /**
     * Deno Deploy access token.
     * If not provided, reads from `DENO_DEPLOY_TOKEN` environment variable.
     */
    token?: string;
  };
}

/**
 * Error codes for Deno Sandbox operations.
 *
 * Used to identify specific error conditions and handle them appropriately.
 */
export type DenoSandboxErrorCode =
  /** Sandbox has not been initialized - call initialize() first */
  | "NOT_INITIALIZED"
  /** Sandbox is already initialized - cannot initialize twice */
  | "ALREADY_INITIALIZED"
  /** Authentication failed - check token configuration */
  | "AUTHENTICATION_FAILED"
  /** Failed to create sandbox - check options and quotas */
  | "SANDBOX_CREATION_FAILED"
  /** Sandbox not found - may have been stopped or expired */
  | "SANDBOX_NOT_FOUND"
  /** Command execution timed out */
  | "COMMAND_TIMEOUT"
  /** Command execution failed */
  | "COMMAND_FAILED"
  /** File operation (read/write) failed */
  | "FILE_OPERATION_FAILED"
  /** Resource limits exceeded (CPU, memory, storage) */
  | "RESOURCE_LIMIT_EXCEEDED";

const DENO_SANDBOX_ERROR_SYMBOL = Symbol.for("deno.sandbox.error");

/**
 * Custom error class for Deno Sandbox operations.
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
 *   if (error instanceof DenoSandboxError) {
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
export class DenoSandboxError extends Error {
  [DENO_SANDBOX_ERROR_SYMBOL]: true;

  /** Error name for instanceof checks and logging */
  override readonly name = "DenoSandboxError";

  /**
   * Creates a new DenoSandboxError.
   *
   * @param message - Human-readable error description
   * @param code - Structured error code for programmatic handling
   * @param cause - Original error that caused this error (for debugging)
   */
  constructor(
    message: string,
    public readonly code: DenoSandboxErrorCode,
    public override readonly cause?: Error,
  ) {
    super(message);
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, DenoSandboxError.prototype);
  }

  /**
   * Checks if the error is an instance of DenoSandboxError.
   *
   * @param error - The error to check
   * @returns True if the error is an instance of DenoSandboxError, false otherwise
   */
  static isInstance(error: unknown): error is DenoSandboxError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[DENO_SANDBOX_ERROR_SYMBOL] === true
    );
  }
}
