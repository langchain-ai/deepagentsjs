/* eslint-disable no-instanceof/no-instanceof */
/**
 * Node.js VFS Sandbox implementation of the SandboxBackendProtocol.
 *
 * This module provides an in-memory virtual file system backend for deepagents,
 * enabling agents to work with files in an isolated environment without touching
 * the real filesystem.
 *
 * Uses the node-vfs-polyfill package which implements the upcoming Node.js VFS
 * feature (nodejs/node#61478).
 *
 * @packageDocumentation
 */

import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileInfo,
  type FileOperationError,
  type FileUploadResponse,
  type GrepMatch,
  type BackendFactory,
} from "deepagents";

import { VirtualFileSystem } from "node-vfs-polyfill";

import { VfsSandboxError, type VfsSandboxOptions } from "./types.js";

/**
 * Node.js VFS Sandbox backend for deepagents.
 *
 * Provides an in-memory virtual file system for agent operations, allowing
 * agents to read/write files without affecting the real filesystem.
 *
 * This implementation uses node-vfs-polyfill which implements the upcoming
 * Node.js VFS feature. Files are stored in-memory using the VFS, and when
 * command execution is needed, files are synced to a temp directory.
 *
 * ## Basic Usage
 *
 * ```typescript
 * import { VfsSandbox } from "@langchain/node-vfs";
 *
 * // Create and initialize a VFS sandbox
 * const sandbox = await VfsSandbox.create({
 *   initialFiles: {
 *     "/src/index.js": "console.log('Hello')",
 *   },
 * });
 *
 * try {
 *   // Execute commands
 *   const result = await sandbox.execute("node src/index.js");
 *   console.log(result.output);
 * } finally {
 *   await sandbox.stop();
 * }
 * ```
 *
 * ## Using with DeepAgent
 *
 * ```typescript
 * import { createDeepAgent } from "deepagents";
 * import { VfsSandbox } from "@langchain/node-vfs";
 *
 * const sandbox = await VfsSandbox.create();
 *
 * const agent = createDeepAgent({
 *   model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *   systemPrompt: "You are a coding assistant with VFS access.",
 *   backend: sandbox,
 * });
 * ```
 */
export class VfsSandbox extends BaseSandbox {
  /** Private reference to the VirtualFileSystem instance */
  #vfs?: VirtualFileSystem;

  /** Configuration options for this sandbox */
  #options: VfsSandboxOptions;

  /** Unique identifier for this sandbox instance */
  #id: string;

  /** The working directory path (virtual) */
  #workingDirectory: string;

  /** Temp directory for command execution */
  #tempDir?: string;

  /** Whether the sandbox is initialized */
  #initialized = false;

  /**
   * Get the unique identifier for this sandbox.
   */
  get id(): string {
    return this.#id;
  }

