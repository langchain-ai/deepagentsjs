/**
 * LangSmith Sandbox backend for deepagents.
 *
 * @example
 * ```typescript
 * import { LangSmithSandbox, createDeepAgent } from "deepagents";
 *
 * const sandbox = await LangSmithSandbox.create({ templateName: "deepagents-cli" });
 *
 * const agent = createDeepAgent({ model, backend: sandbox });
 *
 * try {
 *   await agent.invoke({ messages: [...] });
 * } finally {
 *   await sandbox.close();
 * }
 * ```
 *
 * @module
 */

import {
  type Sandbox,
  type CreateSandboxOptions,
  LangSmithResourceNotFoundError,
  LangSmithSandboxError,
  SandboxClient,
} from "langsmith/experimental/sandbox";
import { BaseSandbox } from "./sandbox.js";
import type {
  ExecuteResponse,
  FileDownloadResponse,
  FileOperationError,
  FileUploadResponse,
} from "./protocol.js";

/** Options for constructing a LangSmithSandbox from an existing Sandbox instance. */
export interface LangSmithSandboxOptions {
  /** An already-created LangSmith Sandbox instance to wrap. */
  sandbox: Sandbox;
  /**
   * Default command timeout in seconds.
   * @default 1800 (30 minutes)
   */
  defaultTimeout?: number;
}

/** Options for the `LangSmithSandbox.create()` static factory. */
export interface LangSmithSandboxCreateOptions extends Omit<
  CreateSandboxOptions,
  "name" | "timeout" | "waitForReady"
> {
  /**
   * Name of the LangSmith sandbox template to use.
   * @default "deepagents"
   */
  templateName?: string;
  /**
   * LangSmith API key. Defaults to the `LANGSMITH_API_KEY` environment variable.
   */
  apiKey?: string;
  /**
   * Default command timeout in seconds.
   * @default 1800 (30 minutes)
   */
  defaultTimeout?: number;
}

/**
 * LangSmith Sandbox backend for deepagents.
 *
 * Extends `BaseSandbox` to provide command execution and file operations
 * via the LangSmith Sandbox API.
 *
 * Use the static `LangSmithSandbox.create()` factory for the simplest setup,
 * or construct directly with an existing `Sandbox` instance.
 *
 * @experimental This feature is experimental, and breaking changes are expected.
 */
export class LangSmithSandbox extends BaseSandbox {
  #sandbox: Sandbox;
  #defaultTimeout: number;
  #isRunning = true;

  constructor(options: LangSmithSandboxOptions) {
    super();
    this.#sandbox = options.sandbox;
    this.#defaultTimeout = options.defaultTimeout ?? 30 * 60; // 30 minutes
  }

  /** Whether the sandbox is currently active. */
  get isRunning(): boolean {
    return this.#isRunning;
  }

  /** Return the LangSmith sandbox name as the unique identifier. */
  get id(): string {
    return this.#sandbox.name;
  }

  /**
   * Execute a shell command in the LangSmith sandbox.
   *
   * @param command - Shell command string to execute
   * @param options.timeout - Override timeout in seconds; 0 disables timeout
   */
  async execute(
    command: string,
    options?: { timeout?: number },
  ): Promise<ExecuteResponse> {
    const effectiveTimeout =
      options?.timeout !== undefined ? options.timeout : this.#defaultTimeout;

    const result = await this.#sandbox.run(command, {
      timeout: effectiveTimeout,
    });

    const out = result.stdout ?? "";
    const combined = result.stderr
      ? out
        ? `${out}\n${result.stderr}`
        : result.stderr
      : out;

    return {
      output: combined,
      exitCode: result.exit_code,
      truncated: false,
    };
  }

  /**
   * Download files from the sandbox using LangSmith's native file read API.
   * @param paths - List of file paths to download
   * @returns List of FileDownloadResponse objects, one per input path
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const responses: FileDownloadResponse[] = [];

    for (const path of paths) {
      try {
        const content = await this.#sandbox.read(path);
        responses.push({ path, content, error: null });
      } catch (err) {
        // oxlint-disable-next-line no-instanceof/no-instanceof
        if (err instanceof LangSmithResourceNotFoundError) {
          responses.push({ path, content: null, error: "file_not_found" });
          // oxlint-disable-next-line no-instanceof/no-instanceof
        } else if (err instanceof LangSmithSandboxError) {
          const msg = String(err.message).toLowerCase();
          const error: FileOperationError = msg.includes("is a directory")
            ? "is_directory"
            : "file_not_found";
          responses.push({ path, content: null, error });
        } else {
          responses.push({ path, content: null, error: "invalid_path" });
        }
      }
    }

    return responses;
  }

  /**
   * Upload files to the sandbox using LangSmith's native file write API.
   * @param files - List of [path, content] tuples to upload
   * @returns List of FileUploadResponse objects, one per input file
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const responses: FileUploadResponse[] = [];

    for (const [path, content] of files) {
      try {
        await this.#sandbox.write(path, content);
        responses.push({ path, error: null });
      } catch {
        responses.push({ path, error: "permission_denied" });
      }
    }

    return responses;
  }

  /**
   * Delete this sandbox and mark it as no longer running.
   *
   * After calling this, `isRunning` will be `false` and the sandbox
   * cannot be used again.
   */
  async close(): Promise<void> {
    await this.#sandbox.delete();
    this.#isRunning = false;
  }

  /**
   * Create and return a new LangSmithSandbox in one step.
   *
   * This is the recommended way to create a sandbox — no need to import
   * anything from `langsmith/experimental/sandbox` directly.
   *
   * @example
   * ```typescript
   * const sandbox = await LangSmithSandbox.create({ templateName: "deepagents" });
   * try {
   *   const agent = createDeepAgent({ model, backend: sandbox });
   *   await agent.invoke({ messages: [...] });
   * } finally {
   *   await sandbox.close();
   * }
   * ```
   */
  static async create(
    options: LangSmithSandboxCreateOptions = {},
  ): Promise<LangSmithSandbox> {
    const {
      templateName = "deepagents",
      apiKey = process.env.LANGSMITH_API_KEY,
      defaultTimeout,
      ...createSandboxOptions
    } = options;

    const client = new SandboxClient({ apiKey });
    const sandbox = await client.createSandbox(
      templateName,
      createSandboxOptions,
    );
    return new LangSmithSandbox({ sandbox, defaultTimeout });
  }
}
