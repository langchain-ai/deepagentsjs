/* oxlint-disable no-instanceof/no-instanceof */
/**
 * Sprites Sandbox implementation of the SandboxBackendProtocol.
 *
 * This module provides a Fly.io Sprites backend for deepagents, enabling
 * agents to execute commands, read/write files, and manage isolated sandbox
 * environments using Sprites' infrastructure.
 *
 * @packageDocumentation
 */

import { randomBytes } from "node:crypto";

import {
  SpritesClient,
  Sprite,
  ExecError,
  FilesystemError,
  type Checkpoint,
} from "@fly/sprites";
import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
  type BackendFactory,
} from "deepagents";

import { getAuthCredentials } from "./auth.js";
import { SpritesSandboxError, type SpritesSandboxOptions } from "./types.js";

/** Default working directory inside a Sprite. */
const DEFAULT_WORKDIR = "/home/sprite";

/** Default command timeout in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * Sprites Sandbox backend for deepagents.
 *
 * Extends `BaseSandbox` to provide command execution, file operations, and
 * sandbox lifecycle management using the Fly.io Sprites SDK.
 *
 * Sprites are persistent, named Linux VMs that boot in a couple of seconds,
 * automatically suspend when idle, and support fast checkpoint/restore of
 * their full filesystem and process state.
 *
 * ## Basic Usage
 *
 * ```typescript
 * import { SpritesSandbox } from "@langchain/sprites";
 *
 * // Create and initialize a sandbox
 * const sandbox = await SpritesSandbox.create({
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
 * import { SpritesSandbox } from "@langchain/sprites";
 *
 * const sandbox = await SpritesSandbox.create();
 *
 * const agent = createDeepAgent({
 *   model: new ChatAnthropic({ model: "claude-sonnet-4-5" }),
 *   systemPrompt: "You are a coding assistant with sandbox access.",
 *   backend: sandbox,
 * });
 * ```
 */
export class SpritesSandbox extends BaseSandbox {
  /** Private reference to the Sprites client */
  #client: SpritesClient | null = null;

  /** Private reference to the underlying Sprite instance */
  #sprite: Sprite | null = null;

  /** Configuration options for this sandbox */
  #options: SpritesSandboxOptions;

  /** Sprite name — the unique identifier for this sandbox */
  #id: string;

  /** Command execution timeout in milliseconds */
  #timeoutMs: number;

  /** Working directory for commands and relative file paths */
  #workdir: string;

  /**
   * Get the unique identifier for this sandbox.
   *
   * The identifier is the Sprite name, which is stable across suspends and
   * restarts and can be used to reconnect with `SpritesSandbox.fromName()`.
   */
  get id(): string {
    return this.#id;
  }

