/* oxlint-disable no-instanceof/no-instanceof */
/**
 * Vercel Sandbox implementation of the SandboxBackendProtocol.
 *
 * This module provides a Vercel Sandbox backend for deepagents, enabling agents
 * to execute commands, read and write files, and manage isolated Linux
 * environments using the Vercel Sandbox SDK.
 *
 * @packageDocumentation
 */

import { Sandbox, type CommandFinished } from "@vercel/sandbox";
import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from "deepagents";

import { VercelSandboxError, type VercelSandboxOptions } from "./types.js";

/**
 * Default maximum duration for command execution, in milliseconds.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Maximum number of output bytes returned by {@link VercelSandbox.execute}.
 */
export const MAX_OUTPUT_BYTES = 100_000;

type VercelGetOptions = NonNullable<Parameters<typeof Sandbox.get>[0]>;
type VercelGetOrCreateOptions = NonNullable<
  Parameters<typeof Sandbox.getOrCreate>[0]
>;
type VercelRuntimeOptions = {
  commandTimeoutMs?: number;
  initialFiles?: Record<string, string | Uint8Array>;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function normalizeTimeoutMs(value: number): number {
  if (value < 0) {
    throw new VercelSandboxError(
      `commandTimeoutMs must be non-negative, got ${value}`,
      "INVALID_OPTIONS",
    );
  }
  return value;
}

function truncateOutput(output: string): {
  output: string;
  truncated: boolean;
} {
  const encoded = textEncoder.encode(output);
  if (encoded.byteLength <= MAX_OUTPUT_BYTES) {
    return { output, truncated: false };
  }

  const truncated = textDecoder.decode(encoded.slice(0, MAX_OUTPUT_BYTES));
  return {
    output: `${truncated}\n\n... Output truncated at ${MAX_OUTPUT_BYTES} bytes.`,
    truncated: true,
  };
}

/**
 * Vercel Sandbox backend for deepagents.
 *
 * Extends `BaseSandbox` to provide command execution, file operations, and
 * sandbox lifecycle management using the Vercel Sandbox SDK.
 *
 * ## Basic Usage
 *
 * ```typescript
 * import { VercelSandbox } from "@langchain/vercel-sandbox";
 *
 * const sandbox = await VercelSandbox.create({
 *   runtime: "node24",
 * });
 *
 * try {
 *   const result = await sandbox.execute("node --version");
 *   console.log(result.output);
 * } finally {
 *   await sandbox.close();
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
 *   model,
 *   backend: sandbox,
 * });
 * ```
 */
export class VercelSandbox extends BaseSandbox {
  #sandbox: Sandbox | null = null;

  #options: VercelSandboxOptions;

  #id: string;

  #commandTimeoutMs: number;

  /**
   * Get the unique name for this sandbox.
   *
   * Before initialization, returns a temporary name. After initialization,
   * returns the name assigned by Vercel.
   */
  get id(): string {
    return this.#id;
  }

  /**
   * Get the underlying Vercel Sandbox SDK instance.
   *
   * @throws {VercelSandboxError} If the sandbox is not initialized
   *
   * @example
   * ```typescript
   * const sandbox = await VercelSandbox.create();
   * const vercelSandbox = sandbox.instance;
   * ```
   */
  get instance(): Sandbox {
    if (!this.#sandbox) {
      throw new VercelSandboxError(
        "Sandbox not initialized. Call initialize() or use VercelSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#sandbox;
  }

  /**
   * Check whether the sandbox is initialized and has not reached a terminal
   * state.
   */
  get isRunning(): boolean {
    if (!this.#sandbox) {
      return false;
    }

    try {
      return !["stopped", "failed", "aborted"].includes(this.#sandbox.status);
    } catch {
      return true;
    }
  }

  /**
   * Create a new VercelSandbox wrapper.
   *
   * This does not provision a sandbox unless an existing SDK sandbox is
   * supplied in `options.sandbox`. Call {@link initialize} to provision one,
   * or use {@link VercelSandbox.create}.
   *
   * @param options - Sandbox creation and runtime options
   *
   * @example
   * ```typescript
   * const sandbox = new VercelSandbox({ commandTimeoutMs: 60_000 });
   * await sandbox.initialize();
   * ```
   */
  constructor(options: VercelSandboxOptions = {}) {
    super();

    this.#options = { ...options };
    this.#commandTimeoutMs = normalizeTimeoutMs(
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    );
    this.#id = `vercel-sandbox-${Date.now()}`;

    if (options.sandbox) {
      this.#setFromExisting(options.sandbox);
    }
  }

  /**
   * Provision a new Vercel Sandbox.
   *
   * Sandboxes are disposable by default unless `persistent: true` is supplied.
   * Any configured `initialFiles` are uploaded after provisioning.
   *
   * @throws {VercelSandboxError} If the wrapper is already initialized
   * @throws {VercelSandboxError} If sandbox creation or initial upload fails
   *
   * @example
   * ```typescript
   * const sandbox = new VercelSandbox();
   * await sandbox.initialize();
   * console.log(sandbox.id);
   * ```
   */
  async initialize(): Promise<void> {
    if (this.#sandbox) {
      throw new VercelSandboxError(
        "Sandbox is already initialized. Each VercelSandbox instance can only be initialized once.",
        "ALREADY_INITIALIZED",
      );
    }

    try {
      const createOptions = this.#createOptionsWithDisposableDefault();
      this.#sandbox = await Sandbox.create(createOptions);
      this.#id = this.#sandbox.name;

      if (this.#options.initialFiles) {
        await this.#uploadInitialFiles(this.#options.initialFiles);
      }
    } catch (error) {
      if (VercelSandboxError.isInstance(error)) {
        throw error;
      }
      throw new VercelSandboxError(
        `Failed to create Vercel Sandbox: ${error instanceof Error ? error.message : String(error)}`,
        "SANDBOX_CREATION_FAILED",
        error instanceof Error ? error : undefined,
      );
    }
  }

  #createOptionsWithDisposableDefault(): NonNullable<
    Parameters<typeof Sandbox.create>[0]
  > {
    const createOptions = { ...this.#options };
    delete createOptions.sandbox;
    delete createOptions.commandTimeoutMs;
    delete createOptions.initialFiles;

    return {
      ...createOptions,
      persistent: createOptions.persistent ?? false,
    };
  }

  async #uploadInitialFiles(
    files: Record<string, string | Uint8Array>,
  ): Promise<void> {
    const fileEntries: Array<[string, Uint8Array]> = Object.entries(files).map(
      ([path, content]) => [
        path,
        typeof content === "string" ? textEncoder.encode(content) : content,
      ],
    );

    const results = await this.uploadFiles(fileEntries);
    const errors = results.filter((result) => result.error !== null);
    if (errors.length > 0) {
      const errorPaths = errors
        .map((result) => `${result.path}: ${result.error}`)
        .join(", ");
      throw new VercelSandboxError(
        `Failed to upload initial files: ${errorPaths}`,
        "FILE_OPERATION_FAILED",
      );
    }
  }

  /**
   * Execute a shell command in the sandbox.
   *
   * Commands run through `bash -lc`. Standard error is appended to standard
   * output inside `<stderr>` tags, and combined output is truncated after
   * {@link MAX_OUTPUT_BYTES}.
   *
   * @param command - Shell command to execute
   * @returns Execution output, exit code, and truncation status
   * @throws {VercelSandboxError} If the sandbox is not initialized or command
   * execution fails
   *
   * @example
   * ```typescript
   * const result = await sandbox.execute("echo 'Hello World'");
   * console.log(result.output);
   * console.log(result.exitCode);
   * ```
   */
  async execute(command: string): Promise<ExecuteResponse> {
    const sandbox = this.instance;
    const commandTimeoutMs = this.#commandTimeoutMs;

    let finishedCommand: CommandFinished;
    try {
      finishedCommand = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", command],
        ...(commandTimeoutMs > 0 ? { timeoutMs: commandTimeoutMs } : {}),
      });
    } catch (error) {
      throw new VercelSandboxError(
        `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
        "COMMAND_FAILED",
        error instanceof Error ? error : undefined,
      );
    }

    try {
      const stdout = (await finishedCommand.stdout()) ?? "";
      const stderr = (await finishedCommand.stderr()) ?? "";
      let output = stdout;
      if (stderr.trim()) {
        output += `\n<stderr>${stderr.trim()}</stderr>`;
      }

      const truncated = truncateOutput(output);
      return {
        output: truncated.output,
        exitCode: finishedCommand.exitCode ?? 0,
        truncated: truncated.truncated,
      };
    } catch {
      return {
        output: "<output unavailable: failed to fetch command logs>",
        exitCode: finishedCommand.exitCode ?? 0,
        truncated: false,
      };
    }
  }

  /**
   * Upload files to the sandbox.
   *
   * Relative paths are resolved against the sandbox's working directory
   * (`sandbox.cwd`), which is typically `/vercel/sandbox` for standard runtime
   * sandboxes. Vercel writes all files as a single batch; if the batch fails,
   * each file receives the mapped error.
   *
   * @param files - Array of path and binary content tuples
   * @returns One upload result per input file
   *
   * @example
   * ```typescript
   * const content = new TextEncoder().encode("console.log('Hello')");
   * const results = await sandbox.uploadFiles([
   *   ["index.js", content],
   * ]);
   * ```
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    if (files.length === 0) {
      return [];
    }

    const sandbox = this.instance;
    const results: FileUploadResponse[] = files.map(([path]) => ({
      path,
      error: null,
    }));

    try {
      await sandbox.writeFiles(
        files.map(([path, content]) => ({ path, content })),
      );
    } catch (error) {
      const mapped = this.#mapError(error);
      for (const result of results) {
        result.error = mapped;
      }
    }

    return results;
  }

  /**
   * Download files from the sandbox.
   *
   * Relative paths are resolved against the sandbox's working directory
   * (`sandbox.cwd`).
   *
   * Files are read individually, so successful results are returned even when
   * other requested paths fail.
   *
   * @param paths - File paths to download
   * @returns One download result per requested path
   *
   * @example
   * ```typescript
   * const [result] = await sandbox.downloadFiles(["index.js"]);
   * if (result.content) {
   *   console.log(new TextDecoder().decode(result.content));
   * }
   * ```
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const sandbox = this.instance;
    const results: FileDownloadResponse[] = [];

    for (const path of paths) {
      try {
        const content = await sandbox.readFileToBuffer({ path });
        if (content === null) {
          results.push({
            path,
            content: null,
            error: "file_not_found",
          });
        } else {
          results.push({
            path,
            content: new Uint8Array(content),
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
   * Delete the sandbox and release its resources.
   *
   * This is an alias for {@link delete}.
   */
  async close(): Promise<void> {
    await this.delete();
  }

  /**
   * Permanently delete the sandbox.
   *
   * After deletion, this wrapper is no longer initialized.
   */
  async delete(): Promise<void> {
    if (this.#sandbox) {
      try {
        await this.#sandbox.delete();
      } finally {
        this.#sandbox = null;
      }
    }
  }

  /**
   * Stop the sandbox without deleting it.
   *
   * Persistent sandboxes can be retrieved again using
   * {@link VercelSandbox.fromName}.
   */
  async stop(): Promise<void> {
    if (this.#sandbox) {
      await this.#sandbox.stop();
    }
  }

  #setFromExisting(existingSandbox: Sandbox): void {
    this.#sandbox = existingSandbox;
    this.#id = existingSandbox.name;
  }

  #mapError(error: unknown): FileOperationError {
    if (error instanceof Error) {
      const errorWithCode = error as Error & { code?: string };
      const code = errorWithCode.code?.toLowerCase();
      const message = error.message.toLowerCase();

      if (
        code === "enoent" ||
        message.includes("not found") ||
        message.includes("no such file") ||
        message.includes("enoent")
      ) {
        return "file_not_found";
      }
      if (
        code === "eacces" ||
        code === "eperm" ||
        message.includes("permission") ||
        message.includes("forbidden") ||
        message.includes("access denied") ||
        message.includes("eacces") ||
        message.includes("eperm")
      ) {
        return "permission_denied";
      }
      if (
        code === "eisdir" ||
        message.includes("is a directory") ||
        message.includes("eisdir")
      ) {
        return "is_directory";
      }
    }

    return "invalid_path";
  }

  /**
   * Create or wrap an initialized VercelSandbox in one step.
   *
   * When `options.sandbox` is provided, the existing SDK sandbox is wrapped
   * instead of provisioning a new one. Configured `initialFiles` are uploaded
   * in either case.
   *
   * @param options - Sandbox creation and runtime options
   * @returns An initialized sandbox wrapper
   *
   * @example
   * ```typescript
   * const sandbox = await VercelSandbox.create({
   *   commandTimeoutMs: 60_000,
   *   initialFiles: {
   *     "README.md": "# Project",
   *   },
   * });
   * ```
   */
  static async create(options?: VercelSandboxOptions): Promise<VercelSandbox> {
    const sandbox = new VercelSandbox(options);
    if (options?.sandbox) {
      if (options.initialFiles) {
        await sandbox.#uploadInitialFiles(options.initialFiles);
      }
      return sandbox;
    }

    await sandbox.initialize();
    return sandbox;
  }

  /**
   * Retrieve a named sandbox or create it when it does not exist.
   *
   * Options accepted by the Vercel SDK's `Sandbox.getOrCreate()` method pass
   * through directly. `commandTimeoutMs` configures this wrapper, while
   * `initialFiles` are uploaded only when the SDK creates a new sandbox.
   *
   * @param options - Vercel get-or-create options and wrapper runtime options
   * @returns A wrapper around the retrieved or newly created sandbox
   *
   * @example
   * ```typescript
   * const sandbox = await VercelSandbox.getOrCreate({
   *   name: "agent-workspace",
   *   initialFiles: {
   *     "task.txt": "Inspect the repository",
   *   },
   * });
   * ```
   */
  static async getOrCreate(
    options?: VercelGetOrCreateOptions & VercelRuntimeOptions,
  ): Promise<VercelSandbox> {
    const commandTimeoutMs = normalizeTimeoutMs(
      options?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    );
    const sdkOptions: Partial<VercelGetOrCreateOptions & VercelRuntimeOptions> =
      { ...(options ?? {}) };
    const initialFiles = sdkOptions.initialFiles;
    const userOnCreate = sdkOptions.onCreate;
    delete sdkOptions.commandTimeoutMs;
    delete sdkOptions.initialFiles;

    const sdkSandbox = await Sandbox.getOrCreate({
      ...sdkOptions,
      onCreate: async (createdSandbox) => {
        if (userOnCreate) {
          await userOnCreate(createdSandbox);
        }
        if (initialFiles) {
          const wrapper = new VercelSandbox({
            sandbox: createdSandbox,
            commandTimeoutMs,
          });
          await wrapper.#uploadInitialFiles(initialFiles);
        }
      },
    } as VercelGetOrCreateOptions);

    return new VercelSandbox({ sandbox: sdkSandbox, commandTimeoutMs });
  }

  /**
   * Retrieve an existing Vercel Sandbox by name.
   *
   * @param name - Name of the existing sandbox
   * @param options - Vercel retrieval options and command timeout
   * @returns A wrapper around the existing sandbox
   * @throws {VercelSandboxError} If the sandbox cannot be retrieved
   *
   * @example
   * ```typescript
   * const sandbox = await VercelSandbox.fromName("agent-workspace");
   * const result = await sandbox.execute("pwd");
   * ```
   */
  static async fromName(
    name: string,
    options?: Omit<VercelGetOptions, "name"> & { commandTimeoutMs?: number },
  ): Promise<VercelSandbox> {
    const commandTimeoutMs = normalizeTimeoutMs(
      options?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    );
    const sdkOptions = { ...options };
    delete sdkOptions.commandTimeoutMs;

    try {
      const sdkSandbox = await Sandbox.get({ ...sdkOptions, name });
      return new VercelSandbox({ sandbox: sdkSandbox, commandTimeoutMs });
    } catch (error) {
      throw new VercelSandboxError(
        `Sandbox not found: ${name}`,
        "SANDBOX_NOT_FOUND",
        error instanceof Error ? error : undefined,
      );
    }
  }
}
