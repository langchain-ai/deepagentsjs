/**
 * Type definitions for the Deno Sandbox backend.
 *
 * This module contains all type definitions for the @langchain/deno package,
 * including options and error types.
 */

import type {
  Memory,
  Region,
  SecretConfig,
  SnapshotId,
  SnapshotSlug,
  VolumeId,
  VolumeSlug,
} from "@deno/sandbox";
import { type SandboxErrorCode, SandboxError } from "deepagents";

/**
 * Supported regions for Deno Deploy sandboxes.
 *
 * Currently available regions:
 * - `ams`: Amsterdam
 * - `ord`: Chicago
 */
export type DenoSandboxRegion = Region;

/**
 * Sandbox lifetime configuration.
 *
 * @deprecated Use {@link SandboxTimeout} instead. This type will be removed in a future release.
 *
 * - `"session"`: Sandbox shuts down when you close/dispose the client (default)
 * - Duration string: Keep sandbox alive for a specific time (e.g., "5m", "30s")
 */
export type SandboxLifetime = "session" | `${number}s` | `${number}m`;

/**
 * Sandbox timeout configuration.
 *
 * - `"session"`: Sandbox shuts down when the primary client disconnects (default)
 * - Duration string: Keep sandbox alive for a specific time (e.g., "600s", "20m")
 *
 * Note: when using a duration, the sandbox will be terminated after the specified
 * time even if clients are still connected.
 */
export type SandboxTimeout = "session" | `${number}s` | `${number}m`;

/**
 * Configuration options for creating a Deno Sandbox.
 *
 * @example
 * ```typescript
 * const options: DenoSandboxOptions = {
 *   memory: "1GiB", // 1GB memory
 *   timeout: "5m", // 5 minutes
 *   region: "ord", // Chicago
 * };
 * ```
 */
export interface DenoSandboxOptions {
  /**
   * Amount of memory allocated to the sandbox in megabytes.
   *
   * @deprecated Use {@link DenoSandboxOptions.memory} instead. This option will be removed in a future release.
   *
   * Memory limits:
   * - Minimum: 768MB
   * - Maximum: 4096MB
   *
   * @default 768
   */
  memoryMb?: number;

  /**
   * The memory size of the sandbox. Supports plain numbers (interpreted as bytes)
   * and human-readable strings with binary (GiB, MiB, KiB) or decimal (GB, MB, kB)
   * units.
   *
   * Takes precedence over the deprecated `memoryMb` option.
   *
   * @example 1342177280
   * @example "1GiB"
   * @example "1280MiB"
   * @default "1280MiB"
   */
  memory?: Memory;

  /**
   * Sandbox lifetime configuration.
   *
   * @deprecated Use {@link DenoSandboxOptions.timeout} instead. This option will be removed in a future release.
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
   * The timeout of the sandbox. When not specified, it defaults to `"session"`.
   *
   * Takes precedence over the deprecated `lifetime` option.
   *
   * - `"session"`: Sandbox is destroyed when the primary client disconnects.
   * - Duration string: Keep sandbox alive for a specific time (e.g., "600s", "20m").
   *   Note that when this duration has passed, the sandbox will be terminated even
   *   if there are still clients connected to it.
   *
   * @example "session"
   * @example "600s"
   * @example "20m"
   * @default "session"
   */
  timeout?: SandboxTimeout;

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
   *   memory: "1GiB",
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
   * @deprecated Use the top-level {@link DenoSandboxOptions.token} and {@link DenoSandboxOptions.org} options instead.
   * This option will be removed in a future release.
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

  /**
   * The Deno Deploy access token that should be used to authenticate requests.
   *
   * - When passing an organization token (starts with `ddo_`), no further
   *   organization information is required.
   * - When passing a personal token (starts with `ddp_`), the `org` option
   *   must also be provided.
   *
   * If not provided, the `DENO_DEPLOY_TOKEN` environment variable will be used.
   *
   * Takes precedence over the deprecated `auth.token` option.
   */
  token?: string;

  /**
   * The Deno Deploy organization slug to operate within.
   *
   * This is required when using a personal access token (starts with `ddp_`).
   * If not provided, the `DENO_DEPLOY_ORG` environment variable will be used.
   */
  org?: string;

