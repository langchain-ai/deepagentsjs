/* eslint-disable no-instanceof/no-instanceof */
/**
 * LangSmith Sandbox implementation of the SandboxBackendProtocol.
 *
 * This module provides a LangSmith Sandbox backend for deepagents, enabling agents
 * to execute commands, read/write files, and manage isolated sandbox environments
 * using LangSmith's Sandbox infrastructure.
 *
 * @packageDocumentation
 */

import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
  type BackendFactory,
} from "deepagents";

import { getAuthCredentials } from "./auth.js";
import {
  API_HOSTS,
  LangSmithSandboxError,
  type LangSmithSandboxOptions,
  type SandboxClaimCreate,
  type SandboxClaimResponse,
  type DataPlaneExecuteResponse,
} from "./types.js";

/**
 * Internal state for a LangSmith Sandbox.
 */
interface SandboxState {
  /** The sandbox claim response from the API */
  claim: SandboxClaimResponse;
  /** The API key for authentication */
  apiKey: string;
  /** The control plane API host */
  apiHost: string;
}

/**
 * LangSmith Sandbox backend for deepagents.
 *
 * Extends `BaseSandbox` to provide command execution, file operations, and
 * sandbox lifecycle management using LangSmith's Sandbox API.
 *
 * ## Basic Usage
 *
 * ```typescript
 * import { LangSmithSandbox } from "@langchain/langsmith-sandbox";
 *
 * // Create and initialize a sandbox
 * const sandbox = await LangSmithSandbox.create({
 *   templateName: "default",
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
 * import { LangSmithSandbox } from "@langchain/langsmith-sandbox";
 *
 * const sandbox = await LangSmithSandbox.create({ templateName: "default" });
 *
 * const agent = createDeepAgent({
 *   model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *   systemPrompt: "You are a coding assistant with sandbox access.",
 *   backend: sandbox,
 * });
 * ```
 */
export class LangSmithSandbox extends BaseSandbox {
  /** Private reference to the sandbox state */
  #state: SandboxState | null = null;

  /** Configuration options for this sandbox */
  #options: LangSmithSandboxOptions;

  /** Unique identifier for this sandbox instance */
  #id: string;

  /**
   * Get the unique identifier for this sandbox.
   *
   * Before initialization, returns a temporary ID.
   * After initialization, returns the actual LangSmith sandbox ID.
   */
  get id(): string {
    return this.#id;
  }

