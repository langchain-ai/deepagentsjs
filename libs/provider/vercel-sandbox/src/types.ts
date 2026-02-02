/**
 * Type definitions for the Vercel Sandbox backend.
 *
 * This module contains all type definitions for the @langchain/vercel-sandbox package,
 * including source types, options, snapshot info, and error types.
 */

/**
 * Git repository source for sandbox initialization.
 *
 * Clones a git repository into the sandbox on creation.
 *
 * @example
 * ```typescript
 * const source: GitSource = {
 *   type: "git",
 *   url: "https://github.com/user/repo.git",
 *   depth: 1, // Shallow clone for faster setup
 *   revision: "main",
 * };
 * ```
 */
export interface GitSource {
  /** Discriminator for source type */
  type: "git";
  /** Git repository URL (HTTPS or SSH) */
  url: string;
  /** Username for authenticated repositories */
  username?: string;
  /** Password or personal access token for authenticated repositories */
  password?: string;
  /** Clone depth for shallow clones (e.g., 1 for latest commit only) */
  depth?: number;
  /** Branch, tag, or commit SHA to checkout */
  revision?: string;
}

/**
 * Tarball source for sandbox initialization.
 *
 * Downloads and extracts a tarball into the sandbox on creation.
 *
 * @example
 * ```typescript
 * const source: TarballSource = {
 *   type: "tarball",
 *   url: "https://example.com/project.tar.gz",
 * };
 * ```
 */
export interface TarballSource {
  /** Discriminator for source type */
  type: "tarball";
  /** URL to the tarball file */
  url: string;
}

/**
 * Snapshot source for sandbox initialization.
 *
 * Creates a sandbox from a previously saved snapshot for fast startup.
 *
 * @example
 * ```typescript
 * const source: SnapshotSource = {
 *   type: "snapshot",
 *   snapshotId: "snap_abc123",
 * };
 * ```
 */
export interface SnapshotSource {
  /** Discriminator for source type */
  type: "snapshot";
  /** ID of the snapshot to restore from */
  snapshotId: string;
}

/**
 * Union type for all sandbox source types.
 */
export type SandboxSource = GitSource | TarballSource | SnapshotSource;

/**
 * Configuration options for creating a Vercel Sandbox.
 *
 * @example
 * ```typescript
 * const options: VercelSandboxOptions = {
 *   runtime: "node24",
 *   timeout: 600000, // 10 minutes
 *   ports: [3000],
 *   source: {
 *     type: "git",
 *     url: "https://github.com/user/repo.git",
 *   },
 * };
 * ```
 */
export interface VercelSandboxOptions {
  /**
   * Runtime image to use for the sandbox.
   *
   * Available runtimes:
   * - `node24`: Node.js 24 (default)
   * - `node22`: Node.js 22
   * - `python3.13`: Python 3.13
   *
   * @default "node24"
   */
  runtime?: "node24" | "node22" | "python3.13";

  /**
   * Source configuration for sandbox initialization.
   *
   * Supports:
   * - Git repositories (cloned on creation)
   * - Tarballs (downloaded and extracted)
   * - Snapshots (restored from previous state)
   *
   * If not provided, creates an empty sandbox.
   */
  source?: GitSource | TarballSource | SnapshotSource;

  /**
   * Ports to expose for public access.
   *
   * Exposed ports can be accessed via `sandbox.domain(port)`.
   *
   * @example
   * ```typescript
   * const sandbox = await VercelSandbox.create({ ports: [3000, 8080] });
   * const url = sandbox.domain(3000);
   * ```
   */
  ports?: number[];

  /**
   * Initial timeout in milliseconds.
   *
   * The sandbox will automatically stop after this duration.
   * Can be extended using `extendTimeout()`.
   *
   * Maximum values depend on Vercel plan:
   * - Hobby: 45 minutes
   * - Pro/Enterprise: 5 hours
   *
   * @default 300000 (5 minutes)
   */
  timeout?: number;