  /**
   * Get the VirtualFileSystem instance.
   */
  get instance(): VirtualFileSystem {
    if (!this.#vfs) {
      throw new VfsSandboxError(
        "VFS not initialized. Call initialize() or use VfsSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#vfs;
  }

  /**
   * Get the working directory path.
   */
  get workingDirectory(): string {
    return this.#workingDirectory;
  }

  /**
   * Check if the sandbox is initialized and running.
   */
  get isRunning(): boolean {
    return this.#initialized;
  }

  /**
   * Check if VFS mode is active (vs temp directory fallback).
   */
  get isVfsMode(): boolean {
    return this.#vfs !== null;
  }

  /**
   * Create a new VfsSandbox instance.
   *
   * Note: This only creates the instance. Call `initialize()` to actually
   * set up the VFS, or use the static `VfsSandbox.create()` method.
   *
   * @param options - Configuration options for the sandbox
   */
  constructor(options: VfsSandboxOptions = {}) {
    super();

    this.#options = {
      timeout: 30000,
      ...options,
    };

    this.#id = `vfs-sandbox-${Date.now()}`;
    this.#workingDirectory = "/workspace";
  }

  /**
   * Initialize the VFS sandbox.
   *
   * This method sets up the virtual file system and populates it with
   * any initial files specified in the options.
   *
   * @throws {VfsSandboxError} If already initialized (`ALREADY_INITIALIZED`)
   * @throws {VfsSandboxError} If initialization fails (`INITIALIZATION_FAILED`)
   */
  async initialize(): Promise<void> {
    if (this.#initialized) {
      throw new VfsSandboxError(
        "VFS Sandbox is already initialized.",
        "ALREADY_INITIALIZED",
      );
    }

    // Create VFS instance
    this.#vfs = new VirtualFileSystem();

    // Create the root workspace directory
    this.#vfs.mkdirSync(this.#workingDirectory, { recursive: true });

    // Populate initial files if provided
    if (this.#options.initialFiles) {
      for (const [filePath, content] of Object.entries(
        this.#options.initialFiles,
      )) {
        const fullPath = path.posix.join(this.#workingDirectory, filePath);
        const parentDir = path.posix.dirname(fullPath);

        // Ensure parent directory exists
        this.#vfs.mkdirSync(parentDir, { recursive: true });

        // Write the file
        const data =
          typeof content === "string" ? content : Buffer.from(content);
        this.#vfs.writeFileSync(fullPath, data);
      }
    }

    this.#initialized = true;
  }

  /**
   * Sync VFS contents to a temp directory for command execution.
   * Creates the temp directory if it doesn't exist.
   */
  async #syncToTempDir(): Promise<string> {
    // Create temp directory if needed
    if (!this.#tempDir) {
      this.#tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vfs-exec-"));
    }

    // Recursively copy VFS contents to temp directory
    await this.#syncDirToTemp(this.#workingDirectory, this.#tempDir);

    return this.#tempDir;
  }

  /**
   * Recursively sync a VFS directory to the temp directory.
   */
  async #syncDirToTemp(vfsPath: string, tempPath: string): Promise<void> {
    // Ensure temp directory exists
    fs.mkdirSync(tempPath, { recursive: true });

    // Read VFS directory
    const entries = this.instance.readdirSync(vfsPath, { withFileTypes: true });

    for (const entry of entries) {
      const vfsEntryPath = path.posix.join(vfsPath, entry.name);
      const tempEntryPath = path.join(tempPath, entry.name);

      if (entry.isDirectory()) {
        await this.#syncDirToTemp(vfsEntryPath, tempEntryPath);
      } else {
        const content = this.instance.readFileSync(vfsEntryPath);
        fs.writeFileSync(tempEntryPath, content);
      }
    }
  }

  /**
   * Sync temp directory contents back to VFS after command execution.
   */
  async #syncFromTempDir(): Promise<void> {
    if (!this.#tempDir) {
      return;
    }

