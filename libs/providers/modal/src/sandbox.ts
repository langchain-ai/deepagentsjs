/* eslint-disable no-instanceof/no-instanceof */
/**
 * Modal Sandbox implementation of the SandboxBackendProtocol.
 *
 * This module provides a Modal Sandbox backend for deepagents, enabling agents
 * to execute commands, read/write files, and manage isolated container
 * environments using Modal's serverless infrastructure.
 *
 * @packageDocumentation
 */

import { ModalClient } from "modal";
import type { App, Sandbox, Image, SandboxCreateParams } from "modal";
import {
  BaseSandbox,
  type BackendFactory,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from "deepagents";

import { getAuthCredentials } from "./auth.js";
import { ModalSandboxError, type ModalSandboxOptions } from "./types.js";

/**
 * Modal Sandbox backend for deepagents.
 *
 * Extends `BaseSandbox` to provide command execution, file operations, and
 * sandbox lifecycle management using Modal's serverless infrastructure.
 *
 * ## Basic Usage
 *
 * ```typescript
 * import { ModalSandbox } from "@langchain/modal";
 *
 * // Create and initialize a sandbox
 * const sandbox = await ModalSandbox.create({
 *   imageName: "python:3.12-slim",
 *   timeout: 600,
 * });
 *
 * try {
 *   // Execute commands
 *   const result = await sandbox.execute("python --version");
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
 * import { ModalSandbox } from "@langchain/modal";
 *
 * const sandbox = await ModalSandbox.create();
 *
 * const agent = createDeepAgent({
 *   model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *   systemPrompt: "You are a coding assistant with sandbox access.",
 *   backend: sandbox,
 * });
 * ```
 */
export class ModalSandbox extends BaseSandbox {
  /** Private reference to the Modal client */
  #client: ModalClient | null = null;

  /** Private reference to the Modal App */
  #app: App | null = null;

  /** Private reference to the underlying Modal Sandbox instance */
  #sandbox: Sandbox | null = null;

  /** Configuration options for this sandbox */
  #options: ModalSandboxOptions;

  /** Unique identifier for this sandbox instance */
  #id: string;

  /**
   * Get the unique identifier for this sandbox.
   *
   * Before initialization, returns a temporary ID.
   * After initialization, returns the actual Modal sandbox ID.
   */
  get id(): string {
    return this.#id;
  }

  /**
   * Get the underlying Modal Sandbox instance.
   *
   * @throws {ModalSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const sandbox = await ModalSandbox.create();
   * const modalInstance = sandbox.instance; // Access the raw Modal Sandbox
   * ```
   */
  get instance(): Sandbox {
    if (!this.#sandbox) {
      throw new ModalSandboxError(
        "Sandbox not initialized. Call initialize() or use ModalSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#sandbox;
  }

  /**
   * Get the underlying Modal client instance.
   *
   * @throws {ModalSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const sandbox = await ModalSandbox.create();
   * const modalClient = sandbox.client; // Access the raw Modal client
   * ```
   */
  get client(): ModalClient {
    if (!this.#client) {
      throw new ModalSandboxError(
        "Sandbox not initialized. Call initialize() or use ModalSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#client;
  }

  /**
   * Check if the sandbox is initialized and running.
   */
  get isRunning(): boolean {
    return this.#sandbox !== null;
  }

  /**
   * Create a new ModalSandbox instance.
   *
   * Note: This only creates the instance. Call `initialize()` to actually
   * create the Modal Sandbox, or use the static `ModalSandbox.create()` method.
   *
   * @param options - Configuration options for the sandbox
   *
   * @example
   * ```typescript
   * // Two-step initialization
   * const sandbox = new ModalSandbox({ imageName: "python:3.12-slim" });
   * await sandbox.initialize();
   *
   * // Or use the factory method
   * const sandbox = await ModalSandbox.create({ imageName: "python:3.12-slim" });
   * ```
   */
  constructor(options: ModalSandboxOptions = {}) {
    super();

    // Set defaults for our custom options only
    // SDK options (timeoutMs, etc.) use SDK defaults
    this.#options = {
      appName: "deepagents-sandbox",
      imageName: "alpine:3.21",
      ...options,
    };

    // Generate temporary ID until initialized
    this.#id = `modal-sandbox-${Date.now()}`;
  }

  /**
   * Initialize the sandbox by creating a new Modal Sandbox instance.
   *
   * This method authenticates with Modal and provisions a new sandbox container.
   * After initialization, the `id` property will reflect the actual Modal sandbox ID.
   *
   * @throws {ModalSandboxError} If already initialized (`ALREADY_INITIALIZED`)
   * @throws {ModalSandboxError} If authentication fails (`AUTHENTICATION_FAILED`)
   * @throws {ModalSandboxError} If sandbox creation fails (`SANDBOX_CREATION_FAILED`)
   *
   * @example
   * ```typescript
   * const sandbox = new ModalSandbox();
   * await sandbox.initialize();
   * console.log(`Sandbox ID: ${sandbox.id}`);
   * ```
   */
  async initialize(): Promise<void> {
    // Prevent double initialization
    if (this.#sandbox) {
      throw new ModalSandboxError(
        "Sandbox is already initialized. Each ModalSandbox instance can only be initialized once.",
        "ALREADY_INITIALIZED",
      );
    }

    // Validate authentication credentials exist
    try {
      getAuthCredentials(this.#options.auth);
    } catch (error) {
      throw new ModalSandboxError(
        "Failed to authenticate with Modal. Check your token configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      // Create Modal client
      this.#client = new ModalClient();

      // Get or create the app
      this.#app = await this.#client.apps.fromName(
        this.#options.appName ?? "deepagents-sandbox",
        { createIfMissing: true },
      );

      // Create the image
      const image: Image = this.#client.images.fromRegistry(
        this.#options.imageName ?? "alpine:3.21",
      );

      // Build sandbox creation options
      // Extract our custom fields, pass everything else through to SDK
      const {
        appName: _appName,
        imageName: _imageName,
        initialFiles: _initialFiles,
        auth: _auth,
        volumes: volumeNames,
        secrets: secretNames,
        ...sdkOptions
      } = this.#options;

      const createOptions: SandboxCreateParams = { ...sdkOptions };

      // Handle volumes - look up Volume objects from names
      if (volumeNames !== undefined) {
        const volumeObjects: SandboxCreateParams["volumes"] = {};
        for (const [mountPath, volumeName] of Object.entries(volumeNames)) {
          const volume = await this.#client.volumes.fromName(volumeName, {
            createIfMissing: false,
          });
          volumeObjects[mountPath] = volume;
        }
        createOptions.volumes = volumeObjects;
      }

      // Handle secrets - look up Secret objects from names
      if (secretNames !== undefined && secretNames.length > 0) {
        const secretObjects: SandboxCreateParams["secrets"] = [];
        for (const secretName of secretNames) {
          const secret = await this.#client.secrets.fromName(secretName);
          secretObjects.push(secret);
        }
        createOptions.secrets = secretObjects;
      }

      // Create the sandbox
      this.#sandbox = await this.#client.sandboxes.create(
        this.#app,
        image,
        createOptions,
      );

      // Update ID to the actual sandbox ID
      this.#id = this.#sandbox.sandboxId;

      // Upload initial files if provided
      if (this.#options.initialFiles) {
        await this.#uploadInitialFiles(this.#options.initialFiles);
      }
    } catch (error) {
      // If it's already a ModalSandboxError, re-throw it
      if (ModalSandboxError.isInstance(error)) {
        throw error;
      }

      throw new ModalSandboxError(
        `Failed to create Modal Sandbox: ${error instanceof Error ? error.message : String(error)}`,
        "SANDBOX_CREATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Upload initial files to the sandbox during initialization.
   * This is a private helper method used by initialize().
   *
   * @param files - Record of file paths to contents
   */
  async #uploadInitialFiles(
    files: Record<string, string | Uint8Array>,
  ): Promise<void> {
    const encoder = new TextEncoder();
    const filesToUpload: Array<[string, Uint8Array]> = [];

    for (const [filePath, content] of Object.entries(files)) {
      // Normalize the path - remove leading slash if present for consistency
      const normalizedPath = filePath.startsWith("/")
        ? filePath.slice(1)
        : filePath;

      // Convert string content to Uint8Array
      const data =
        typeof content === "string" ? encoder.encode(content) : content;

      filesToUpload.push([normalizedPath, data]);
    }

    // Use the existing uploadFiles method
    const results = await this.uploadFiles(filesToUpload);

    // Check for errors
    const errors = results.filter((r) => r.error !== null);
    if (errors.length > 0) {
      const errorPaths = errors.map((e) => e.path).join(", ");
      throw new ModalSandboxError(
        `Failed to upload initial files: ${errorPaths}`,
        "FILE_OPERATION_FAILED",
      );
    }
  }

  /**
   * Execute a command in the sandbox.
   *
   * Commands are run using bash -c to execute the command string.
   *
   * @param command - The shell command to execute
   * @returns Execution result with output, exit code, and truncation flag
   * @throws {ModalSandboxError} If the sandbox is not initialized
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
      // Execute using bash -c to handle shell features
      const process = await sandbox.exec(["bash", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
      });

      // Read both stdout and stderr
      const [stdout, stderr] = await Promise.all([
        process.stdout.readText(),
        process.stderr.readText(),
      ]);

      // Wait for the process to complete and get exit code
      const exitCode = await process.wait();

      return {
        output: stdout + stderr,
        exitCode: exitCode ?? 0,
        truncated: false,
      };
    } catch (error) {
      // Check for timeout
      if (error instanceof Error && error.message.includes("timeout")) {
        throw new ModalSandboxError(
          `Command timed out: ${command}`,
          "COMMAND_TIMEOUT",
          error,
        );
      }

      throw new ModalSandboxError(
        `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
        "COMMAND_FAILED",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Upload files to the sandbox.
   *
   * Files are written to the sandbox filesystem using Modal's file API.
   * Parent directories are created automatically if they don't exist.
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
          await sandbox
            .exec(["mkdir", "-p", parentDir], {
              stdout: "pipe",
              stderr: "pipe",
            })
            .then((p) => p.wait());
        }

        // Write the file content using Modal's file API
        const writeHandle = await sandbox.open(path, "w");
        await writeHandle.write(content);
        await writeHandle.close();

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
   * Each file is read individually using Modal's file API, allowing
   * partial success when some files exist and others don't.
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
        // Read the file content using Modal's file API
        const readHandle = await sandbox.open(path, "r");
        const content = await readHandle.read();
        await readHandle.close();

        results.push({
          path,
          content: new Uint8Array(content),
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
   * After closing, the sandbox cannot be used again. This terminates
   * the sandbox container on Modal.
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
        await this.#sandbox.terminate();
      } finally {
        this.#sandbox = null;
        this.#app = null;
        this.#client = null;
      }
    }
  }

  /**
   * Terminate the sandbox.
   *
   * Alias for close() for Modal SDK compatibility.
   *
   * @example
   * ```typescript
   * await sandbox.terminate();
   * ```
   */
  async terminate(): Promise<void> {
    await this.close();
  }

  /**
   * Alias for close() to maintain compatibility with other sandbox implementations.
   */
  async stop(): Promise<void> {
    await this.close();
  }

  /**
   * Poll the sandbox status to check if it has finished running.
   *
   * @returns The exit code if the sandbox has finished, or null if still running
   */
  async poll(): Promise<number | null> {
    if (!this.#sandbox) {
      return null;
    }
    return this.#sandbox.poll();
  }

  /**
   * Wait for the sandbox to finish running.
   *
   * @returns The exit code of the sandbox
   * @throws {ModalSandboxError} If the sandbox is not initialized
   */
  async wait(): Promise<number> {
    return this.instance.wait();
  }

  /**
   * Set the sandbox from an existing Modal Sandbox instance.
   * Used internally by the static `fromId()` and `fromName()` methods.
   */
  #setFromExisting(
    client: ModalClient,
    existingSandbox: Sandbox,
    sandboxId: string,
  ): void {
    this.#client = client;
    this.#sandbox = existingSandbox;
    this.#id = sandboxId;
  }

  /**
   * Map Modal SDK errors to standardized FileOperationError codes.
   *
   * @param error - The error from the Modal SDK
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
   * Create and initialize a new ModalSandbox in one step.
   *
   * This is the recommended way to create a sandbox. It combines
   * construction and initialization into a single async operation.
   *
   * @param options - Configuration options for the sandbox
   * @returns An initialized and ready-to-use sandbox
   *
   * @example
   * ```typescript
   * const sandbox = await ModalSandbox.create({
   *   imageName: "python:3.12-slim",
   *   timeout: 600,
   *   memory: 2048,
   * });
   * ```
   */
  static async create(options?: ModalSandboxOptions): Promise<ModalSandbox> {
    const sandbox = new ModalSandbox(options);
    await sandbox.initialize();
    return sandbox;
  }

  /**
   * Reconnect to an existing sandbox by ID.
   *
   * This allows you to resume working with a sandbox that was created
   * earlier and is still running.
   *
   * @param sandboxId - The ID of the sandbox to reconnect to
   * @param options - Optional auth configuration
   * @returns A connected sandbox instance
   *
   * @example
   * ```typescript
   * // Resume a sandbox from a stored ID
   * const sandbox = await ModalSandbox.fromId("sb-abc123");
   * const result = await sandbox.execute("ls -la");
   * ```
   */
  static async fromId(
    sandboxId: string,
    options?: Pick<ModalSandboxOptions, "auth">,
  ): Promise<ModalSandbox> {
    // Validate authentication credentials exist
    try {
      getAuthCredentials(options?.auth);
    } catch (error) {
      throw new ModalSandboxError(
        "Failed to authenticate with Modal. Check your token configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      const client = new ModalClient();
      const existingSandbox = await client.sandboxes.fromId(sandboxId);

      const modalSandbox = new ModalSandbox(options);
      modalSandbox.#setFromExisting(client, existingSandbox, sandboxId);

      return modalSandbox;
    } catch (error) {
      throw new ModalSandboxError(
        `Sandbox not found: ${sandboxId}`,
        "SANDBOX_NOT_FOUND",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get a running sandbox by name from a deployed app.
   *
   * @param appName - The name of the Modal app
   * @param sandboxName - The name of the sandbox
   * @param options - Optional auth configuration
   * @returns A connected sandbox instance
   *
   * @example
   * ```typescript
   * const sandbox = await ModalSandbox.fromName("my-app", "my-sandbox");
   * const result = await sandbox.execute("ls -la");
   * ```
   */
  static async fromName(
    appName: string,
    sandboxName: string,
    options?: Pick<ModalSandboxOptions, "auth">,
  ): Promise<ModalSandbox> {
    // Validate authentication credentials exist
    try {
      getAuthCredentials(options?.auth);
    } catch (error) {
      throw new ModalSandboxError(
        "Failed to authenticate with Modal. Check your token configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      const client = new ModalClient();
      const existingSandbox = await client.sandboxes.fromName(
        appName,
        sandboxName,
      );

      const modalSandbox = new ModalSandbox(options);
      modalSandbox.#setFromExisting(
        client,
        existingSandbox,
        existingSandbox.sandboxId,
      );

      return modalSandbox;
    } catch (error) {
      throw new ModalSandboxError(
        `Sandbox not found: ${appName}/${sandboxName}`,
        "SANDBOX_NOT_FOUND",
        error instanceof Error ? error : undefined,
      );
    }
  }
}

/**
 * Async factory function type for creating Modal Sandbox instances.
 *
 * This is similar to BackendFactory but supports async creation,
 * which is required for Modal Sandbox since initialization is async.
 */
export type AsyncModalSandboxFactory = () => Promise<ModalSandbox>;

/**
 * Create an async factory function that creates a new Modal Sandbox per invocation.
 *
 * Each call to the factory will create and initialize a new sandbox.
 * This is useful when you want fresh, isolated environments for each
 * agent invocation.
 *
 * **Important**: This returns an async factory. For use with middleware that
 * requires synchronous BackendFactory, use `createModalSandboxFactoryFromSandbox()`
 * with a pre-created sandbox instead.
 *
 * @param options - Optional configuration for sandbox creation
 * @returns An async factory function that creates new sandboxes
 *
 * @example
 * ```typescript
 * import { ModalSandbox, createModalSandboxFactory } from "@langchain/modal";
 *
 * // Create a factory for new sandboxes
 * const factory = createModalSandboxFactory({ imageName: "python:3.12-slim" });
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
export function createModalSandboxFactory(
  options?: ModalSandboxOptions,
): AsyncModalSandboxFactory {
  return async () => {
    return await ModalSandbox.create(options);
  };
}

/**
 * Create a backend factory that reuses an existing Modal Sandbox.
 *
 * This allows multiple agent invocations to share the same sandbox,
 * avoiding the startup overhead of creating new sandboxes.
 *
 * Important: You are responsible for managing the sandbox lifecycle
 * (calling `close()` when done).
 *
 * @param sandbox - An existing ModalSandbox instance (must be initialized)
 * @returns A BackendFactory that returns the provided sandbox
 *
 * @example
 * ```typescript
 * import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
 * import { ModalSandbox, createModalSandboxFactoryFromSandbox } from "@langchain/modal";
 *
 * // Create and initialize a sandbox
 * const sandbox = await ModalSandbox.create({ imageName: "python:3.12-slim" });
 *
 * try {
 *   const agent = createDeepAgent({
 *     model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *     systemPrompt: "You are a coding assistant.",
 *     middlewares: [
 *       createFilesystemMiddleware({
 *         backend: createModalSandboxFactoryFromSandbox(sandbox),
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
export function createModalSandboxFactoryFromSandbox(
  sandbox: ModalSandbox,
): BackendFactory {
  return () => sandbox;
}