  /**
   * Number of virtual CPUs allocated to the sandbox.
   *
   * Higher values improve performance for CPU-intensive tasks.
   * Defaults to plan baseline if not specified.
   */
  vcpus?: number;

  /**
   * Authentication configuration for Vercel API.
   *
   * Two authentication methods are supported:
   *
   * ### Option 1: OIDC Token (Recommended for local development)
   * Run `vercel link && vercel env pull` to automatically set up authentication.
   * This creates a `.env.local` file with `VERCEL_OIDC_TOKEN`.
   *
   * ### Option 2: Access Token (For CI/CD or external environments)
   * Set the following environment variables:
   * - `VERCEL_TOKEN`: Your Vercel access token
   * - `VERCEL_TEAM_ID`: Your team ID (from team settings)
   * - `VERCEL_PROJECT_ID`: Your project ID (from project settings)
   *
   * Or pass them directly in this auth configuration.
   */
  auth?: {
    /**
     * Authentication type:
     * - `oidc`: Vercel OIDC token (recommended for local development)
     * - `access_token`: Vercel access token (for CI/CD)
     */
    type: "oidc" | "access_token";
    /**
     * The authentication token.
     * If not provided, reads from `VERCEL_OIDC_TOKEN` or `VERCEL_TOKEN` environment variables.
     */
    token?: string;
    /**
     * Vercel Team ID (required when using access_token authentication).
     * If not provided, reads from `VERCEL_TEAM_ID` environment variable.
     */
    teamId?: string;
    /**
     * Vercel Project ID (required when using access_token authentication).
     * If not provided, reads from `VERCEL_PROJECT_ID` environment variable.
     */
    projectId?: string;
  };
}

/**
 * Information about a sandbox snapshot.
 *
 * Snapshots capture the complete state of a sandbox and can be used
 * to quickly create new sandboxes with the same state.
 *
 * Note: Snapshots expire after 7 days.
 *
 * @example
 * ```typescript
 * const snapshot = await sandbox.snapshot();
 * console.log(`Snapshot ${snapshot.snapshotId} created`);
 * console.log(`Size: ${snapshot.sizeBytes} bytes`);
 * console.log(`Expires: ${snapshot.expiresAt.toISOString()}`);
 * ```
 */
export interface SnapshotInfo {
  /** Unique identifier for the snapshot */
  snapshotId: string;
  /** ID of the sandbox that was snapshotted */
  sourceSandboxId: string;
  /** Current status of the snapshot */
  status: "created" | "deleted" | "failed";
  /** Size of the snapshot in bytes */
  sizeBytes: number;
  /** Timestamp when the snapshot was created */
  createdAt: Date;
  /** Timestamp when the snapshot will expire (7 days after creation) */
  expiresAt: Date;
}

/**
 * Error codes for Vercel Sandbox operations.
 *
 * Used to identify specific error conditions and handle them appropriately.
 */
export type VercelSandboxErrorCode =
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
  /** Snapshot creation or restoration failed */
  | "SNAPSHOT_FAILED"
  /** Resource limits exceeded (CPU, memory, storage) */
  | "RESOURCE_LIMIT_EXCEEDED";

/**
 * Custom error class for Vercel Sandbox operations.
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
 *   if (error instanceof VercelSandboxError) {
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
export class VercelSandboxError extends Error {
  /** Error name for instanceof checks and logging */
  override readonly name = "VercelSandboxError";

  /**
   * Creates a new VercelSandboxError.
   *
   * @param message - Human-readable error description
   * @param code - Structured error code for programmatic handling
   * @param cause - Original error that caused this error (for debugging)
   */
  constructor(
    message: string,
    public readonly code: VercelSandboxErrorCode,
    public override readonly cause?: Error,
  ) {
    super(message);
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, VercelSandboxError.prototype);
  }
}
