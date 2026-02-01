/* eslint-disable no-instanceof/no-instanceof */
/**
 * Vercel Sandbox implementation of the SandboxBackendProtocol.
 *
 * This module provides a Vercel Sandbox backend for deepagents, enabling agents
 * to execute commands, read/write files, and manage isolated Linux microVM
 * environments using Vercel's Sandbox infrastructure.
 *
 * @packageDocumentation
 */

import { Sandbox } from "@vercel/sandbox";
import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from "deepagents";

import { getAuthCredentials } from "./auth.js";
import {
  VercelSandboxError,
  type SnapshotInfo,
  type VercelSandboxOptions,
} from "./types.js";

/**
 * Vercel Sandbox backend for deepagents.
 *
 * Extends `BaseSandbox` to provide command execution, file operations, and
 * sandbox lifecycle management using Vercel's Sandbox SDK.
 *
 * ## Basic Usage
 *
 * ```typescript
 * import { VercelSandbox } from "@langchain/vercel-sandbox";
 *
 * // Create and initialize a sandbox
 * const sandbox = await VercelSandbox.create({
 *   runtime: "node24",
 *   timeout: 600000, // 10 minutes
 * });
 *
 * try {
 *   // Execute commands
 *   const result = await sandbox.execute("node --version");
 *   console.log(result.output);
 * } finally {
 *   // Always cleanup
 *   await sandbox.stop();
 * }
 * ```
 *
 * ## Using with DeepAgent
 *
 * ```typescript
 * import { createDeepAgent } from "deepagents";
 * import { VercelSandbox } from "@langchain/vercel-sandbox";
 *
 * const sandbox = await VercelSandbox.create();
 *
 * const agent = createDeepAgent({
 *   model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *   systemPrompt: "You are a coding assistant with sandbox access.",
 *   backend: sandbox,
 * });
 * ```
 */
export class VercelSandbox extends BaseSandbox {
  /** Private reference to the underlying Vercel Sandbox instance */
  #sandbox: Sandbox | null = null;

  /** Configuration options for this sandbox */
  #options: VercelSandboxOptions;

  /** Unique identifier for this sandbox instance */
  #id: string;

  /**
   * Get the unique identifier for this sandbox.
   *
   * Before initialization, returns a temporary ID.
   * After initialization, returns the actual Vercel sandbox ID.
   */
  get id(): string {
    return this.#id;
  }

