/* eslint-disable no-instanceof/no-instanceof */
/**
 * Deno Sandbox implementation of the SandboxBackendProtocol.
 *
 * This module provides a Deno Sandbox backend for deepagents, enabling agents
 * to execute commands, read/write files, and manage isolated Linux microVM
 * environments using Deno Deploy's Sandbox infrastructure.
 *
 * @packageDocumentation
 */

import { Sandbox } from "@deno/sandbox";
import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
  type BackendFactory,
} from "deepagents";

import { getAuthCredentials } from "./auth.js";
import { DenoSandboxError, type DenoSandboxOptions } from "./types.js";

/**
 * Deno Sandbox backend for deepagents.
 *
 * Extends `BaseSandbox` to provide command execution, file operations, and
 * sandbox lifecycle management using Deno Deploy's Sandbox SDK.
 *
 * ## Basic Usage
 *
 * ```typescript
 * import { DenoSandbox } from "@langchain/deno";
 *
 * // Create and initialize a sandbox
 * const sandbox = await DenoSandbox.create({
 *   memoryMb: 1024,
 *   lifetime: "5m",
 * });
 *
 * try {
 *   // Execute commands
 *   const result = await sandbox.execute("deno --version");
 *   console.log(result.output);
 * } finally {
 *   // Always cleanup
 *   await sandbox.close();
 * }
 * ```
 *
 * ## Using with DeepAgent
 *
 * ```typescript
 * import { createDeepAgent } from "deepagents";
 * import { DenoSandbox } from "@langchain/deno";
 *
 * const sandbox = await DenoSandbox.create();
 *
 * const agent = createDeepAgent({
 *   model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *   systemPrompt: "You are a coding assistant with sandbox access.",
 *   backend: sandbox,
 * });
 * ```
 */
export class DenoSandbox extends BaseSandbox {
  /** Private reference to the underlying Deno Sandbox instance */
  #sandbox: Sandbox | null = null;

  /** Configuration options for this sandbox */
  #options: DenoSandboxOptions;

  /** Unique identifier for this sandbox instance */
  #id: string;

  /**
   * Get the unique identifier for this sandbox.
   *
   * Before initialization, returns a temporary ID.
   * After initialization, returns the actual Deno sandbox ID.
   */
  get id(): string {
    return this.#id;
  }

