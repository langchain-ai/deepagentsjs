/**
 * Type definitions for the LangSmith Sandbox backend.
 *
 * This module contains all type definitions for the @langchain/langsmith-sandbox package,
 * including options, API types, and error types.
 */

/**
 * LangSmith API regions.
 *
 * - `us`: United States (default)
 * - `eu`: European Union
 */
export type LangSmithRegion = "us" | "eu";

/**
 * API hosts for each region.
 */
export const API_HOSTS: Record<LangSmithRegion, string> = {
  us: "https://api.host.langchain.com",
  eu: "https://eu.api.host.langchain.com",
};

/**
 * Configuration options for creating a LangSmith Sandbox.
 *
 * @example
 * ```typescript
 * const options: LangSmithSandboxOptions = {
 *   templateName: "default",
 *   name: "my-sandbox",
 *   waitForReady: true,
 *   timeout: 180,
 * };
 * ```
 */
export interface LangSmithSandboxOptions {
  /**
   * Name of the SandboxTemplate to use.
   * This is required when creating a new sandbox.
   */
  templateName: string;

  /**
   * Optional name for the sandbox.
   * Must follow DNS-1035 format: lowercase alphanumeric and hyphens,
   * max 63 chars, must start with a letter.
   * Auto-generated if not provided.
   */
  name?: string;

  /**
   * Wait for sandbox to be ready before returning.
   * @default true
   */
  waitForReady?: boolean;

  /**
   * Timeout in seconds when waiting for ready.
   * If not provided, uses server default (typically 180 seconds).
   */
  timeout?: number;

  /**
   * Region for the LangSmith API.
   * @default "us"
   */
  region?: LangSmithRegion;

  /**
   * Authentication configuration for LangSmith API.
   *
   * ### Environment Variable Setup
   *
   * ```bash
   * # Get your API key from https://smith.langchain.com
   * export LANGSMITH_API_KEY=your_api_key_here
   * ```
   *
   * Or pass the API key directly in this auth configuration.
   */
  auth?: {
    /**
     * LangSmith API key.
     * If not provided, reads from `LANGSMITH_API_KEY` or `LANGCHAIN_API_KEY` environment variable.
     */
    apiKey?: string;
  };
}

/**
 * Request model for creating a SandboxClaim.
 */
export interface SandboxClaimCreate {
  /** Name of the SandboxTemplate to use */
  template_name: string;
  /** Optional name for the claim */
  name?: string | null;
  /** Wait for sandbox to be ready before returning */
  wait_for_ready?: boolean;
  /** Timeout in seconds when waiting for ready */
  timeout?: number | null;
}

/**
 * Response model for a SandboxClaim.
 */
export interface SandboxClaimResponse {
  /** Unique identifier for the sandbox */
  id: string;
  /** Name of the sandbox */
  name: string;
  /** Name of the template used */
  template_name: string;
  /** Direct URL for data plane operations (execute, files, terminal) */
  dataplane_url?: string | null;
  /** Creation timestamp */
  created_at?: string | null;
  /** Last update timestamp */
  updated_at?: string | null;
}

/**
 * Response model for listing sandboxes.
 */
export interface SandboxListResponse {
  sandboxes: SandboxClaimResponse[];
}

/**
 * Request payload for executing a command in the sandbox.
 */
export interface ExecuteRequest {
  /** The command to execute */
  command: string;
  /** Working directory for the command */
  cwd?: string;
  /** Timeout in seconds */
  timeout?: number;
}

/**
 * Response from command execution.
 */
export interface DataPlaneExecuteResponse {
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code of the command */
  exit_code: number;
  /** Whether the output was truncated */
  truncated?: boolean;
}

/**
 * File upload request entry.
 */
export interface FileUploadEntry {
  /** Path where the file should be written */
  path: string;
  /** Base64-encoded content */
  content: string;
}

/**
 * File upload response entry.
 */
export interface FileUploadResponseEntry {
  /** Path of the file */
  path: string;
  /** Whether the upload succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * File download response entry.
 */
export interface FileDownloadResponseEntry {
  /** Path of the file */
  path: string;
  /** Base64-encoded content (if successful) */
  content?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Error codes for LangSmith Sandbox operations.
 *
 * Used to identify specific error conditions and handle them appropriately.
 */
export type LangSmithSandboxErrorCode =
  /** Sandbox has not been initialized - call initialize() first */
  | "NOT_INITIALIZED"
  /** Sandbox is already initialized - cannot initialize twice */
  | "ALREADY_INITIALIZED"
  /** Authentication failed - check API key configuration */
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
  | "RESOURCE_LIMIT_EXCEEDED"
  /** API request failed */
  | "API_ERROR"
  /** Sandbox image pull failed */
  | "IMAGE_PULL_FAILED"
  /** Sandbox crashed during startup */
  | "CRASH_LOOP"
  /** No nodes available for scheduling */
  | "UNSCHEDULABLE";

/**
 * Custom error class for LangSmith Sandbox operations.
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
 *   if (error instanceof LangSmithSandboxError) {
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
export class LangSmithSandboxError extends Error {
  /** Error name for instanceof checks and logging */
  override readonly name = "LangSmithSandboxError";

  /**
   * Creates a new LangSmithSandboxError.
   *
   * @param message - Human-readable error description
   * @param code - Structured error code for programmatic handling
   * @param cause - Original error that caused this error (for debugging)
   */
  constructor(
    message: string,
    public readonly code: LangSmithSandboxErrorCode,
    public override readonly cause?: Error,
  ) {
    super(message);
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, LangSmithSandboxError.prototype);
  }
}
