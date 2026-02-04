/**
 * Type definitions for the Daytona Sandbox backend.
 *
 * This module contains all type definitions for the @langchain/daytona package,
 * including options and error types.
 */

/**
 * Supported target regions for Daytona sandboxes.
 *
 * - `us`: United States
 * - `eu`: Europe
 */
export type DaytonaSandboxTarget = "us" | "eu";

/**
 * Configuration options for creating a Daytona Sandbox.
 *
 * @example
 * ```typescript
 * const options: DaytonaSandboxOptions = {
 *   language: "typescript",
 *   timeout: 300, // 5 minutes
 *   target: "us",
 * };
 * ```
 */
export interface DaytonaSandboxOptions {
  /**
   * Primary language for code execution in the sandbox.
   *
   * Determines the runtime environment and code execution tooling.
   *
   * @default "typescript"
   */
  language?: "typescript" | "python" | "javascript";

  /**
   * Custom environment variables to set in the sandbox.
   *
   * These variables will be available to all commands and code executed
   * in the sandbox.
   *
   * @example
   * ```typescript
   * envVars: {
   *   NODE_ENV: "development",
   *   API_KEY: "secret"
   * }
   * ```
   */
  envVars?: Record<string, string>;

  /**
   * Resource allocation for the sandbox.
   *
   * When specifying resources, you must also specify an `image`.
   * Resources cannot be customized when using the default snapshot-based sandbox.
   *
   * @example
   * ```typescript
   * resources: { cpu: 2, memory: 4, disk: 20 }
   * ```
   */
  resources?: {
    /** Number of CPUs to allocate */
    cpu?: number;
    /** Amount of memory in GiB */
    memory?: number;
    /** Amount of disk space in GiB */
    disk?: number;
  };

  /**
   * Custom Docker image to use for the sandbox.
   *
   * When specified, creates a sandbox from this image instead of the default snapshot.
   * This is required when you want to customize resources.
   *
   * @example "node:20" or "python:3.12"
   */
  image?: string;

  /**
   * Snapshot name to use for the sandbox.
   *
   * When specified, creates a sandbox from this snapshot.
   * Cannot be used together with `image`.
   */
  snapshot?: string;

  /**
   * Target region where the sandbox will be created.
   *
   * @default "us"
   */
  target?: DaytonaSandboxTarget;

  /**
   * Auto-stop interval in minutes.
   *
   * The sandbox will automatically stop after being idle for this duration.
   * Set to 0 to disable auto-stop.
   *
   * @default 15
   */
  autoStopInterval?: number;

  /**
   * Default timeout for command execution in seconds.
   *
   * @default 300 (5 minutes)
   */
  timeout?: number;

  /**
   * Custom labels to attach to the sandbox.
   *
   * Labels can be used for organizing and filtering sandboxes.
   */
  labels?: Record<string, string>;

  /**
   * Authentication configuration for Daytona API.
   *
   * ### Environment Variable Setup
   *
   * ```bash
   * # Get your API key from https://app.daytona.io
   * export DAYTONA_API_KEY=your_api_key_here
   * ```
   *
   * Or pass the API key directly in this auth configuration.
   */
  auth?: {
    /**
     * Daytona API key.
     * If not provided, reads from `DAYTONA_API_KEY` environment variable.
     */
    apiKey?: string;

    /**
     * Daytona API URL.
     * If not provided, reads from `DAYTONA_API_URL` environment variable
     * or uses the default Daytona API URL.
     *
     * @default "https://app.daytona.io/api"
     */
    apiUrl?: string;
  };
}

/**
 * Error codes for Daytona Sandbox operations.
 *
 * Used to identify specific error conditions and handle them appropriately.
 */
export type DaytonaSandboxErrorCode =
  /** Sandbox has not been initialized - call initialize() first */
  | "NOT_INITIALIZED"
  /** Sandbox is already initialized - cannot initialize twice */
  | "ALREADY_INITIALIZED"
  /** Authentication failed - check API key configuration */
  | "AUTHENTICATION_FAILED"
  /** Failed to create sandbox - check options and quotas */
  | "SANDBOX_CREATION_FAILED"
  /** Sandbox not found - may have been deleted or expired */
  | "SANDBOX_NOT_FOUND"
  /** Sandbox is not in started state */
  | "SANDBOX_NOT_STARTED"
  /** Command execution timed out */
  | "COMMAND_TIMEOUT"
  /** Command execution failed */
  | "COMMAND_FAILED"
  /** File operation (read/write) failed */
  | "FILE_OPERATION_FAILED"
  /** Resource limits exceeded (CPU, memory, storage) */
  | "RESOURCE_LIMIT_EXCEEDED";

/**
 * Custom error class for Daytona Sandbox operations.
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
 *   if (error instanceof DaytonaSandboxError) {
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
export class DaytonaSandboxError extends Error {
  /** Error name for instanceof checks and logging */
  override readonly name = "DaytonaSandboxError";

  /**
   * Creates a new DaytonaSandboxError.
   *
   * @param message - Human-readable error description
   * @param code - Structured error code for programmatic handling
   * @param cause - Original error that caused this error (for debugging)
   */
  constructor(
    message: string,
    public readonly code: DaytonaSandboxErrorCode,
    public override readonly cause?: Error,
  ) {
    super(message);
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, DaytonaSandboxError.prototype);
  }
}
