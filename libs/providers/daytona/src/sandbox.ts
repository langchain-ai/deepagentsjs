/* eslint-disable no-instanceof/no-instanceof */
/**
 * Daytona Sandbox implementation of the SandboxBackendProtocol.
 *
 * This module provides a Daytona Sandbox backend for deepagents, enabling agents
 * to execute commands, read/write files, and manage isolated sandbox environments
 * using Daytona's infrastructure.
 *
 * @packageDocumentation
 */

import { Daytona, type Sandbox } from "@daytonaio/sdk";
import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
  type BackendFactory,
} from "deepagents";

import { getAuthCredentials } from "./auth.js";
import { DaytonaSandboxError, type DaytonaSandboxOptions } from "./types.js";

/**
 * Daytona Sandbox backend for deepagents.
 *
 * Extends `BaseSandbox` to provide command execution, file operations, and
 * sandbox lifecycle management using Daytona's SDK.
 *
 * ## Basic Usage
 *
 * ```typescript
 * import { DaytonaSandbox } from "@langchain/daytona";
 *
 * // Create and initialize a sandbox
 * const sandbox = await DaytonaSandbox.create({
 *   language: "typescript",
 *   timeout: 300,
 * });
 *
 * try {
 *   // Execute commands
 *   const result = await sandbox.execute("node --version");
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
 * import { DaytonaSandbox } from "@langchain/daytona";
 *
 * const sandbox = await DaytonaSandbox.create();
 *
 * const agent = createDeepAgent({
 *   model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *   systemPrompt: "You are a coding assistant with sandbox access.",
 *   backend: sandbox,
 * });
 * ```
 */
export class DaytonaSandbox extends BaseSandbox {
  /** Private reference to the Daytona client */
  #daytona: Daytona | null = null;

  /** Private reference to the underlying Daytona Sandbox instance */
  #sandbox: Sandbox | null = null;

  /** Configuration options for this sandbox */
  #options: DaytonaSandboxOptions;

  /** Unique identifier for this sandbox instance */
  #id: string;

  /** Default timeout for command execution in seconds */
  #timeout: number;

  /**
   * Get the unique identifier for this sandbox.
   *
   * Before initialization, returns a temporary ID.
   * After initialization, returns the actual Daytona sandbox ID.
   */
  get id(): string {
    return this.#id;
  }