  /**
   * Environment variables to start the sandbox with, in addition to the default
   * environment variables such as `DENO_DEPLOY_ORGANIZATION_ID`.
   */
  env?: Record<string, string>;

  /**
   * Whether to enable debug logging.
   *
   * @default false
   */
  debug?: boolean;

  /**
   * Labels to set on the sandbox. Up to 5 labels can be specified.
   * Each label key must be at most 64 bytes, and each label value
   * must be at most 128 bytes.
   */
  labels?: Record<string, string>;

  /**
   * A volume or snapshot to use as the root filesystem of the sandbox.
   *
   * If not specified, the default base image will be used. The volume or
   * snapshot must be bootable.
   *
   * - Volumes will be mounted read-write (writes are persisted).
   * - Snapshots will be mounted read-only (writes are not persisted).
   *
   * @example
   * ```typescript
   * const options: DenoSandboxOptions = {
   *   root: "my-volume-slug",
   * };
   * ```
   */
  root?: VolumeId | VolumeSlug | SnapshotId | SnapshotSlug;

  /**
   * Volumes to mount on the sandbox.
   *
   * The key is the mount path inside the sandbox, and the value is the
   * volume ID or slug.
   *
   * @example
   * ```typescript
   * const options: DenoSandboxOptions = {
   *   volumes: {
   *     "/data/volume1": "volume-slug-or-id-1",
   *   },
   * };
   * ```
   */
  volumes?: Record<string, VolumeId | VolumeSlug>;

  /**
   * List of hostnames / IP addresses with optional port numbers that the
   * sandbox can make outbound network requests to.
   *
   * If not specified, no network restrictions are applied.
   *
   * @example []
   * @example ["example.com"]
   * @example ["*.example.com"]
   * @example ["example.com:443"]
   */
  allowNet?: string[];

  /**
   * Secret environment variables that are never exposed to sandbox code.
   * The real secret values are injected on the wire when the sandbox makes
   * HTTPS requests to the specified hosts.
   *
   * The key is the environment variable name.
   *
   * @example
   * ```typescript
   * const options: DenoSandboxOptions = {
   *   secrets: {
   *     OPENAI_API_KEY: {
   *       hosts: ["api.openai.com"],
   *       value: "sk-proj-your-real-key",
   *     },
   *   },
   * };
   * ```
   */
  secrets?: Record<string, SecretConfig>;

  /**
   * Whether to expose SSH access to the sandbox. If true, the sandbox's
   * `ssh` property will be populated once the sandbox is ready.
   *
   * @example
   * ```typescript
   * const sandbox = await DenoSandbox.create({ ssh: true });
   * console.log(sandbox.instance.ssh);
   * // => { username: "...", hostname: "..." }
   * ```
   */
  ssh?: boolean;

  /**
   * The port number to expose for HTTP access. If specified, the sandbox's
   * `url` property will be populated once the sandbox is ready, and can
   * be used to access the sandbox over HTTP.
   *
   * @example
   * ```typescript
   * const sandbox = await DenoSandbox.create({ port: 8080 });
   * console.log(sandbox.instance.url);
   * // => "http://..."
   * ```
   */
  port?: number;

  /**
   * Override the Sandbox API endpoint URL to use to create and communicate
   * with the sandboxes.
   *
   * The default can also be overridden by setting the `DENO_SANDBOX_ENDPOINT`
   * or `DENO_SANDBOX_BASE_DOMAIN` environment variables.
   */
  sandboxEndpoint?: string | ((region: string) => string);

  /**
   * Override the API endpoint to use to connect to Deno Deploy.
   *
   * The default can also be overridden by setting the `DENO_DEPLOY_ENDPOINT`
   * environment variable.
   */
  apiEndpoint?: string;
}

/**
 * Error codes for Deno Sandbox operations.
 *
 * Used to identify specific error conditions and handle them appropriately.
 */
export type DenoSandboxErrorCode =
  | SandboxErrorCode
  /** Authentication failed - check token configuration */
  | "AUTHENTICATION_FAILED"
  /** Failed to create sandbox - check options and quotas */
  | "SANDBOX_CREATION_FAILED"
  /** Sandbox not found - may have been stopped or expired */
  | "SANDBOX_NOT_FOUND"
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
export class DenoSandboxError extends SandboxError {
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
    super(message, code as SandboxErrorCode, cause);
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