    await this.#syncDirFromTemp(this.#tempDir, this.#workingDirectory);
  }

  /**
   * Recursively sync a temp directory to the VFS.
   */
  async #syncDirFromTemp(tempPath: string, vfsPath: string): Promise<void> {
    // Ensure VFS directory exists
    this.instance.mkdirSync(vfsPath, { recursive: true });

    // Read temp directory
    const entries = fs.readdirSync(tempPath, { withFileTypes: true });

    for (const entry of entries) {
      const tempEntryPath = path.join(tempPath, entry.name);
      const vfsEntryPath = path.posix.join(vfsPath, entry.name);

      if (entry.isDirectory()) {
        await this.#syncDirFromTemp(tempEntryPath, vfsEntryPath);
      } else {
        const content = fs.readFileSync(tempEntryPath);
        this.instance.writeFileSync(vfsEntryPath, content);
      }
    }
  }

  /**
   * Execute a command in the sandbox.
   *
   * Commands are run using `/bin/bash -c` in the sandbox working directory.
   * When using VFS mode, files are synced to a temp directory before execution
   * and synced back after.
   *
   * @param command - The shell command to execute
   * @returns Execution result with output, exit code, and truncation flag
   * @throws {VfsSandboxError} If the sandbox is not initialized
   */
  async execute(command: string): Promise<ExecuteResponse> {
    this.#ensureInitialized();

    // Sync VFS to temp directory for command execution
    const execDir = await this.#syncToTempDir();

    return new Promise((resolve) => {
      const chunks: string[] = [];
      let truncated = false;
      const maxOutputBytes = 1024 * 1024; // 1MB output limit
      let totalBytes = 0;

      const child = cp.spawn("/bin/bash", ["-c", command], {
        cwd: execDir,
        env: { ...process.env, HOME: process.env.HOME },
      });

      const collectOutput = (data: Buffer) => {
        const str = data.toString();
        totalBytes += data.byteLength;

        if (totalBytes <= maxOutputBytes) {
          chunks.push(str);
        } else {
          truncated = true;
        }
      };

      child.stdout.on("data", collectOutput);
      child.stderr.on("data", collectOutput);

      // Handle timeout
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        // Sync back before resolving
        this.#syncFromTempDir().then(() => {
          resolve({
            output: chunks.join("") + "\n[Command timed out]",
            exitCode: null,
            truncated,
          });
        });
      }, this.#options.timeout);

      child.on("close", (exitCode) => {
        clearTimeout(timer);
        // Sync files back from temp directory to VFS
        this.#syncFromTempDir().then(() => {
          resolve({
            output: chunks.join(""),
            exitCode,
            truncated,
          });
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          output: `Error spawning process: ${err.message}`,
          exitCode: 1,
          truncated: false,
        });
      });
    });
  }

  /**
   * Upload files to the sandbox.
   *
   * Files are written to the VFS.
   * Parent directories are created automatically if they don't exist.
   *
   * @param files - Array of [path, content] tuples to upload
   * @returns Upload result for each file, with success or error status
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    this.#ensureInitialized();
    const results: FileUploadResponse[] = [];

    for (const [filePath, content] of files) {
      try {
        const fullPath = path.posix.join(this.#workingDirectory, filePath);
        const parentDir = path.posix.dirname(fullPath);

        // Ensure parent directory exists
        this.instance.mkdirSync(parentDir, { recursive: true });
        this.instance.writeFileSync(fullPath, Buffer.from(content));

        results.push({ path: filePath, error: null });
      } catch (error) {
        results.push({ path: filePath, error: this.#mapError(error) });
      }
    }

    return results;
  }

  /**
   * Download files from the sandbox.
   *
   * @param paths - Array of file paths to download
   * @returns Download result for each file, with content or error
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    this.#ensureInitialized();
    const results: FileDownloadResponse[] = [];

    for (const filePath of paths) {
      try {
        const fullPath = path.posix.join(this.#workingDirectory, filePath);

        if (!this.instance.existsSync(fullPath)) {
          results.push({
            path: filePath,
            content: null,
            error: "file_not_found",
          });
          continue;
        }

        const stat = this.instance.statSync(fullPath);
        if (stat.isDirectory()) {
          results.push({
            path: filePath,
            content: null,
            error: "is_directory",
          });
          continue;
        }

        const content = this.instance.readFileSync(fullPath) as Buffer;
        results.push({
          path: filePath,
          content: new Uint8Array(content),
          error: null,
        });
      } catch (error) {
        results.push({
          path: filePath,
          content: null,
          error: this.#mapError(error),
        });
      }
    }

    return results;
  }

  /**
   * Stop the sandbox and release all resources.
   *
   * Cleans up the temp directory used for command execution.
   */
  async stop(): Promise<void> {
    // Clean up temp directory
    if (this.#tempDir) {
      try {
        fs.rmSync(this.#tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      this.#tempDir = undefined;
    }

    // Clear VFS reference
    this.#vfs = undefined;
    this.#initialized = false;
    this.#workingDirectory = "/workspace";
  }

  /**
   * Normalize a user-supplied file path for use in execute()-based operations.
   *
   * Since execute() runs commands in a temp directory, absolute paths like
   * `/src/index.js` would resolve against the real filesystem instead of
   * the sandbox working directory. This method strips the leading `/` so
   * paths resolve relative to the temp directory (cwd of the shell).
   *
   * Both `/src/index.js` and `src/index.js` refer to the same sandbox file.
   */
  #normalizeExecPath(filePath: string): string {
    const stripped = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    return stripped || ".";
  }

  /**
   * Read file content with line numbers.
   *
   * Overrides BaseSandbox.read() to normalize paths with a leading `/`
   * so they resolve correctly in the temp execution directory.
   */
  async read(
    filePath: string,
    offset: number = 0,
    limit: number = 500,
  ): Promise<string> {
    return super.read(this.#normalizeExecPath(filePath), offset, limit);
  }

  /**
   * List files and directories in the specified directory.
   *
   * Overrides BaseSandbox.lsInfo() to normalize paths with a leading `/`
   * so they resolve correctly in the temp execution directory.
   */
  async lsInfo(dirPath: string): Promise<FileInfo[]> {
    return super.lsInfo(this.#normalizeExecPath(dirPath));
  }

  /**
   * Search for a literal text pattern in files.
   *
   * Overrides BaseSandbox.grepRaw() to normalize paths with a leading `/`
   * so they resolve correctly in the temp execution directory.
   */
  async grepRaw(
    pattern: string,
    searchPath: string = "/",
    glob: string | null = null,
  ): Promise<GrepMatch[] | string> {
    return super.grepRaw(pattern, this.#normalizeExecPath(searchPath), glob);
  }

  /**
   * Structured glob matching returning FileInfo objects.
   *
   * Overrides BaseSandbox.globInfo() to normalize paths with a leading `/`
   * so they resolve correctly in the temp execution directory.
   */
  async globInfo(
    pattern: string,
    searchPath: string = "/",
  ): Promise<FileInfo[]> {
    return super.globInfo(pattern, this.#normalizeExecPath(searchPath));
  }

  /**
   * Ensure the sandbox is initialized before operations.
   */
  #ensureInitialized(): void {
    if (!this.#initialized) {
      throw new VfsSandboxError(
        "VFS Sandbox not initialized. Call initialize() or use VfsSandbox.create()",
        "NOT_INITIALIZED",
      );
    }
  }

  /**
   * Map errors to standardized FileOperationError codes.
   */
  #mapError(error: unknown): FileOperationError {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT" || msg.includes("not found")) {
        return "file_not_found";
      }
      if (code === "EACCES" || msg.includes("permission")) {
        return "permission_denied";
      }
      if (code === "EISDIR" || msg.includes("directory")) {
        return "is_directory";
      }
    }

    return "invalid_path";
  }

  /**
   * Create and initialize a new VfsSandbox in one step.
   *
   * This is the recommended way to create a sandbox. It combines
   * construction and initialization into a single async operation.
   *
   * @param options - Configuration options for the sandbox
   * @returns An initialized and ready-to-use sandbox
   *
   * @example
   * ```typescript
   * const sandbox = await VfsSandbox.create({
   *   initialFiles: {
   *     "/src/index.js": "console.log('Hello')",
   *   },
   * });
   * ```
   */
  static async create(options?: VfsSandboxOptions): Promise<VfsSandbox> {
    const sandbox = new VfsSandbox(options);
    await sandbox.initialize();
    return sandbox;
  }
}