  /**
   * Get the underlying Vercel Sandbox instance.
   *
   * @throws {VercelSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const sandbox = await VercelSandbox.create();
   * const vercelSdk = sandbox.sandbox; // Access the raw SDK
   * ```
   */
  get sandbox(): Sandbox {
    if (!this.#sandbox) {
      throw new VercelSandboxError(
        "Sandbox not initialized. Call initialize() or use VercelSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#sandbox;
  }

  /**
   * Check if the sandbox is initialized and running.
   */
  get isRunning(): boolean {
    return this.#sandbox !== null;
  }

  /**
   * Create a new VercelSandbox instance.
   *
   * Note: This only creates the instance. Call `initialize()` to actually
   * create the Vercel Sandbox, or use the static `VercelSandbox.create()` method.
   *
   * @param options - Configuration options for the sandbox
   *
   * @example
   * ```typescript
   * // Two-step initialization
   * const sandbox = new VercelSandbox({ runtime: "node24" });
   * await sandbox.initialize();
   *
   * // Or use the factory method
   * const sandbox = await VercelSandbox.create({ runtime: "node24" });
   * ```
   */
  constructor(options: VercelSandboxOptions = {}) {
    super();

    // Set defaults
    this.#options = {
      runtime: "node24",
      timeout: 300000, // 5 minutes
      ...options,
    };

    // Generate temporary ID until initialized
    this.#id = `vercel-sandbox-${Date.now()}`;
  }

  /**
   * Initialize the sandbox by creating a new Vercel Sandbox instance.
   *
   * This method authenticates with Vercel and provisions a new microVM
   * sandbox. After initialization, the `id` property will reflect the
   * actual Vercel sandbox ID.
   *
   * @throws {VercelSandboxError} If already initialized (`ALREADY_INITIALIZED`)
   * @throws {VercelSandboxError} If authentication fails (`AUTHENTICATION_FAILED`)
   * @throws {VercelSandboxError} If sandbox creation fails (`SANDBOX_CREATION_FAILED`)
   *
   * @example
   * ```typescript
   * const sandbox = new VercelSandbox();
   * await sandbox.initialize();
   * console.log(`Sandbox ID: ${sandbox.id}`);
   * ```
   */
  async initialize(): Promise<void> {
    // Prevent double initialization
    if (this.#sandbox) {
      throw new VercelSandboxError(
        "Sandbox is already initialized. Each VercelSandbox instance can only be initialized once.",
        "ALREADY_INITIALIZED",
      );
    }

    // Get authentication credentials
    let credentials: { token: string; teamId?: string; projectId?: string };
    try {
      credentials = getAuthCredentials(this.#options.auth);
    } catch (error) {
      throw new VercelSandboxError(
        "Failed to authenticate with Vercel. Check your token configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      // Build SDK create options with required fields
      const createOptions: NonNullable<Parameters<typeof Sandbox.create>[0]> = {
        runtime: this.#options.runtime,
        timeout: this.#options.timeout,
        token: credentials.token,
        teamId: credentials.teamId,
        projectId: credentials.projectId,
      };

      // Add optional source configuration
      if (this.#options.source) {
        createOptions.source = this.#options.source;
      }

      // Add optional ports configuration
      if (this.#options.ports?.length) {
        createOptions.ports = this.#options.ports;
      }

      // Add optional vCPUs configuration
      if (this.#options.vcpus !== undefined) {
        createOptions.resources = { vcpus: this.#options.vcpus };
      }

      // Create the sandbox
      this.#sandbox = await Sandbox.create(createOptions);

      // Update ID to the actual sandbox ID
      this.#id = this.#sandbox.sandboxId;
    } catch (error) {
      throw new VercelSandboxError(
        `Failed to create Vercel Sandbox: ${error instanceof Error ? error.message : String(error)}`,
        "SANDBOX_CREATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Execute a command in the sandbox.
   *
   * Commands are run using `/bin/bash -c` in the `/vercel/sandbox` directory.
   *
   * @param command - The shell command to execute
   * @returns Execution result with output, exit code, and truncation flag
   * @throws {VercelSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const result = await sandbox.execute("echo 'Hello World'");
   * console.log(result.output); // "Hello World\n"
   * console.log(result.exitCode); // 0
   * ```
   */
  async execute(command: string): Promise<ExecuteResponse> {
    const sandbox = this.sandbox; // Throws if not initialized

    try {
      const result = await sandbox.runCommand({
        cmd: "/bin/bash",
        args: ["-c", command],
        cwd: "/vercel/sandbox",
      });

      const stdout = await result.stdout();
      const stderr = await result.stderr();

      return {
        output: stdout + stderr,
        exitCode: result.exitCode,
        truncated: false,
      };
    } catch (error) {
      // Check for timeout
      if (error instanceof Error && error.message.includes("timeout")) {
        throw new VercelSandboxError(
          `Command timed out: ${command}`,
          "COMMAND_TIMEOUT",
          error,
        );
      }

      throw new VercelSandboxError(
        `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
        "COMMAND_FAILED",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Upload files to the sandbox.
   *
   * Files are written to the sandbox filesystem. Parent directories are
   * created automatically if they don't exist.
   *
   * @param files - Array of [path, content] tuples to upload
   * @returns Upload result for each file, with success or error status
   *
   * @example
   * ```typescript
   * const encoder = new TextEncoder();
   * const results = await sandbox.uploadFiles([
   *   ["src/index.js", encoder.encode("console.log('Hello')")],
   *   ["package.json", encoder.encode('{"name": "test"}')],
   * ]);
   * ```
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const sandbox = this.sandbox; // Throws if not initialized
    const results: FileUploadResponse[] = [];

    // Convert Uint8Array to Buffer for Vercel SDK
    const vercelFiles = files.map(([path, content]) => ({
      path,
      content: Buffer.from(content),
    }));

    try {
      await sandbox.writeFiles(vercelFiles);
      // All succeeded
      for (const [path] of files) {
        results.push({ path, error: null });
      }
    } catch (error) {
      // Handle SDK errors - map to individual file failures
      const mappedError = this.#mapError(error);
      for (const [path] of files) {
        results.push({ path, error: mappedError });
      }
    }

    return results;
  }

  /**
   * Download files from the sandbox.
   *
   * Each file is read individually, allowing partial success when some
   * files exist and others don't.
   *
   * @param paths - Array of file paths to download
   * @returns Download result for each file, with content or error
   *
   * @example
   * ```typescript
   * const results = await sandbox.downloadFiles(["src/index.js", "missing.txt"]);
   * for (const result of results) {
   *   if (result.content) {
   *     console.log(new TextDecoder().decode(result.content));
   *   } else {
   *     console.error(`Error: ${result.error}`);
   *   }
   * }
   * ```
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const sandbox = this.sandbox; // Throws if not initialized
    const results: FileDownloadResponse[] = [];

    for (const path of paths) {
      try {
        const buffer = await sandbox.readFileToBuffer({ path });

        if (buffer === null) {
          results.push({
            path,
            content: null,
            error: "file_not_found",
          });
        } else {
          results.push({
            path,
            content: new Uint8Array(buffer),
            error: null,
          });
        }
      } catch (error) {
        results.push({
          path,
          content: null,
          error: this.#mapError(error),
        });
      }
    }

    return results;
  }

  /**
   * Get the public URL for an exposed port.
   *
   * The port must have been specified in the `ports` option when creating
   * the sandbox.
   *
   * @param port - The port number to get the URL for
   * @returns The public URL for the port
   * @throws {VercelSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const sandbox = await VercelSandbox.create({ ports: [3000] });
   * await sandbox.execute("npm run dev");
   * const url = sandbox.domain(3000);
   * console.log(`Preview: ${url}`);
   * ```
   */
  domain(port: number): string {
    const sandbox = this.sandbox; // Throws if not initialized
    return sandbox.domain(port);
  }

  /**
   * Extend the sandbox timeout.
   *
   * Adds the specified duration to the remaining timeout. The maximum
   * timeout depends on your Vercel plan (45 min for Hobby, 5 hours for Pro).
   *
   * @param duration - Additional time in milliseconds
   * @throws {VercelSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * // Add 10 more minutes
   * await sandbox.extendTimeout(600000);
   * ```
   */
  async extendTimeout(duration: number): Promise<void> {
    const sandbox = this.sandbox; // Throws if not initialized
    await sandbox.extendTimeout(duration);
  }

  /**
   * Create a snapshot of the current sandbox state.
   *
   * Snapshots capture the complete filesystem and can be used to quickly
   * create new sandboxes with the same state. The sandbox will be stopped
   * after snapshotting.
   *
   * Note: Snapshots expire after 7 days.
   *
   * @returns Information about the created snapshot
   * @throws {VercelSandboxError} If the sandbox is not initialized
   * @throws {VercelSandboxError} If snapshot creation fails
   *
   * @example
   * ```typescript
   * // Install dependencies then snapshot
   * await sandbox.execute("npm install");
   * const snapshot = await sandbox.snapshot();
   * console.log(`Snapshot ID: ${snapshot.snapshotId}`);
   *
   * // Later, restore from snapshot
   * const newSandbox = await VercelSandbox.create({
   *   source: { type: "snapshot", snapshotId: snapshot.snapshotId }
   * });
   * ```
   */
  async snapshot(): Promise<SnapshotInfo> {
    const sandbox = this.sandbox; // Throws if not initialized

    try {
      const snapshot = await sandbox.snapshot();

      return {
        snapshotId: snapshot.snapshotId,
        sourceSandboxId: snapshot.sourceSandboxId,
        status: snapshot.status,
        sizeBytes: snapshot.sizeBytes,
        createdAt: snapshot.createdAt,
        expiresAt: snapshot.expiresAt,
      };
    } catch (error) {
      throw new VercelSandboxError(
        `Failed to create snapshot: ${error instanceof Error ? error.message : String(error)}`,
        "SNAPSHOT_FAILED",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Stop the sandbox and release all resources.
   *
   * After stopping, the sandbox cannot be used again. Any unsaved data
   * will be lost.
   *
   * @example
   * ```typescript
   * try {
   *   await sandbox.execute("npm run build");
   * } finally {
   *   await sandbox.stop();
   * }
   * ```
   */
  async stop(): Promise<void> {
    if (this.#sandbox) {
      try {
        await this.#sandbox.stop();
      } finally {
        this.#sandbox = null;
      }
    }
  }

  /**
   * Set the sandbox from an existing Vercel Sandbox instance.
   * Used internally by the static `get()` method.
   */
  #setFromExisting(existingSandbox: Sandbox, sandboxId: string): void {
    this.#sandbox = existingSandbox;
    this.#id = sandboxId;
  }

  /**
   * Map Vercel SDK errors to standardized FileOperationError codes.
   *
   * @param error - The error from the Vercel SDK
   * @returns A standardized error code
   */
  #mapError(error: unknown): FileOperationError {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();

      if (msg.includes("not found") || msg.includes("enoent")) {
        return "file_not_found";
      }
      if (msg.includes("permission") || msg.includes("eacces")) {
        return "permission_denied";
      }
      if (msg.includes("directory") || msg.includes("eisdir")) {
        return "is_directory";
      }
    }

    return "invalid_path";
  }

  // ============================================================================
  // Static Factory Methods
  // ============================================================================

  /**
   * Create and initialize a new VercelSandbox in one step.
   *
   * This is the recommended way to create a sandbox. It combines
   * construction and initialization into a single async operation.
   *
   * @param options - Configuration options for the sandbox
   * @returns An initialized and ready-to-use sandbox
   *
   * @example
   * ```typescript
   * const sandbox = await VercelSandbox.create({
   *   runtime: "node24",
   *   timeout: 600000,
   *   ports: [3000],
   * });
   * ```
   */
  static async create(options?: VercelSandboxOptions): Promise<VercelSandbox> {
    const sandbox = new VercelSandbox(options);
    await sandbox.initialize();
    return sandbox;
  }

  /**
   * Reconnect to an existing sandbox by ID.
   *
   * This allows you to resume working with a sandbox that was created
   * earlier in the same session or from a different process.
   *
   * @param sandboxId - The ID of the sandbox to reconnect to
   * @param options - Optional auth configuration (for token)
   * @returns A connected sandbox instance
   *
   * @example
   * ```typescript
   * // Resume a sandbox from a stored ID
   * const sandbox = await VercelSandbox.get("sandbox-abc123");
   * const result = await sandbox.execute("ls -la");
   * ```
   */
  static async get(
    sandboxId: string,
    options?: Pick<VercelSandboxOptions, "auth">,
  ): Promise<VercelSandbox> {
    // Get authentication credentials
    let credentials: { token: string; teamId?: string; projectId?: string };
    try {
      credentials = getAuthCredentials(options?.auth);
    } catch (error) {
      throw new VercelSandboxError(
        "Failed to authenticate with Vercel. Check your token configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      const existingSandbox = await Sandbox.get({
        sandboxId,
        token: credentials.token,
        teamId: credentials.teamId,
        projectId: credentials.projectId,
      });

      const vercelSandbox = new VercelSandbox();
      // Set the existing sandbox directly (bypass initialize)
      vercelSandbox.#setFromExisting(existingSandbox, sandboxId);

      return vercelSandbox;
    } catch (error) {
      throw new VercelSandboxError(
        `Sandbox not found: ${sandboxId}`,
        "SANDBOX_NOT_FOUND",
        error instanceof Error ? error : undefined,
      );
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

import type { BackendFactory } from "deepagents";

/**
 * Async factory function type for creating Vercel Sandbox instances.
 *
 * This is similar to BackendFactory but supports async creation,
 * which is required for Vercel Sandbox since initialization is async.
 */
export type AsyncVercelSandboxFactory = () => Promise<VercelSandbox>;

/**
 * Create an async factory function that creates a new Vercel Sandbox per invocation.
 *
 * Each call to the factory will create and initialize a new sandbox.
 * This is useful when you want fresh, isolated environments for each
 * agent invocation.
 *
 * **Important**: This returns an async factory. For use with middleware that
 * requires synchronous BackendFactory, use `createVercelSandboxFactoryFromSandbox()`
 * with a pre-created sandbox instead.
 *
 * @param options - Optional configuration for sandbox creation
 * @returns An async factory function that creates new sandboxes
 *
 * @example
 * ```typescript
 * import { VercelSandbox, createVercelSandboxFactory } from "@langchain/vercel-sandbox";
 *
 * // Create a factory for new sandboxes
 * const factory = createVercelSandboxFactory({ runtime: "node24" });
 *
 * // Each call creates a new sandbox
 * const sandbox1 = await factory();
 * const sandbox2 = await factory();
 *
 * try {
 *   // Use sandboxes...
 * } finally {
 *   await sandbox1.stop();
 *   await sandbox2.stop();
 * }
 * ```
 */
export function createVercelSandboxFactory(
  options?: VercelSandboxOptions,
): AsyncVercelSandboxFactory {
  return async () => {
    return await VercelSandbox.create(options);
  };
}

/**
 * Create a backend factory that reuses an existing Vercel Sandbox.
 *
 * This allows multiple agent invocations to share the same sandbox,
 * avoiding the startup overhead of creating new sandboxes.
 *
 * Important: You are responsible for managing the sandbox lifecycle
 * (calling `stop()` when done).
 *
 * @param sandbox - An existing VercelSandbox instance (must be initialized)
 * @returns A BackendFactory that returns the provided sandbox
 *
 * @example
 * ```typescript
 * import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
 * import { VercelSandbox, createVercelSandboxFactoryFromSandbox } from "@langchain/vercel-sandbox";
 *
 * // Create and initialize a sandbox
 * const sandbox = await VercelSandbox.create({ runtime: "node24" });
 *
 * try {
 *   const agent = createDeepAgent({
 *     model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *     systemPrompt: "You are a coding assistant.",
 *     middlewares: [
 *       createFilesystemMiddleware({
 *         backend: createVercelSandboxFactoryFromSandbox(sandbox),
 *       }),
 *     ],
 *   });
 *
 *   await agent.invoke({ messages: [...] });
 * } finally {
 *   await sandbox.stop();
 * }
 * ```
 */
export function createVercelSandboxFactoryFromSandbox(
  sandbox: VercelSandbox,
): BackendFactory {
  return () => sandbox;
}
