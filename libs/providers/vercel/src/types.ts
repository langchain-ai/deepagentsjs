/**
 * Type definitions for the Vercel Sandbox backend.
 */

import type { Sandbox } from "@vercel/sandbox";
import { type SandboxErrorCode, SandboxError } from "deepagents";

type VercelCreateOptions = NonNullable<Parameters<typeof Sandbox.create>[0]>;

/**
 * Options for creating or wrapping a Vercel Sandbox backend.
 *
 * All `@vercel/sandbox` `Sandbox.create()` options pass through directly.
 */
export type VercelSandboxOptions = VercelCreateOptions & {
  /**
   * Existing SDK sandbox to wrap instead of creating a new one.
   */
  sandbox?: Sandbox;

  /**
   * Default command timeout in milliseconds.
   *
   * A value of `0` waits indefinitely. Negative values are rejected.
   *
   * @default 1800000
   */
  commandTimeoutMs?: number;

  /**
   * Files to upload after initialization.
   *
   * Relative paths are resolved against the sandbox's working directory.
   */
  initialFiles?: Record<string, string | Uint8Array>;
};

/**
 * Error codes for Vercel Sandbox operations.
 */
export type VercelSandboxErrorCode =
  | SandboxErrorCode
  | "SANDBOX_CREATION_FAILED"
  | "SANDBOX_NOT_FOUND"
  | "INVALID_OPTIONS";

const VERCEL_SANDBOX_ERROR_SYMBOL = Symbol.for("vercel.sandbox.error");

/**
 * Custom error class for Vercel Sandbox operations.
 */
export class VercelSandboxError extends SandboxError {
  [VERCEL_SANDBOX_ERROR_SYMBOL] = true as const;

  override readonly name = "VercelSandboxError";

  constructor(
    message: string,
    public readonly code: VercelSandboxErrorCode,
    public override readonly cause?: Error,
  ) {
    super(message, code as SandboxErrorCode, cause);
    Object.setPrototypeOf(this, VercelSandboxError.prototype);
  }

  static isInstance(error: unknown): error is VercelSandboxError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[VERCEL_SANDBOX_ERROR_SYMBOL] === true
    );
  }
}
