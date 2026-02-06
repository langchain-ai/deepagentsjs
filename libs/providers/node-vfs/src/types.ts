/**
 * Type definitions for the Node.js VFS backend.
 *
 * This module contains all type definitions for the @langchain/node-vfs package,
 * including options and error types.
 */

import { SandboxError, type SandboxErrorCode } from "deepagents";

/**
 * Configuration options for creating a VFS Sandbox.
 *
 * @example
 * ```typescript
 * const options: VfsSandboxOptions = {
 *   mountPath: "/vfs",
 *   initialFiles: {
 *     "/app/index.js": "console.log('Hello')",
 *     "/app/package.json": '{"name": "test"}',
 *   },
 * };
 * ```
 */
export interface VfsSandboxOptions {
  /**
   * The mount path for the virtual file system.
   *
   * After mounting, files in the VFS will be accessible under this path
   * using the standard `fs` module.
   *
   * @default "/vfs"
   */
  mountPath?: string;

  /**
   * Initial files to populate the virtual file system.
   *
   * Keys are file paths (relative to the VFS root), values are file contents.
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
   * Command timeout in milliseconds.
   *
   * @default 30000 (30 seconds)
   */
  timeout?: number;
}

/**
 * Error codes for VFS Sandbox operations.
 */
export type VfsSandboxErrorCode =
  | SandboxErrorCode
  /** VFS initialization failed */
  | "INITIALIZATION_FAILED"
  /** VFS is not supported in this environment */
  | "NOT_SUPPORTED";

const VFS_SANDBOX_ERROR_SYMBOL = Symbol.for("vfs.sandbox.error");

/**
 * Custom error class for VFS Sandbox operations.
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
 *   if (error instanceof VfsSandboxError) {
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
export class VfsSandboxError extends SandboxError {
  [VFS_SANDBOX_ERROR_SYMBOL] = true as const;

  /** Error name for instanceof checks and logging */
  override readonly name = "VfsSandboxError";

  /**
   * Creates a new VfsSandboxError.
   *
   * @param message - Human-readable error description
   * @param code - Structured error code for programmatic handling
   * @param cause - Original error that caused this error (for debugging)
   */
  constructor(
    message: string,
    public readonly code: VfsSandboxErrorCode,
    public readonly cause?: Error,
  ) {
    super(message, code as SandboxErrorCode, cause);
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, VfsSandboxError.prototype);
  }

  /**
   * Checks if the error is an instance of VfsSandboxError.
   *
   * @param error - The error to check
   * @returns True if the error is an instance of VfsSandboxError, false otherwise
   */
  static isInstance(error: unknown): error is VfsSandboxError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[VFS_SANDBOX_ERROR_SYMBOL] === true
    );
  }
}