/**
 * Create a backend factory that creates a new VFS Sandbox per invocation.
 *
 * @param options - Optional configuration for sandbox creation
 * @returns A factory function that creates new sandboxes
 *
 * @example
 * ```typescript
 * import { VfsSandbox, createVfsSandboxFactory } from "@langchain/node-vfs";
 *
 * const factory = createVfsSandboxFactory({
 *   initialFiles: { "/README.md": "# Hello" },
 * });
 *
 * const sandbox = await factory();
 * ```
 */
export function createVfsSandboxFactory(
  options?: VfsSandboxOptions,
): () => Promise<VfsSandbox> {
  return async () => {
    return await VfsSandbox.create(options);
  };
}

/**
 * Create a backend factory that reuses an existing VFS Sandbox.
 *
 * @param sandbox - An existing VfsSandbox instance (must be initialized)
 * @returns A BackendFactory that returns the provided sandbox
 *
 * @example
 * ```typescript
 * const sandbox = await VfsSandbox.create();
 *
 * const agent = createDeepAgent({
 *   model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *   systemPrompt: "You are a coding assistant.",
 *   middlewares: [
 *     createFilesystemMiddleware({
 *       backend: createVfsSandboxFactoryFromSandbox(sandbox),
 *     }),
 *   ],
 * });
 * ```
 */
export function createVfsSandboxFactoryFromSandbox(
  sandbox: VfsSandbox,
): BackendFactory {
  return () => sandbox;
}