  /**
   * Get the underlying Deno Sandbox instance.
   *
   * @throws {DenoSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const sandbox = await DenoSandbox.create();
   * const denoSdk = sandbox.sandbox; // Access the raw SDK
   * ```
   */
  get instance(): Sandbox {
    if (!this.#sandbox) {
      throw new DenoSandboxError(
        "Sandbox not initialized. Call initialize() or use DenoSandbox.create()",
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
   * Create a new DenoSandbox instance.
   *
   * Note: This only creates the instance. Call `initialize()` to actually
   * create the Deno Sandbox, or use the static `DenoSandbox.create()` method.
   *
   * @param options - Configuration options for the sandbox
   *
   * @example
   * ```typescript
   * // Two-step initialization
   * const sandbox = new DenoSandbox({ memoryMb: 1024 });
   * await sandbox.initialize();
   *
   * // Or use the factory method
   * const sandbox = await DenoSandbox.create({ memoryMb: 1024 });
   * ```
   */
  constructor(options: DenoSandboxOptions = {}) {
    super();

    // Set defaults
    this.#options = {
      memoryMb: 768,
      lifetime: "session",
      ...options,
    };

    // Generate temporary ID until initialized
    this.#id = `deno-sandbox-${Date.now()}`;
  }

  /**
   * Initialize the sandbox by creating a new Deno Sandbox instance.
   *
   * This method authenticates with Deno Deploy and provisions a new microVM
   * sandbox. After initialization, the `id` property will reflect the
   * actual Deno sandbox ID.
   *
   * @throws {DenoSandboxError} If already initialized (`ALREADY_INITIALIZED`)
   * @throws {DenoSandboxError} If authentication fails (`AUTHENTICATION_FAILED`)
   * @throws {DenoSandboxError} If sandbox creation fails (`SANDBOX_CREATION_FAILED`)
   *
   * @example
   * ```typescript
   * const sandbox = new DenoSandbox();
   * await sandbox.initialize();
   * console.log(`Sandbox ID: ${sandbox.id}`);
   * ```
   */
  async initialize(): Promise<void> {
    // Prevent double initialization
    if (this.#sandbox) {
      throw new DenoSandboxError(
        "Sandbox is already initialized. Each DenoSandbox instance can only be initialized once.",
        "ALREADY_INITIALIZED",
      );
    }

    // Get authentication credentials
    let credentials: { token: string };
    try {
      credentials = getAuthCredentials(this.#options.auth);
    } catch (error) {
      throw new DenoSandboxError(
        "Failed to authenticate with Deno Deploy. Check your token configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      // Set the token in environment for the SDK
      process.env.DENO_DEPLOY_TOKEN = credentials.token;

      // Build SDK create options
      const createOptions: Parameters<typeof Sandbox.create>[0] = {};

      // Add optional memory configuration
      if (this.#options.memoryMb !== undefined) {
        createOptions.memoryMb = this.#options.memoryMb;
      }

      // Add optional lifetime configuration
      if (this.#options.lifetime !== undefined) {
        createOptions.lifetime = this.#options.lifetime;
      }

      // Add optional region configuration
      if (this.#options.region !== undefined) {
        createOptions.region = this.#options.region;
      }

      // Create the sandbox
      this.#sandbox = await Sandbox.create(createOptions);

      // Update ID to the actual sandbox ID
      this.#id = this.#sandbox.id;

      // Upload initial files if provided
      if (this.#options.initialFiles) {
        await this.#uploadInitialFiles(this.#options.initialFiles);
      }
    } catch (error) {
      throw new DenoSandboxError(
        `Failed to create Deno Sandbox: ${error instanceof Error ? error.message : String(error)}`,
        "SANDBOX_CREATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Upload initial files to the sandbox.
   *
   * @param files - A map of file paths to their string contents
   */
  async #uploadInitialFiles(files: Record<string, string>): Promise<void> {
    const encoder = new TextEncoder();
    const fileEntries: Array<[string, Uint8Array]> = Object.entries(files).map(
      ([path, content]) => [path, encoder.encode(content)],
    );

    const results = await this.uploadFiles(fileEntries);

    // Check for any errors during upload
    const errors = results.filter((r) => r.error !== null);
    if (errors.length > 0) {
      const errorPaths = errors.map((e) => `${e.path}: ${e.error}`).join(", ");
      throw new DenoSandboxError(
        `Failed to upload initial files: ${errorPaths}`,
        "FILE_OPERATION_FAILED",
      );
    }
  }

  /**
   * Execute a command in the sandbox.
   *
   * Commands are run using the sandbox's shell in the configured working directory.
   *
   * @param command - The shell command to execute
   * @returns Execution result with output, exit code, and truncation flag
   * @throws {DenoSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const result = await sandbox.execute("echo 'Hello World'");
   * console.log(result.output); // "Hello World\n"
   * console.log(result.exitCode); // 0
   * ```
   */
  async execute(command: string): Promise<ExecuteResponse> {
    const sandbox = this.instance; // Throws if not initialized

    try {
      // Use spawn with bash to execute the command
      const child = await sandbox.spawn("/bin/bash", {
        args: ["-c", command],
        stdout: "piped",
        stderr: "piped",
      });

      // Use output() to get buffered stdout/stderr
      const { status, stdoutText, stderrText } = await child.output();

      return {
        output: (stdoutText ?? "") + (stderrText ?? ""),
        exitCode: status.code ?? 0,
        truncated: false,
      };
    } catch (error) {
      // Check for timeout
      if (error instanceof Error && error.message.includes("timeout")) {
        throw new DenoSandboxError(
          `Command timed out: ${command}`,
          "COMMAND_TIMEOUT",
          error,
        );
      }

      throw new DenoSandboxError(
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
    const sandbox = this.instance; // Throws if not initialized
    const results: FileUploadResponse[] = [];

    for (const [path, content] of files) {
      try {
        // Ensure parent directory exists using spawn (more reliable than sh template)
        const parentDir = path.substring(0, path.lastIndexOf("/"));
        if (parentDir) {
          const mkdirChild = await sandbox.spawn("/bin/bash", {
            args: ["-c", `mkdir -p "${parentDir}"`],
            stdout: "piped",
            stderr: "piped",
          });
          await mkdirChild.output();
        }

        // Write the file content
        const textContent = new TextDecoder().decode(content);
        await sandbox.writeTextFile(path, textContent);
        results.push({ path, error: null });
      } catch (error) {
        results.push({ path, error: this.#mapError(error) });
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
    const sandbox = this.instance; // Throws if not initialized
    const results: FileDownloadResponse[] = [];

    for (const path of paths) {
      try {
        // Use spawn with bash to read file content (same approach as execute())
        const child = await sandbox.spawn("/bin/bash", {
          args: ["-c", `cat "${path}"`],
          stdout: "piped",
          stderr: "piped",
        });

        const { status, stdoutText } = await child.output();

        if (!status.success) {
          results.push({
            path,
            content: null,
            error: "file_not_found",
          });
        } else {
          const content = new TextEncoder().encode(stdoutText ?? "");
          results.push({
            path,
            content,
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
   * Close the sandbox and release all resources.
   *
   * After closing, the sandbox cannot be used again. Any unsaved data
   * will be lost.
   *
   * @example
   * ```typescript
   * try {
   *   await sandbox.execute("deno run build.ts");
   * } finally {
   *   await sandbox.close();
   * }
   * ```
   */
  async close(): Promise<void> {
    if (this.#sandbox) {
      try {
        await this.#sandbox.close();
      } finally {
        this.#sandbox = null;
      }
    }
  }

  /**
   * Forcefully terminate the sandbox.
   *
   * Use this when you need to immediately stop the sandbox, even if
   * operations are in progress.
   *
   * @example
   * ```typescript
   * await sandbox.kill();
   * ```
   */
  async kill(): Promise<void> {
    if (this.#sandbox) {
      try {
        await this.#sandbox.kill();
      } finally {
        this.#sandbox = null;
      }
    }
  }

  /**
   * Alias for close() to maintain compatibility with other sandbox implementations.
   */
  async stop(): Promise<void> {
    await this.close();
  }

  /**
   * Set the sandbox from an existing Deno Sandbox instance.
   * Used internally by the static `connect()` method.
   */
  #setFromExisting(existingSandbox: Sandbox, sandboxId: string): void {
    this.#sandbox = existingSandbox;
    this.#id = sandboxId;
  }

  /**
   * Map Deno SDK errors to standardized FileOperationError codes.
   *
   * @param error - The error from the Deno SDK
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

  /**
   * Create and initialize a new DenoSandbox in one step.
   *
   * This is the recommended way to create a sandbox. It combines
   * construction and initialization into a single async operation.
   *
   * @param options - Configuration options for the sandbox
   * @returns An initialized and ready-to-use sandbox
   *
   * @example
   * ```typescript
   * const sandbox = await DenoSandbox.create({
   *   memoryMb: 1024,
   *   lifetime: "10m",
   *   region: "iad",
   * });
   * ```
   */
  static async create(options?: DenoSandboxOptions): Promise<DenoSandbox> {
    const sandbox = new DenoSandbox(options);
    await sandbox.initialize();
    return sandbox;
  }

  /**
   * Reconnect to an existing sandbox by ID.
   *
   * This allows you to resume working with a sandbox that was created
   * earlier with a duration-based lifetime.
   *
   * @param id - The ID of the sandbox to reconnect to
   * @param options - Optional auth configuration (for token)
   * @returns A connected sandbox instance
   *
   * @example
   * ```typescript
   * // Resume a sandbox from a stored ID
   * const sandbox = await DenoSandbox.fromId("sandbox-abc123");
   * const result = await sandbox.execute("ls -la");
   * ```
   */
  static async fromId(
    id: string,
    options?: Pick<DenoSandboxOptions, "auth">,
  ): Promise<DenoSandbox> {
    // Get authentication credentials
    let credentials: { token: string };
    try {
      credentials = getAuthCredentials(options?.auth);
    } catch (error) {
      throw new DenoSandboxError(
        "Failed to authenticate with Deno Deploy. Check your token configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      // Set the token in environment for the SDK
      process.env.DENO_DEPLOY_TOKEN = credentials.token;

      const existingSandbox = await Sandbox.connect({ id });

      const denoSandbox = new DenoSandbox();
      // Set the existing sandbox directly (bypass initialize)
      denoSandbox.#setFromExisting(existingSandbox, id);

      return denoSandbox;
    } catch (error) {
      throw new DenoSandboxError(
        `Sandbox not found: ${id}`,
        "SANDBOX_NOT_FOUND",
        error instanceof Error ? error : undefined,
      );
    }
  }
}

/**
 * Async factory function type for creating Deno Sandbox instances.
 *
 * This is similar to BackendFactory but supports async creation,
 * which is required for Deno Sandbox since initialization is async.
 */
export type AsyncDenoSandboxFactory = () => Promise<DenoSandbox>;

/**
 * Create an async factory function that creates a new Deno Sandbox per invocation.
 *
 * Each call to the factory will create and initialize a new sandbox.
 * This is useful when you want fresh, isolated environments for each
 * agent invocation.
 *
 * **Important**: This returns an async factory. For use with middleware that
 * requires synchronous BackendFactory, use `createDenoSandboxFactoryFromSandbox()`
 * with a pre-created sandbox instead.
 *
 * @param options - Optional configuration for sandbox creation
 * @returns An async factory function that creates new sandboxes
 *
 * @example
 * ```typescript
 * import { DenoSandbox, createDenoSandboxFactory } from "@langchain/deno";
 *
 * // Create a factory for new sandboxes
 * const factory = createDenoSandboxFactory({ memoryMb: 1024 });
 *
 * // Each call creates a new sandbox
 * const sandbox1 = await factory();
 * const sandbox2 = await factory();
 *
 * try {
 *   // Use sandboxes...
 * } finally {
 *   await sandbox1.close();
 *   await sandbox2.close();
 * }
 * ```
 */
export function createDenoSandboxFactory(
  options?: DenoSandboxOptions,
): AsyncDenoSandboxFactory {
  return async () => {
    return await DenoSandbox.create(options);
  };
}

/**
 * Create a backend factory that reuses an existing Deno Sandbox.
 *
 * This allows multiple agent invocations to share the same sandbox,
 * avoiding the startup overhead of creating new sandboxes.
 *
 * Important: You are responsible for managing the sandbox lifecycle
 * (calling `close()` when done).
 *
 * @param sandbox - An existing DenoSandbox instance (must be initialized)
 * @returns A BackendFactory that returns the provided sandbox
 *
 * @example
 * ```typescript
 * import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
 * import { DenoSandbox, createDenoSandboxFactoryFromSandbox } from "@langchain/deno";
 *
 * // Create and initialize a sandbox
 * const sandbox = await DenoSandbox.create({ memoryMb: 1024 });
 *
 * try {
 *   const agent = createDeepAgent({
 *     model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *     systemPrompt: "You are a coding assistant.",
 *     middlewares: [
 *       createFilesystemMiddleware({
 *         backend: createDenoSandboxFactoryFromSandbox(sandbox),
 *       }),
 *     ],
 *   });
 *
 *   await agent.invoke({ messages: [...] });
 * } finally {
 *   await sandbox.close();
 * }
 * ```
 */
export function createDenoSandboxFactoryFromSandbox(
  sandbox: DenoSandbox,
): BackendFactory {
  return () => sandbox;
}