  /**
   * Get the sandbox name.
   *
   * @throws {LangSmithSandboxError} If the sandbox is not initialized
   */
  get name(): string {
    if (!this.#state) {
      throw new LangSmithSandboxError(
        "Sandbox not initialized. Call initialize() or use LangSmithSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#state.claim.name;
  }

  /**
   * Get the data plane URL for this sandbox.
   *
   * @throws {LangSmithSandboxError} If the sandbox is not initialized
   */
  get dataplaneUrl(): string | null {
    if (!this.#state) {
      throw new LangSmithSandboxError(
        "Sandbox not initialized. Call initialize() or use LangSmithSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#state.claim.dataplane_url ?? null;
  }

  /**
   * Check if the sandbox is initialized and running.
   */
  get isRunning(): boolean {
    return this.#state !== null;
  }

  /**
   * Create a new LangSmithSandbox instance.
   *
   * Note: This only creates the instance. Call `initialize()` to actually
   * create the LangSmith Sandbox, or use the static `LangSmithSandbox.create()` method.
   *
   * @param options - Configuration options for the sandbox
   *
   * @example
   * ```typescript
   * // Two-step initialization
   * const sandbox = new LangSmithSandbox({ templateName: "default" });
   * await sandbox.initialize();
   *
   * // Or use the factory method
   * const sandbox = await LangSmithSandbox.create({ templateName: "default" });
   * ```
   */
  constructor(options: LangSmithSandboxOptions) {
    super();

    // Set defaults
    this.#options = {
      waitForReady: true,
      region: "us",
      ...options,
    };

    // Generate temporary ID until initialized
    this.#id = `langsmith-sandbox-${Date.now()}`;
  }

  /**
   * Initialize the sandbox by creating a new LangSmith Sandbox instance.
   *
   * This method authenticates with LangSmith and provisions a new sandbox.
   * After initialization, the `id` property will reflect the actual sandbox ID.
   *
   * @throws {LangSmithSandboxError} If already initialized (`ALREADY_INITIALIZED`)
   * @throws {LangSmithSandboxError} If authentication fails (`AUTHENTICATION_FAILED`)
   * @throws {LangSmithSandboxError} If sandbox creation fails (`SANDBOX_CREATION_FAILED`)
   *
   * @example
   * ```typescript
   * const sandbox = new LangSmithSandbox({ templateName: "default" });
   * await sandbox.initialize();
   * console.log(`Sandbox ID: ${sandbox.id}`);
   * ```
   */
  async initialize(): Promise<void> {
    // Prevent double initialization
    if (this.#state) {
      throw new LangSmithSandboxError(
        "Sandbox is already initialized. Each LangSmithSandbox instance can only be initialized once.",
        "ALREADY_INITIALIZED",
      );
    }

    // Get authentication credentials
    let credentials: { apiKey: string };
    try {
      credentials = getAuthCredentials(this.#options.auth);
    } catch (error) {
      throw new LangSmithSandboxError(
        "Failed to authenticate with LangSmith. Check your API key configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    const apiHost = API_HOSTS[this.#options.region ?? "us"];

    try {
      // Build the request body
      const requestBody: SandboxClaimCreate = {
        template_name: this.#options.templateName,
        wait_for_ready: this.#options.waitForReady ?? true,
      };

      if (this.#options.name) {
        requestBody.name = this.#options.name;
      }

      if (this.#options.timeout !== undefined) {
        requestBody.timeout = this.#options.timeout;
      }

      // Create the sandbox via API
      const response = await fetch(`${apiHost}/v2/sandboxes/boxes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": credentials.apiKey,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage =
          (errorData as { detail?: { message?: string } })?.detail?.message ||
          response.statusText;
        const errorType = (errorData as { detail?: { error?: string } })?.detail
          ?.error;

        // Map specific error types
        let errorCode: LangSmithSandboxError["code"] =
          "SANDBOX_CREATION_FAILED";
        if (response.status === 408) {
          errorCode = "COMMAND_TIMEOUT";
        } else if (response.status === 422) {
          if (errorType === "ImagePull") {
            errorCode = "IMAGE_PULL_FAILED";
          } else if (errorType === "CrashLoop") {
            errorCode = "CRASH_LOOP";
          }
        } else if (response.status === 503) {
          errorCode = "UNSCHEDULABLE";
        }

        throw new LangSmithSandboxError(
          `Failed to create LangSmith Sandbox: ${errorMessage}`,
          errorCode,
        );
      }

      const claim = (await response.json()) as SandboxClaimResponse;

      // Store state
      this.#state = {
        claim,
        apiKey: credentials.apiKey,
        apiHost,
      };

      // Update ID to the actual sandbox ID
      this.#id = claim.id;
    } catch (error) {
      if (error instanceof LangSmithSandboxError) {
        throw error;
      }
      throw new LangSmithSandboxError(
        `Failed to create LangSmith Sandbox: ${error instanceof Error ? error.message : String(error)}`,
        "SANDBOX_CREATION_FAILED",
        error instanceof Error ? error : undefined,
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
   * @throws {LangSmithSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const result = await sandbox.execute("echo 'Hello World'");
   * console.log(result.output); // "Hello World\n"
   * console.log(result.exitCode); // 0
   * ```
   */
  async execute(command: string): Promise<ExecuteResponse> {
    const state = this.#getState(); // Throws if not initialized

    // If we have a data plane URL, use it for execution
    const dataplaneUrl = state.claim.dataplane_url;
    if (!dataplaneUrl) {
      throw new LangSmithSandboxError(
        "Sandbox data plane URL not available. The sandbox may not be fully ready.",
        "NOT_INITIALIZED",
      );
    }

    try {
      const response = await fetch(`${dataplaneUrl}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": state.apiKey,
        },
        body: JSON.stringify({
          command,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new LangSmithSandboxError(
          `Command execution failed: ${errorText}`,
          "COMMAND_FAILED",
        );
      }

      const result = (await response.json()) as DataPlaneExecuteResponse;

      // Combine stdout and stderr into a single output string
      const output = (result.stdout ?? "") + (result.stderr ?? "");

      return {
        output,
        exitCode: result.exit_code,
        truncated: result.truncated ?? false,
      };
    } catch (error) {
      if (error instanceof LangSmithSandboxError) {
        throw error;
      }

      // Check for timeout
      if (error instanceof Error && error.message.includes("timeout")) {
        throw new LangSmithSandboxError(
          `Command timed out: ${command}`,
          "COMMAND_TIMEOUT",
          error,
        );
      }

      throw new LangSmithSandboxError(
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
    const state = this.#getState(); // Throws if not initialized

    const dataplaneUrl = state.claim.dataplane_url;
    if (!dataplaneUrl) {
      // Fallback: use execute to write files
      return this.#uploadFilesViaExecute(files);
    }

    try {
      // Convert files to base64 for the API
      const fileEntries = files.map(([path, content]) => ({
        path,
        content: this.#uint8ArrayToBase64(content),
      }));

      const response = await fetch(`${dataplaneUrl}/files/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": state.apiKey,
        },
        body: JSON.stringify({ files: fileEntries }),
      });

      if (!response.ok) {
        // Fallback to execute-based upload
        return this.#uploadFilesViaExecute(files);
      }

      const result = (await response.json()) as {
        files: Array<{ path: string; success: boolean; error?: string }>;
      };

      return result.files.map((f) => ({
        path: f.path,
        error: f.error ? this.#mapErrorString(f.error) : null,
      }));
    } catch {
      // Fallback to execute-based upload
      return this.#uploadFilesViaExecute(files);
    }
  }

  /**
   * Fallback method to upload files using execute commands.
   */
  async #uploadFilesViaExecute(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const results: FileUploadResponse[] = [];

    for (const [path, content] of files) {
      try {
        // Ensure parent directory exists
        const parentDir = path.substring(0, path.lastIndexOf("/"));
        if (parentDir) {
          await this.execute(`mkdir -p ${this.#escapeShellArg(parentDir)}`);
        }

        // Write the file using base64 encoding to handle binary content
        const base64Content = this.#uint8ArrayToBase64(content);
        const result = await this.execute(
          `echo '${base64Content}' | base64 -d > ${this.#escapeShellArg(path)}`,
        );

        if (result.exitCode !== 0) {
          results.push({ path, error: this.#mapErrorString(result.output) });
        } else {
          results.push({ path, error: null });
        }
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
    const state = this.#getState(); // Throws if not initialized

    const dataplaneUrl = state.claim.dataplane_url;
    if (!dataplaneUrl) {
      // Fallback: use execute to read files
      return this.#downloadFilesViaExecute(paths);
    }

    try {
      const response = await fetch(`${dataplaneUrl}/files/download`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": state.apiKey,
        },
        body: JSON.stringify({ paths }),
      });

      if (!response.ok) {
        // Fallback to execute-based download
        return this.#downloadFilesViaExecute(paths);
      }

      const result = (await response.json()) as {
        files: Array<{ path: string; content?: string; error?: string }>;
      };

      return result.files.map((f) => ({
        path: f.path,
        content: f.content ? this.#base64ToUint8Array(f.content) : null,
        error: f.error ? this.#mapErrorString(f.error) : null,
      }));
    } catch {
      // Fallback to execute-based download
      return this.#downloadFilesViaExecute(paths);
    }
  }

  /**
   * Fallback method to download files using execute commands.
   */
  async #downloadFilesViaExecute(
    paths: string[],
  ): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = [];

    for (const path of paths) {
      try {
        // Read file and encode as base64
        const result = await this.execute(
          `base64 ${this.#escapeShellArg(path)} 2>/dev/null`,
        );

        if (result.exitCode !== 0) {
          results.push({
            path,
            content: null,
            error: "file_not_found",
          });
        } else {
          const content = this.#base64ToUint8Array(result.output.trim());
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
   *   await sandbox.execute("python build.py");
   * } finally {
   *   await sandbox.close();
   * }
   * ```
   */
  async close(): Promise<void> {
    if (this.#state) {
      try {
        const { claim, apiKey, apiHost } = this.#state;

        // Delete the sandbox via API
        await fetch(`${apiHost}/v2/sandboxes/boxes/${claim.name}`, {
          method: "DELETE",
          headers: {
            "X-Api-Key": apiKey,
          },
        });
      } finally {
        this.#state = null;
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
   * Alias for close() to maintain compatibility with other sandbox implementations.
   */
  async kill(): Promise<void> {
    await this.close();
  }

  /**
   * Get the internal state, throwing if not initialized.
   */
  #getState(): SandboxState {
    if (!this.#state) {
      throw new LangSmithSandboxError(
        "Sandbox not initialized. Call initialize() or use LangSmithSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#state;
  }

  /**
   * Set the sandbox state from an existing claim.
   * Used internally by the static `connect()` method.
   */
  #setFromExisting(
    claim: SandboxClaimResponse,
    apiKey: string,
    apiHost: string,
  ): void {
    this.#state = { claim, apiKey, apiHost };
    this.#id = claim.id;
  }

  /**
   * Escape a string for safe use in shell commands.
   */
  #escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Convert Uint8Array to base64 string.
   */
  #uint8ArrayToBase64(data: Uint8Array): string {
    // Use Buffer in Node.js
    if (typeof Buffer !== "undefined") {
      return Buffer.from(data).toString("base64");
    }
    // Fallback for browser/other environments
    let binary = "";
    const len = data.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert base64 string to Uint8Array.
   */
  #base64ToUint8Array(base64: string): Uint8Array {
    // Use Buffer in Node.js
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(base64, "base64"));
    }
    // Fallback for browser/other environments
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Map an error to a standardized FileOperationError code.
   */
  #mapError(error: unknown): FileOperationError {
    if (error instanceof Error) {
      return this.#mapErrorString(error.message);
    }
    return "invalid_path";
  }

  /**
   * Map an error string to a standardized FileOperationError code.
   */
  #mapErrorString(msg: string): FileOperationError {
    const lowerMsg = msg.toLowerCase();

    if (lowerMsg.includes("not found") || lowerMsg.includes("enoent")) {
      return "file_not_found";
    }
    if (lowerMsg.includes("permission") || lowerMsg.includes("eacces")) {
      return "permission_denied";
    }
    if (lowerMsg.includes("directory") || lowerMsg.includes("eisdir")) {
      return "is_directory";
    }

    return "invalid_path";
  }

  // ============================================================================
  // Static Factory Methods
  // ============================================================================

  /**
   * Create and initialize a new LangSmithSandbox in one step.
   *
   * This is the recommended way to create a sandbox. It combines
   * construction and initialization into a single async operation.
   *
   * @param options - Configuration options for the sandbox
   * @returns An initialized and ready-to-use sandbox
   *
   * @example
   * ```typescript
   * const sandbox = await LangSmithSandbox.create({
   *   templateName: "default",
   *   timeout: 180,
   *   region: "us",
   * });
   * ```
   */
  static async create(
    options: LangSmithSandboxOptions,
  ): Promise<LangSmithSandbox> {
    const sandbox = new LangSmithSandbox(options);
    await sandbox.initialize();
    return sandbox;
  }

  /**
   * Connect to an existing sandbox by name.
   *
   * This allows you to resume working with a sandbox that was created earlier.
   *
   * @param sandboxName - The name of the sandbox to connect to
   * @param options - Optional configuration (for API key and region)
   * @returns A connected sandbox instance
   *
   * @example
   * ```typescript
   * // Resume a sandbox from a stored name
   * const sandbox = await LangSmithSandbox.connect("my-sandbox-abc123");
   * const result = await sandbox.execute("ls -la");
   * ```
   */
  static async connect(
    sandboxName: string,
    options?: Pick<LangSmithSandboxOptions, "auth" | "region">,
  ): Promise<LangSmithSandbox> {
    // Get authentication credentials
    let credentials: { apiKey: string };
    try {
      credentials = getAuthCredentials(options?.auth);
    } catch (error) {
      throw new LangSmithSandboxError(
        "Failed to authenticate with LangSmith. Check your API key configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    const apiHost = API_HOSTS[options?.region ?? "us"];

    try {
      // Get the sandbox info via API
      const response = await fetch(
        `${apiHost}/v2/sandboxes/boxes/${sandboxName}`,
        {
          method: "GET",
          headers: {
            "X-Api-Key": credentials.apiKey,
          },
        },
      );

      if (!response.ok) {
        throw new LangSmithSandboxError(
          `Sandbox not found: ${sandboxName}`,
          "SANDBOX_NOT_FOUND",
        );
      }

      const claim = (await response.json()) as SandboxClaimResponse;

      const sandbox = new LangSmithSandbox({
        templateName: claim.template_name,
        ...options,
      });

      // Set the existing sandbox directly (bypass initialize)
      sandbox.#setFromExisting(claim, credentials.apiKey, apiHost);

      return sandbox;
    } catch (error) {
      if (error instanceof LangSmithSandboxError) {
        throw error;
      }
      throw new LangSmithSandboxError(
        `Sandbox not found: ${sandboxName}`,
        "SANDBOX_NOT_FOUND",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * List all sandboxes in the tenant's namespace.
   *
   * @param options - Optional configuration (for API key and region)
   * @returns Array of sandbox claims
   *
   * @example
   * ```typescript
   * const sandboxes = await LangSmithSandbox.list();
   * for (const sb of sandboxes) {
   *   console.log(`${sb.name}: ${sb.template_name}`);
   * }
   * ```
   */
  static async list(
    options?: Pick<LangSmithSandboxOptions, "auth" | "region">,
  ): Promise<SandboxClaimResponse[]> {
    // Get authentication credentials
    let credentials: { apiKey: string };
    try {
      credentials = getAuthCredentials(options?.auth);
    } catch (error) {
      throw new LangSmithSandboxError(
        "Failed to authenticate with LangSmith. Check your API key configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    const apiHost = API_HOSTS[options?.region ?? "us"];

    const response = await fetch(`${apiHost}/v2/sandboxes/boxes`, {
      method: "GET",
      headers: {
        "X-Api-Key": credentials.apiKey,
      },
    });

    if (!response.ok) {
      throw new LangSmithSandboxError(
        `Failed to list sandboxes: ${response.statusText}`,
        "API_ERROR",
      );
    }

    const result = (await response.json()) as {
      sandboxes: SandboxClaimResponse[];
    };
    return result.sandboxes;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Async factory function type for creating LangSmith Sandbox instances.
 *
 * This is similar to BackendFactory but supports async creation,
 * which is required for LangSmith Sandbox since initialization is async.
 */
export type AsyncLangSmithSandboxFactory = () => Promise<LangSmithSandbox>;

/**
 * Create an async factory function that creates a new LangSmith Sandbox per invocation.
 *
 * Each call to the factory will create and initialize a new sandbox.
 * This is useful when you want fresh, isolated environments for each
 * agent invocation.
 *
 * **Important**: This returns an async factory. For use with middleware that
 * requires synchronous BackendFactory, use `createLangSmithSandboxFactoryFromSandbox()`
 * with a pre-created sandbox instead.
 *
 * @param options - Configuration for sandbox creation
 * @returns An async factory function that creates new sandboxes
 *
 * @example
 * ```typescript
 * import { LangSmithSandbox, createLangSmithSandboxFactory } from "@langchain/langsmith-sandbox";
 *
 * // Create a factory for new sandboxes
 * const factory = createLangSmithSandboxFactory({ templateName: "default" });
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
export function createLangSmithSandboxFactory(
  options: LangSmithSandboxOptions,
): AsyncLangSmithSandboxFactory {
  return async () => {
    return await LangSmithSandbox.create(options);
  };
}

/**
 * Create a backend factory that reuses an existing LangSmith Sandbox.
 *
 * This allows multiple agent invocations to share the same sandbox,
 * avoiding the startup overhead of creating new sandboxes.
 *
 * Important: You are responsible for managing the sandbox lifecycle
 * (calling `close()` when done).
 *
 * @param sandbox - An existing LangSmithSandbox instance (must be initialized)
 * @returns A BackendFactory that returns the provided sandbox
 *
 * @example
 * ```typescript
 * import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
 * import { LangSmithSandbox, createLangSmithSandboxFactoryFromSandbox } from "@langchain/langsmith-sandbox";
 *
 * // Create and initialize a sandbox
 * const sandbox = await LangSmithSandbox.create({ templateName: "default" });
 *
 * try {
 *   const agent = createDeepAgent({
 *     model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *     systemPrompt: "You are a coding assistant.",
 *     middlewares: [
 *       createFilesystemMiddleware({
 *         backend: createLangSmithSandboxFactoryFromSandbox(sandbox),
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
export function createLangSmithSandboxFactoryFromSandbox(
  sandbox: LangSmithSandbox,
): BackendFactory {
  return () => sandbox;
}