  /**
   * Get the underlying Sprite instance.
   *
   * @throws {SpritesSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const sandbox = await SpritesSandbox.create();
   * const sprite = sandbox.instance; // Access the raw SDK Sprite
   * ```
   */
  get instance(): Sprite {
    if (!this.#sprite) {
      throw new SpritesSandboxError(
        "Sandbox not initialized. Call initialize() or use SpritesSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#sprite;
  }

  /**
   * Get the underlying Sprites client instance.
   *
   * @throws {SpritesSandboxError} If the client is not initialized
   */
  get client(): SpritesClient {
    if (!this.#client) {
      throw new SpritesSandboxError(
        "Sprites client not initialized. Call initialize() or use SpritesSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#client;
  }

  /**
   * Check if the sandbox is initialized.
   */
  get isRunning(): boolean {
    return this.#sprite !== null;
  }

  /**
   * Get the working directory used for commands and relative file paths.
   */
  get workdir(): string {
    return this.#workdir;
  }

  /**
   * Create a new SpritesSandbox instance.
   *
   * Note: This only creates the instance. Call `initialize()` to actually
   * create the Sprite, or use the static `SpritesSandbox.create()` method.
   *
   * @param options - Configuration options for the sandbox
   *
   * @example
   * ```typescript
   * // Two-step initialization
   * const sandbox = new SpritesSandbox({ name: "my-sandbox" });
   * await sandbox.initialize();
   *
   * // Or use the factory method
   * const sandbox = await SpritesSandbox.create({ name: "my-sandbox" });
   * ```
   */
  constructor(options: SpritesSandboxOptions = {}) {
    super();

    this.#options = {
      timeout: DEFAULT_TIMEOUT_SECONDS,
      ...options,
    };

    this.#timeoutMs = (this.#options.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    this.#workdir = this.#options.workdir ?? DEFAULT_WORKDIR;

    // Sprite names are stable identities; generate one if not provided
    this.#id =
      this.#options.name ?? `deepagents-${randomBytes(4).toString("hex")}`;
  }

  /**
   * Initialize the sandbox by creating a new Sprite.
   *
   * This method authenticates with the Sprites API and provisions a new
   * Sprite (typically in 1-2 seconds).
   *
   * @throws {SpritesSandboxError} If already initialized (`ALREADY_INITIALIZED`)
   * @throws {SpritesSandboxError} If authentication fails (`AUTHENTICATION_FAILED`)
   * @throws {SpritesSandboxError} If sandbox creation fails (`SANDBOX_CREATION_FAILED`)
   *
   * @example
   * ```typescript
   * const sandbox = new SpritesSandbox();
   * await sandbox.initialize();
   * console.log(`Sandbox ID: ${sandbox.id}`);
   * ```
   */
  async initialize(): Promise<void> {
    // Prevent double initialization
    if (this.#sprite) {
      throw new SpritesSandboxError(
        "Sandbox is already initialized. Each SpritesSandbox instance can only be initialized once.",
        "ALREADY_INITIALIZED",
      );
    }

    // Get authentication credentials
    let credentials: { token: string; baseURL: string };
    try {
      credentials = getAuthCredentials(this.#options.auth);
    } catch (error) {
      throw new SpritesSandboxError(
        "Failed to authenticate with Sprites. Check your token configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      this.#client = new SpritesClient(credentials.token, {
        baseURL: credentials.baseURL,
      });

      this.#sprite = await this.#client.createSprite(this.#id, {
        ...(this.#options.config && { config: this.#options.config }),
        ...(this.#options.environment && {
          environment: this.#options.environment,
        }),
        ...(this.#options.labels && { labels: this.#options.labels }),
        ...(this.#options.runtime && { runtime: this.#options.runtime }),
        ...(this.#options.waitForCapacity !== undefined && {
          waitForCapacity: this.#options.waitForCapacity,
        }),
      });

      // Upload initial files if provided
      if (this.#options.initialFiles) {
        await this.#uploadInitialFiles(this.#options.initialFiles);
      }
    } catch (error) {
      if (SpritesSandboxError.isInstance(error)) {
        throw error;
      }
      throw new SpritesSandboxError(
        `Failed to create Sprite: ${error instanceof Error ? error.message : String(error)}`,
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
      throw new SpritesSandboxError(
        `Failed to upload initial files: ${errorPaths}`,
        "FILE_OPERATION_FAILED",
      );
    }
  }

  /**
   * Execute a command in the sandbox.
   *
   * Commands are run with `bash -lc` in the sandbox working directory, so
   * shell features (pipes, redirection, globbing) work as expected.
   *
   * @param command - The shell command to execute
   * @returns Execution result with combined output, exit code, and truncation flag
   * @throws {SpritesSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const result = await sandbox.execute("echo 'Hello World'");
   * console.log(result.output); // "Hello World\n"
   * console.log(result.exitCode); // 0
   * ```
   */
  async execute(command: string): Promise<ExecuteResponse> {
    const sprite = this.instance; // Throws if not initialized

    try {
      const result = await sprite.execFile("bash", ["-lc", command], {
        cwd: this.#workdir,
        timeout: this.#timeoutMs,
      });

      return {
        output: `${result.stdout}${result.stderr}`,
        exitCode: result.exitCode ?? 0,
        truncated: false,
      };
    } catch (error) {
      // Non-zero exit codes are reported as results, not errors
      if (error instanceof ExecError) {
        return {
          output: `${error.stdout}${error.stderr}`,
          exitCode: error.exitCode,
          truncated: false,
        };
      }

      // Check for timeout (the SDK rejects with a plain Error on timeout)
      if (error instanceof Error && /timed out/i.test(error.message)) {
        throw new SpritesSandboxError(
          `Command timed out: ${command}`,
          "COMMAND_TIMEOUT",
          error,
        );
      }

      throw new SpritesSandboxError(
        `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
        "COMMAND_FAILED",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Upload files to the sandbox.
   *
   * Files are written via the Sprites filesystem API. Parent directories
   * are created automatically. Relative paths are resolved against the
   * sandbox working directory.
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
    const sprite = this.instance; // Throws if not initialized
    const fs = sprite.filesystem(this.#workdir);
    const results: FileUploadResponse[] = [];

    for (const [path, content] of files) {
      try {
        await fs.writeFile(path, Buffer.from(content));
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
   * files exist and others don't. Relative paths are resolved against the
   * sandbox working directory.
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
    const sprite = this.instance; // Throws if not initialized
    const fs = sprite.filesystem(this.#workdir);
    const results: FileDownloadResponse[] = [];

    for (const path of paths) {
      try {
        const buffer = await fs.readFile(path, null);
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
   * After closing, the sandbox cannot be used again. The Sprite is deleted
   * along with its filesystem and checkpoints.
   *
   * Note: Sprites automatically suspend when idle and cost nothing while
   * suspended, so if you want to reconnect later with
   * `SpritesSandbox.fromName()`, simply don't call `close()`.
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
    if (this.#sprite) {
      try {
        await this.#sprite.delete();
      } finally {
        this.#sprite = null;
        this.#client = null;
      }
    }
  }

  /**
   * Forcefully terminate and delete the sandbox.
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
   * Create a checkpoint of the sandbox's full state.
   *
   * Checkpoints capture the entire filesystem and memory state of the
   * Sprite and typically complete in well under a second. Use `restore()`
   * to roll the sandbox back to a checkpoint.
   *
   * @param comment - Optional comment describing the checkpoint
   * @returns The created checkpoint (including its `id`)
   * @throws {SpritesSandboxError} If the checkpoint fails (`CHECKPOINT_FAILED`)
   *
   * @example
   * ```typescript
   * const checkpoint = await sandbox.checkpoint("before running agent");
   * // ... let the agent make changes ...
   * await sandbox.restore(checkpoint.id);
   * ```
   */
  async checkpoint(comment?: string): Promise<Checkpoint> {
    const sprite = this.instance;

    try {
      const stream = await sprite.createCheckpoint(comment);
      let streamError: string | undefined;
      await stream.processAll((msg) => {
        if (msg.type === "error") {
          streamError = msg.error ?? msg.data ?? "unknown error";
        }
      });
      if (streamError) {
        throw new Error(streamError);
      }

      // The stream doesn't carry the checkpoint id; fetch the newest one.
      const checkpoints = await sprite.listCheckpoints();
      const newest = checkpoints
        .filter((cp) => cp.id !== "Current")
        .sort((a, b) => b.createTime.getTime() - a.createTime.getTime())[0];
      if (!newest) {
        throw new Error("Checkpoint completed but none found");
      }
      return newest;
    } catch (error) {
      if (SpritesSandboxError.isInstance(error)) throw error;
      throw new SpritesSandboxError(
        `Failed to create checkpoint: ${error instanceof Error ? error.message : String(error)}`,
        "CHECKPOINT_FAILED",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Restore the sandbox to a previous checkpoint.
   *
   * Rolls back the entire filesystem and process state.
   *
   * @param checkpointId - The checkpoint id (e.g. `"v3"`) from `checkpoint()`
   *   or `instance.listCheckpoints()`
   * @throws {SpritesSandboxError} If the restore fails (`CHECKPOINT_FAILED`)
   */
  async restore(checkpointId: string): Promise<void> {
    const sprite = this.instance;

    try {
      const stream = await sprite.restoreCheckpoint(checkpointId);
      let streamError: string | undefined;
      await stream.processAll((msg) => {
        if (msg.type === "error") {
          streamError = msg.error ?? msg.data ?? "unknown error";
        }
      });
      if (streamError) {
        throw new Error(streamError);
      }
    } catch (error) {
      throw new SpritesSandboxError(
        `Failed to restore checkpoint '${checkpointId}': ${error instanceof Error ? error.message : String(error)}`,
        "CHECKPOINT_FAILED",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get the working directory path inside the sandbox.
   *
   * @returns The absolute path to the sandbox working directory
   */
  async getWorkDir(): Promise<string> {
    return this.#workdir;
  }

  /**
   * Get the user's home directory path inside the sandbox.
   *
   * @returns The absolute path to the user's home directory
   */
  async getUserHomeDir(): Promise<string> {
    const result = await this.execute('printf "%s" "$HOME"');
    const home = result.output.trim();
    return home || DEFAULT_WORKDIR;
  }

  /**
   * Set the sandbox from an existing Sprite instance.
   * Used internally by the static `fromName()` method.
   */
  #setFromExisting(client: SpritesClient, sprite: Sprite): void {
    this.#client = client;
    this.#sprite = sprite;
    this.#id = sprite.name;
  }

  /**
   * Map Sprites SDK errors to standardized FileOperationError codes.
   *
   * @param error - The error from the Sprites SDK
   * @returns A standardized error code
   */
  #mapError(error: unknown): FileOperationError {
    if (error instanceof FilesystemError) {
      switch (error.code) {
        case "ENOENT":
          return "file_not_found";
        case "EACCES":
        case "EPERM":
          return "permission_denied";
        case "EISDIR":
          return "is_directory";
        // UNKNOWN and other codes carry the raw server error in the
        // message; fall through to message-based matching below.
      }
    }

    if (error instanceof Error) {
      const msg = error.message.toLowerCase();

      // "no such file" must be checked before the directory heuristics:
      // the raw error is "no such file or directory".
      if (
        msg.includes("not found") ||
        msg.includes("no such file") ||
        msg.includes("enoent")
      ) {
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
   * Create and initialize a new SpritesSandbox in one step.
   *
   * This is the recommended way to create a sandbox. It combines
   * construction and initialization into a single async operation.
   *
   * @param options - Configuration options for the sandbox
   * @returns An initialized and ready-to-use sandbox
   *
   * @example
   * ```typescript
   * const sandbox = await SpritesSandbox.create({
   *   config: { ramMB: 2048, cpus: 2 },
   * });
   * ```
   */
  static async create(
    options?: SpritesSandboxOptions,
  ): Promise<SpritesSandbox> {
    const sandbox = new SpritesSandbox(options);
    await sandbox.initialize();
    return sandbox;
  }

  /**
   * Connect to an existing Sprite by name.
   *
   * This allows you to resume working with a sandbox that was created
   * earlier. Suspended Sprites resume automatically on first use.
   *
   * @param name - The name of the Sprite to connect to
   * @param options - Optional configuration (auth, timeout, workdir)
   * @returns A connected sandbox instance
   * @throws {SpritesSandboxError} If the Sprite does not exist (`SANDBOX_NOT_FOUND`)
   *
   * @example
   * ```typescript
   * // Resume a sandbox from a stored name
   * const sandbox = await SpritesSandbox.fromName("my-agent-sandbox");
   * const result = await sandbox.execute("ls -la");
   * ```
   */
  static async fromName(
    name: string,
    options?: Pick<SpritesSandboxOptions, "auth" | "timeout" | "workdir">,
  ): Promise<SpritesSandbox> {
    let credentials: { token: string; baseURL: string };
    try {
      credentials = getAuthCredentials(options?.auth);
    } catch (error) {
      throw new SpritesSandboxError(
        "Failed to authenticate with Sprites. Check your token configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      const client = new SpritesClient(credentials.token, {
        baseURL: credentials.baseURL,
      });

      const existingSprite = await client.getSprite(name);

      const sandbox = new SpritesSandbox({ ...options, name });
      // Set the existing sprite directly (bypass initialize)
      sandbox.#setFromExisting(client, existingSprite);

      return sandbox;
    } catch (error) {
      throw new SpritesSandboxError(
        `Sandbox not found: ${name}`,
        "SANDBOX_NOT_FOUND",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Delete all Sprites whose names start with the given prefix.
   *
   * This is useful for cleaning up stale sandboxes from previous test runs
   * or CI pipelines that may not have shut down cleanly.
   *
   * @param prefix - Name prefix to filter Sprites (e.g. `"ci-deepagents-"`)
   * @param options - Optional auth configuration
   * @returns The number of Sprites that were deleted
   *
   * @example
   * ```typescript
   * const deleted = await SpritesSandbox.deleteAll("ci-deepagents-");
   * console.log(`Deleted ${deleted} stale sandboxes`);
   * ```
   */
  static async deleteAll(
    prefix: string,
    options?: Pick<SpritesSandboxOptions, "auth">,
  ): Promise<number> {
    if (!prefix) {
      throw new SpritesSandboxError(
        "deleteAll requires a non-empty name prefix",
        "COMMAND_FAILED",
      );
    }

    let credentials: { token: string; baseURL: string };
    try {
      credentials = getAuthCredentials(options?.auth);
    } catch (error) {
      throw new SpritesSandboxError(
        "Failed to authenticate with Sprites. Check your token configuration.",
        "AUTHENTICATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    const client = new SpritesClient(credentials.token, {
      baseURL: credentials.baseURL,
    });

    const sprites = await client.listAllSprites(prefix);
    const results = await Promise.all(
      sprites.map((sprite) =>
        sprite
          .delete()
          .then(() => true)
          .catch(() => false),
      ),
    );

    return results.filter(Boolean).length;
  }
}

/**
 * Async factory function type for creating Sprites Sandbox instances.
 *
 * This is similar to BackendFactory but supports async creation,
 * which is required for SpritesSandbox since initialization is async.
 */
export type AsyncSpritesSandboxFactory = () => Promise<SpritesSandbox>;

/**
 * Create an async factory function that creates a new Sprites Sandbox per
 * invocation.
 *
 * Each call to the factory will create and initialize a new sandbox.
 * This is useful when you want fresh, isolated environments for each
 * agent invocation.
 *
 * **Important**: This returns an async factory. For use with middleware that
 * requires a synchronous BackendFactory, use
 * `createSpritesSandboxFactoryFromSandbox()` with a pre-created sandbox
 * instead.
 *
 * Note: options.name is ignored here — each sandbox gets a generated name so
 * repeated invocations don't collide.
 *
 * @param options - Optional configuration for sandbox creation
 * @returns An async factory function that creates new sandboxes
 *
 * @example
 * ```typescript
 * import { createSpritesSandboxFactory } from "@langchain/sprites";
 *
 * const factory = createSpritesSandboxFactory({ timeout: 300 });
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
export function createSpritesSandboxFactory(
  options?: Omit<SpritesSandboxOptions, "name">,
): AsyncSpritesSandboxFactory {
  return async () => {
    return await SpritesSandbox.create(options);
  };
}

/**
 * Create a backend factory that reuses an existing Sprites Sandbox.
 *
 * This allows multiple agent invocations to share the same sandbox,
 * avoiding the (already small) startup overhead of creating new Sprites.
 *
 * Important: You are responsible for managing the sandbox lifecycle
 * (calling `close()` when done, or leaving the Sprite to suspend if you
 * want to reconnect later).
 *
 * @param sandbox - An existing SpritesSandbox instance (must be initialized)
 * @returns A BackendFactory that returns the provided sandbox
 *
 * @example
 * ```typescript
 * import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
 * import {
 *   SpritesSandbox,
 *   createSpritesSandboxFactoryFromSandbox,
 * } from "@langchain/sprites";
 *
 * const sandbox = await SpritesSandbox.create();
 *
 * try {
 *   const agent = createDeepAgent({
 *     model: new ChatAnthropic({ model: "claude-sonnet-4-5" }),
 *     systemPrompt: "You are a coding assistant.",
 *     middlewares: [
 *       createFilesystemMiddleware({
 *         backend: createSpritesSandboxFactoryFromSandbox(sandbox),
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
export function createSpritesSandboxFactoryFromSandbox(
  sandbox: SpritesSandbox,
): BackendFactory {
  return () => sandbox;
}
