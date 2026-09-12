/**
 * Type definitions for the Sprites Sandbox backend.
 *
 * This module contains all type definitions for the @langchain/sprites
 * package, including options and error types.
 */

import { type SandboxErrorCode, SandboxError } from "deepagents";

/**
 * Machine sizing for a Sprite.
 *
 * All fields are optional; the Sprites API applies sensible defaults.
 */
export interface SpritesSandboxConfig {
  /** RAM in megabytes */
  ramMB?: number;

  /** Number of CPUs */
  cpus?: number;

  /** Region to deploy the Sprite (e.g. "ord", "iad") */
  region?: string;

  /** Storage in gigabytes */
  storageGB?: number;
}

/**
 * Configuration options for creating a Sprites Sandbox.
 *
 * @example
 * ```typescript
 * const options: SpritesSandboxOptions = {
 *   name: "my-agent-sandbox",
 *   timeout: 300, // 5 minutes
 *   config: { ramMB: 2048, cpus: 2 },
 * };
 * ```
 */
export interface SpritesSandboxOptions {
  /**
   * Name for the Sprite.
   *
   * Sprites are named, persistent VMs: the name is the sandbox's identity
   * and can be used later to reconnect with `SpritesSandbox.fromName()`.
   *
   * @default A generated name like `deepagents-<random>`
   */
  name?: string;

  /**
   * Machine sizing (RAM, CPUs, region, storage).
   */
  config?: SpritesSandboxConfig;

  /**
   * Custom environment variables to set in the Sprite.
   *
   * These variables will be available to all commands executed in the
   * sandbox.
   *
   * @example
   * ```typescript
   * environment: {
   *   NODE_ENV: "development",
   * }
   * ```
   */
  environment?: Record<string, string>;

  /**
   * Labels to attach to the Sprite, for organizing and filtering.
   */
  labels?: string[];

  /**
   * Runtime image variant.
   *
   * @default "default"
   */
  runtime?: "default" | "dev";

  /**
   * Wait for capacity instead of failing immediately when the
   * organization is at its concurrent-Sprite limit.
   */
  waitForCapacity?: boolean;

  /**
   * Default timeout for command execution in seconds.
   *
   * @default 300 (5 minutes)
   */
  timeout?: number;

  /**
   * Working directory for command execution and relative file paths.
   *
   * @default "/home/sprite"
   */
  workdir?: string;

  /**
   * Initial files to create in the Sprite after initialization.
   *
   * A map of file paths to their contents. Files will be created in the
   * sandbox filesystem before any commands are executed. Parent
   * directories are created automatically. Relative paths are resolved
   * against `workdir`.
   *
   * @example
   * ```typescript
   * const options: SpritesSandboxOptions = {
   *   initialFiles: {
   *     "index.js": "console.log('Hello')",
   *     "package.json": '{"name": "test"}',
   *   },
   * };
   * ```
   */
  initialFiles?: Record<string, string>;

  /**
   * Authentication configuration for the Sprites API.
   *
   * ### Environment Variable Setup
   *
   * ```bash
   * # Create a token with: sprite tokens create
   * export SPRITES_TOKEN=your_token_here
   * ```
   *
   * Or pass the token directly in this auth configuration.
   */
  auth?: {
    /**
     * Sprites API token.
     * If not provided, reads from the `SPRITES_TOKEN` environment variable.
     */
    token?: string;

    /**
     * Sprites API base URL.
     * If not provided, reads from the `SPRITES_API_URL` environment
     * variable or uses the default.
     *
     * @default "https://api.sprites.dev"
     */
    baseURL?: string;
  };
}

/**
 * Error codes for Sprites Sandbox operations.
 *
 * Used to identify specific error conditions and handle them appropriately.
 */
export type SpritesSandboxErrorCode =
  | SandboxErrorCode
  /** Authentication failed - check token configuration */
  | "AUTHENTICATION_FAILED"
  /** Failed to create sandbox - check options and quotas */
  | "SANDBOX_CREATION_FAILED"
  /** Sandbox not found - may have been deleted */
  | "SANDBOX_NOT_FOUND"
  /** File upload/download failed */
  | "FILE_OPERATION_FAILED"
  /** Checkpoint or restore operation failed */
  | "CHECKPOINT_FAILED";

const SPRITES_SANDBOX_ERROR_SYMBOL = Symbol.for("sprites.sandbox.error");

/**
 * Custom error class for Sprites Sandbox operations.
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
 *   if (SpritesSandboxError.isInstance(error)) {
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
export class SpritesSandboxError extends SandboxError {
  /** Symbol for identifying sandbox error instances */
  [SPRITES_SANDBOX_ERROR_SYMBOL] = true as const;

  /** Error name for instanceof checks and logging */
  override readonly name = "SpritesSandboxError";

  /**
   * Creates a new SpritesSandboxError.
   *
   * @param message - Human-readable error description
   * @param code - Structured error code for programmatic handling
   * @param cause - Original error that caused this error (for debugging)
   */
  constructor(
    message: string,
    public readonly code: SpritesSandboxErrorCode,
    public override readonly cause?: Error,
  ) {
    super(message, code as SandboxErrorCode, cause);
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, SpritesSandboxError.prototype);
  }

  /**
   * Checks if the error is an instance of SpritesSandboxError.
   *
   * @param error - The error to check
   * @returns True if the error is an instance of SpritesSandboxError
   */
  static isInstance(error: unknown): error is SpritesSandboxError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[SPRITES_SANDBOX_ERROR_SYMBOL] === true
    );
  }
}