  /**
   * Get the underlying Daytona Sandbox instance.
   *
   * @throws {DaytonaSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const sandbox = await DaytonaSandbox.create();
   * const daytonaSdk = sandbox.sandbox; // Access the raw SDK
   * ```
   */
  get instance(): Sandbox {
    if (!this.#sandbox) {
      throw new DaytonaSandboxError(
        "Sandbox not initialized. Call initialize() or use DaytonaSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#sandbox;
  }

  /**
   * Get the underlying Daytona client instance.
   *
   * @throws {DaytonaSandboxError} If the client is not initialized
   *
   * @example
   * ```typescript
   * const sandbox = await DaytonaSandbox.create();
   * const daytonaClient = sandbox.client; // Access the raw Daytona client
   * ```
   */
  get client(): Daytona {
    if (!this.#daytona) {
      throw new DaytonaSandboxError(
        "Daytona client not initialized. Call initialize() or use DaytonaSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#daytona;
  }

  /**
   * Check if the sandbox is initialized and running.
   */
  get isRunning(): boolean {
    return this.#sandbox !== null;
  }

  /**
   * Create a new DaytonaSandbox instance.
   *
   * Note: This only creates the instance. Call `initialize()` to actually
   * create the Daytona Sandbox, or use the static `DaytonaSandbox.create()` method.
   *
   * @param options - Configuration options for the sandbox
   *
   * @example
   * ```typescript
   * // Two-step initialization
   * const sandbox = new DaytonaSandbox({ language: "typescript" });
   * await sandbox.initialize();
   *
   * // Or use the factory method
   * const sandbox = await DaytonaSandbox.create({ language: "typescript" });
   * ```
   */
  constructor(options: DaytonaSandboxOptions = {}) {
    super();

    // Set defaults
    this.#options = {
      language: "typescript",
      timeout: 300,
      ...options,
    };

    this.#timeout = this.#options.timeout ?? 300;

    // Generate temporary ID until initialized
    this.#id = `daytona-sandbox-${Date.now()}`;
  }

  /**
   * Initialize the sandbox by creating a new Daytona Sandbox instance.
   *
   * This method authenticates with Daytona and provisions a new sandbox.
   * After initialization, the `id` property will reflect the actual sandbox ID.
   *
   * @throws {DaytonaSandboxError} If already initialized (`ALREADY_INITIALIZED`)
   * @throws {DaytonaSandboxError} If authentication fails (`AUTHENTICATION_FAILED`)
   * @throws {DaytonaSandboxError} If sandbox creation fails (`SANDBOX_CREATION_FAILED`)
   *
   * @example
   * ```typescript
   * const sandbox = new DaytonaSandbox();
   * await sandbox.initialize();
   * console.log(`Sandbox ID: ${sandbox.id}`);
   * ```
   */
  async initialize(): Promise<void> {
    // Prevent double initialization
    if (this.#sandbox) {
      throw new DaytonaSandboxError(
        "Sandbox is already initialized. Each DaytonaSandbox instance can only be initialized once.",
        "ALREADY_INITIALIZED",
      );
    }

    // Get authentication credentials
    let credentials: { apiKey: string; apiUrl: string; target?: string };
    try {
      credentials = getAuthCredentials(
        this.#options.auth,
        this.#options.target,
      );
    } catch (error) {
      throw new DaytonaSandboxError(
        "Failed to authenticate with Daytona. Check your API key configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      // Create Daytona client
      this.#daytona = new Daytona({
        apiKey: credentials.apiKey,
        apiUrl: credentials.apiUrl,
        target: credentials.target,
      });

      // Determine if we're creating from image or snapshot
      if (this.#options.image) {
        // Create from image (allows custom resources)
        const createOptions: {
          image: string;
          language?: string;
          envVars?: Record<string, string>;
          autoStopInterval?: number;
          labels?: Record<string, string>;
          resources?: { cpu?: number; memory?: number; disk?: number };
        } = {
          image: this.#options.image,
          language: this.#options.language ?? "typescript",
        };

        if (this.#options.envVars) {
          createOptions.envVars = this.#options.envVars;
        }

        if (this.#options.autoStopInterval !== undefined) {
          createOptions.autoStopInterval = this.#options.autoStopInterval;
        }

        if (this.#options.labels) {
          createOptions.labels = this.#options.labels;
        }

        if (this.#options.resources) {
          createOptions.resources = this.#options.resources;
        }

        // Create the sandbox from image
        this.#sandbox = await this.#daytona.create(createOptions);
      } else {
        // Create from snapshot (default, simpler approach)
        const createOptions: {
          language?: string;
          snapshot?: string;
          envVars?: Record<string, string>;
          autoStopInterval?: number;
          labels?: Record<string, string>;
        } = {
          language: this.#options.language ?? "typescript",
        };

        if (this.#options.snapshot) {
          createOptions.snapshot = this.#options.snapshot;
        }

        if (this.#options.envVars) {
          createOptions.envVars = this.#options.envVars;
        }

        if (this.#options.autoStopInterval !== undefined) {
          createOptions.autoStopInterval = this.#options.autoStopInterval;
        }

        if (this.#options.labels) {
          createOptions.labels = this.#options.labels;
        }

        // Create the sandbox from snapshot
        this.#sandbox = await this.#daytona.create(createOptions);
      }

      // Update ID to the actual sandbox ID
      this.#id = this.#sandbox.id;

      // Upload initial files if provided
      if (this.#options.initialFiles) {
        await this.#uploadInitialFiles(this.#options.initialFiles);
      }
    } catch (error) {
      throw new DaytonaSandboxError(
        `Failed to create Daytona Sandbox: ${error instanceof Error ? error.message : String(error)}`,
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
      throw new DaytonaSandboxError(
        `Failed to upload initial files: ${errorPaths}`,
        "FILE_OPERATION_FAILED",
      );
    }
  }

  /**
   * Execute a command in the sandbox.
   *
   * Commands are run using the sandbox's shell.
   *
   * @param command - The shell command to execute
   * @returns Execution result with output, exit code, and truncation flag
   * @throws {DaytonaSandboxError} If the sandbox is not initialized
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
      const response = await sandbox.process.executeCommand(
        command,
        undefined,
        undefined,
        this.#timeout,
      );

      return {
        output: response.result ?? "",
        exitCode: response.exitCode ?? 0,
        truncated: false,
      };
    } catch (error) {
      // Check for timeout
      if (error instanceof Error && error.message.includes("timeout")) {
        throw new DaytonaSandboxError(
          `Command timed out: ${command}`,
          "COMMAND_TIMEOUT",
          error,
        );
      }

      throw new DaytonaSandboxError(
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
        // Ensure parent directory exists
        const parentDir = path.substring(0, path.lastIndexOf("/"));
        if (parentDir) {
          await sandbox.fs.createFolder(parentDir, "755");
        }

        // Upload the file content
        const buffer = Buffer.from(content);
        await sandbox.fs.uploadFile(buffer, path);
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
        const buffer = await sandbox.fs.downloadFile(path);
        results.push({
          path,
          content: new Uint8Array(buffer),
          error: null,
        });
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
   * After closing, the sandbox cannot be used again. The sandbox is deleted
   * from Daytona's infrastructure.
   *
   * @example
   * ```typescript
   * try {
   *   await sandbox.execute("npm run build");
   * } finally {
   *   await sandbox.close();
   * }
   * ```
   */
  async close(): Promise<void> {
    if (this.#sandbox) {
      try {
        await this.#sandbox.delete();
      } finally {
        this.#sandbox = null;
        this.#daytona = null;
      }
    }
  }

  /**
   * Stop the sandbox without deleting it.
   *
   * The sandbox can be restarted later using `start()`.
   *
   * @example
   * ```typescript
   * await sandbox.stop();
   * // Later...
   * await sandbox.start();
   * ```
   */
  async stop(): Promise<void> {
    if (this.#sandbox) {
      await this.#sandbox.stop();
    }
  }

  /**
   * Start a stopped sandbox.
   *
   * @param timeout - Maximum time to wait in seconds (default: 60)
   *
   * @example
   * ```typescript
   * await sandbox.start();
   * console.log("Sandbox is now running");
   * ```
   */
  async start(timeout: number = 60): Promise<void> {
    if (this.#sandbox) {
      await this.#sandbox.start(timeout);
    }
  }

  /**
   * Forcefully terminate and delete the sandbox.
   *
   * Use this when you need to immediately stop the sandbox.
   *
   * @example
   * ```typescript
   * await sandbox.kill();
   * ```
   */
  async kill(): Promise<void> {
    await this.close();
  }

  /**
   * Get the working directory path inside the sandbox.
   *
   * @returns The absolute path to the sandbox working directory
   *
   * @example
   * ```typescript
   * const workDir = await sandbox.getWorkDir();
   * console.log(`Working directory: ${workDir}`);
   * ```
   */
  async getWorkDir(): Promise<string> {
    const sandbox = this.instance;
    const workDir = await sandbox.getWorkDir();
    return workDir ?? "/home/daytona";
  }

  /**
   * Get the user's home directory path inside the sandbox.
   *
   * @returns The absolute path to the user's home directory
   *
   * @example
   * ```typescript
   * const homeDir = await sandbox.getUserHomeDir();
   * console.log(`Home directory: ${homeDir}`);
   * ```
   */
  async getUserHomeDir(): Promise<string> {
    const sandbox = this.instance;
    const homeDir = await sandbox.getUserHomeDir();
    return homeDir ?? "/home/daytona";
  }

  /**
   * Set the sandbox from an existing Daytona Sandbox instance.
   * Used internally by the static `connect()` method.
   */
  #setFromExisting(
    daytona: Daytona,
    existingSandbox: Sandbox,
    sandboxId: string,
  ): void {
    this.#daytona = daytona;
    this.#sandbox = existingSandbox;
    this.#id = sandboxId;
  }

  /**
   * Map Daytona SDK errors to standardized FileOperationError codes.
   *
   * @param error - The error from the Daytona SDK
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
   * Create and initialize a new DaytonaSandbox in one step.
   *
   * This is the recommended way to create a sandbox. It combines
   * construction and initialization into a single async operation.
   *
   * @param options - Configuration options for the sandbox
   * @returns An initialized and ready-to-use sandbox
   *
   * @example
   * ```typescript
   * const sandbox = await DaytonaSandbox.create({
   *   language: "typescript",
   *   cpu: 2,
   *   memory: 4,
   * });
   * ```
   */
  static async create(
    options?: DaytonaSandboxOptions,
  ): Promise<DaytonaSandbox> {
    const sandbox = new DaytonaSandbox(options);
    await sandbox.initialize();
    return sandbox;
  }

  /**
   * Connect to an existing sandbox by ID.
   *
   * This allows you to resume working with a sandbox that was created
   * earlier or that is still running.
   *
   * @param sandboxId - The ID of the sandbox to connect to
   * @param options - Optional auth configuration (for API key)
   * @returns A connected sandbox instance
   *
   * @example
   * ```typescript
   * // Resume a sandbox from a stored ID
   * const sandbox = await DaytonaSandbox.connect("sandbox-abc123");
   * const result = await sandbox.execute("ls -la");
   * ```
   */
  static async fromId(
    id: string,
    options?: Pick<DaytonaSandboxOptions, "auth" | "target" | "timeout">,
  ): Promise<DaytonaSandbox> {
    // Get authentication credentials
    let credentials: { apiKey: string; apiUrl: string; target?: string };
    try {
      credentials = getAuthCredentials(options?.auth, options?.target);
    } catch (error) {
      throw new DaytonaSandboxError(
        "Failed to authenticate with Daytona. Check your API key configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      const daytona = new Daytona({
        apiKey: credentials.apiKey,
        apiUrl: credentials.apiUrl,
        target: credentials.target,
      });

      const existingSandbox = await daytona.get(id);

      const daytonaSandbox = new DaytonaSandbox(options);
      // Set the existing sandbox directly (bypass initialize)
      daytonaSandbox.#setFromExisting(daytona, existingSandbox, id);

      return daytonaSandbox;
    } catch (error) {
      throw new DaytonaSandboxError(
        `Sandbox not found: ${id}`,
        "SANDBOX_NOT_FOUND",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get a running sandbox by name from a deployed app.
   *
   * @param name - The name of the sandbox
   * @param options - Optional auth configuration
   * @returns A connected sandbox instance
   */
  static async fromName(
    name: string,
    options?: Pick<DaytonaSandboxOptions, "auth">,
  ): Promise<DaytonaSandbox> {
    return DaytonaSandbox.fromId(name, options);
  }
}

/**
 * Async factory function type for creating Daytona Sandbox instances.
 *
 * This is similar to BackendFactory but supports async creation,
 * which is required for Daytona Sandbox since initialization is async.
 */
export type AsyncDaytonaSandboxFactory = () => Promise<DaytonaSandbox>;

/**
 * Create an async factory function that creates a new Daytona Sandbox per invocation.
 *
 * Each call to the factory will create and initialize a new sandbox.
 * This is useful when you want fresh, isolated environments for each
 * agent invocation.
 *
 * **Important**: This returns an async factory. For use with middleware that
 * requires synchronous BackendFactory, use `createDaytonaSandboxFactoryFromSandbox()`
 * with a pre-created sandbox instead.
 *
 * @param options - Optional configuration for sandbox creation
 * @returns An async factory function that creates new sandboxes
 *
 * @example
 * ```typescript
 * import { DaytonaSandbox, createDaytonaSandboxFactory } from "@langchain/daytona";
 *
 * // Create a factory for new sandboxes
 * const factory = createDaytonaSandboxFactory({ language: "typescript" });
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
export function createDaytonaSandboxFactory(
  options?: DaytonaSandboxOptions,
): AsyncDaytonaSandboxFactory {
  return async () => {
    return await DaytonaSandbox.create(options);
  };
}

/**
 * Create a backend factory that reuses an existing Daytona Sandbox.
 *
 * This allows multiple agent invocations to share the same sandbox,
 * avoiding the startup overhead of creating new sandboxes.
 *
 * Important: You are responsible for managing the sandbox lifecycle
 * (calling `close()` when done).
 *
 * @param sandbox - An existing DaytonaSandbox instance (must be initialized)
 * @returns A BackendFactory that returns the provided sandbox
 *
 * @example
 * ```typescript
 * import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
 * import { DaytonaSandbox, createDaytonaSandboxFactoryFromSandbox } from "@langchain/daytona";
 *
 * // Create and initialize a sandbox
 * const sandbox = await DaytonaSandbox.create({ language: "typescript" });
 *
 * try {
 *   const agent = createDeepAgent({
 *     model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *     systemPrompt: "You are a coding assistant.",
 *     middlewares: [
 *       createFilesystemMiddleware({
 *         backend: createDaytonaSandboxFactoryFromSandbox(sandbox),
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
export function createDaytonaSandboxFactoryFromSandbox(
  sandbox: DaytonaSandbox,
): BackendFactory {
  return () => sandbox;
}
