/**
 * LocalShellBackend: Node.js implementation of the filesystem backend with unrestricted local shell execution.
 *
 * This backend extends FilesystemBackend to add shell command execution on the local
 * host system. It provides NO sandboxing or isolation - all operations run directly
 * on the host machine with full system access.
 *
 * @module
 */

import cp from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

import { FilesystemBackend } from "./filesystem.js";
import type {
  EditResult,
  ExecuteResponse,
  FileInfo,
  SandboxBackendProtocol,
} from "./protocol.js";
import { SandboxError } from "./protocol.js";

/**
 * Options for creating a LocalShellBackend instance.
 */
export interface LocalShellBackendOptions {
  /**
   * Working directory for both filesystem operations and shell commands.
   * @defaultValue `process.cwd()`
   */
  rootDir?: string;

  /**
   * Enable virtual path mode for filesystem operations.
   * When true, treats rootDir as a virtual root filesystem.
   * Does NOT restrict shell commands.
   * @defaultValue `false`
   */
  virtualMode?: boolean;

  /**
   * Maximum time in seconds to wait for shell command execution.
   * Commands exceeding this timeout will be terminated.
   * @defaultValue `120`
   */
  timeout?: number;

  /**
   * Maximum number of bytes to capture from command output.
   * Output exceeding this limit will be truncated.
   * @defaultValue `100_000`
   */
  maxOutputBytes?: number;

  /**
   * Environment variables for shell commands. If undefined, starts with an empty
   * environment (unless inheritEnv is true).
   * @defaultValue `undefined`
   */
  env?: Record<string, string>;

  /**
   * Whether to inherit the parent process's environment variables.
   * When false, only variables in env dict are available.
   * When true, inherits all process.env variables and applies env overrides.
   * @defaultValue `false`
   */
  inheritEnv?: boolean;

  /**
   * Files to create on disk during `create()`.
   * Keys are file paths (resolved via the backend's path handling),
   * values are string content.
   * @defaultValue `undefined`
   */
  initialFiles?: Record<string, string>;
}

/**
 * Filesystem backend with unrestricted local shell command execution.
 *
 * This backend extends FilesystemBackend to add shell command execution
 * capabilities. Commands are executed directly on the host system without any
 * sandboxing, process isolation, or security restrictions.
 *
 * **Security Warning:**
 * This backend grants agents BOTH direct filesystem access AND unrestricted
 * shell execution on your local machine. Use with extreme caution and only in
 * appropriate environments.
 *
 * **Appropriate use cases:**
 * - Local development CLIs (coding assistants, development tools)
 * - Personal development environments where you trust the agent's code
 * - CI/CD pipelines with proper secret management
 *
 * **Inappropriate use cases:**
 * - Production environments (e.g., web servers, APIs, multi-tenant systems)
 * - Processing untrusted user input or executing untrusted code
 *
 * Use StateBackend, StoreBackend, or extend BaseSandbox for production.
 *
 * @example
 * ```typescript
 * import { LocalShellBackend } from "@langchain/deepagents";
 *
 * // Create backend with explicit environment
 * const backend = new LocalShellBackend({
 *   rootDir: "/home/user/project",
 *   env: { PATH: "/usr/bin:/bin" },
 * });
 *
 * // Execute shell commands (runs directly on host)
 * const result = await backend.execute("ls -la");
 * console.log(result.output);
 * console.log(result.exitCode);
 *
 * // Use filesystem operations (inherited from FilesystemBackend)
 * const content = await backend.read("/README.md");
 * await backend.write("/output.txt", "Hello world");
 *
 * // Inherit all environment variables
 * const backend2 = new LocalShellBackend({
 *   rootDir: "/home/user/project",
 *   inheritEnv: true,
 * });
 * ```
 */
export class LocalShellBackend
  extends FilesystemBackend
  implements SandboxBackendProtocol
{
  #timeout: number;
  #maxOutputBytes: number;
  #env: Record<string, string>;
  #sandboxId: string;
  #initialized = false;

  constructor(options: LocalShellBackendOptions = {}) {
    const {
      rootDir,
      virtualMode = false,
      timeout = 120,
      maxOutputBytes = 100_000,
      env,
      inheritEnv = false,
    } = options;

    super({ rootDir, virtualMode, maxFileSizeMb: 10 });

    this.#timeout = timeout;
    this.#maxOutputBytes = maxOutputBytes;
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    this.#sandboxId = `local-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

    if (inheritEnv) {
      this.#env = { ...process.env } as Record<string, string>;
      if (env) {
        Object.assign(this.#env, env);
      }
    } else {
      this.#env = env ?? {};
    }
  }

  /** Unique identifier for this backend instance (format: "local-{random_hex}"). */
  get id(): string {
    return this.#sandboxId;
  }

  /** Whether the backend has been initialized and is ready to use. */
  get isInitialized(): boolean {
    return this.#initialized;
  }

  /** Alias for `isInitialized`, matching the standard sandbox interface. */
  get isRunning(): boolean {
    return this.#initialized;
  }

  /**
   * Initialize the backend by ensuring the rootDir exists.
   *
   * Creates the rootDir (and any parent directories) if it does not already
   * exist. Safe to call on an existing directory. Must be called before
   * `execute()`, or use the static `LocalShellBackend.create()` factory.
   *
   * @throws {SandboxError} If already initialized (`ALREADY_INITIALIZED`)
   */
  async initialize(): Promise<void> {
    if (this.#initialized) {
      throw new SandboxError(
        "Backend is already initialized. Each LocalShellBackend instance can only be initialized once.",
        "ALREADY_INITIALIZED",
      );
    }
    await fs.mkdir(this.cwd, { recursive: true });
    this.#initialized = true;
  }

  /**
   * Mark the backend as no longer running.
   *
   * For local shell backends there is no remote resource to tear down,
   * so this simply flips the `isRunning` / `isInitialized` flag.
   */
  async close(): Promise<void> {
    this.#initialized = false;
  }

  /**
   * Read a file, adapting error messages to the standard sandbox format.
   */
  override async read(
    filePath: string,
    offset: number = 0,
    limit: number = 500,
  ): Promise<string> {
    const result = await super.read(filePath, offset, limit);
    if (
      typeof result === "string" &&
      result.startsWith("Error reading file") &&
      result.includes("ENOENT")
    ) {
      return `Error: File '${filePath}' not found`;
    }
    return result;
  }

  /**
   * Edit a file, adapting error messages to the standard sandbox format.
   */
  override async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): Promise<EditResult> {
    const result = await super.edit(filePath, oldString, newString, replaceAll);
    if (result.error?.includes("ENOENT")) {
      return { ...result, error: `Error: File '${filePath}' not found` };
    }
    return result;
  }

  /**
   * List directory contents, returning paths relative to rootDir.
   */
  override async lsInfo(dirPath: string): Promise<FileInfo[]> {
    const results = await super.lsInfo(dirPath);
    if (this.virtualMode) {
      return results;
    }
    const cwdPrefix = this.cwd.endsWith(path.sep)
      ? this.cwd
      : this.cwd + path.sep;
    return results.map((info) => ({
      ...info,
      path: info.path.startsWith(cwdPrefix)
        ? info.path.slice(cwdPrefix.length)
        : info.path,
    }));
  }

  /**
   * Glob matching that returns relative paths and includes directories.
   */
  override async globInfo(
    pattern: string,
    searchPath: string = "/",
  ): Promise<FileInfo[]> {
    if (pattern.startsWith("/")) {
      pattern = pattern.substring(1);
    }

    const resolvedSearchPath =
      searchPath === "/" || searchPath === ""
        ? this.cwd
        : this.virtualMode
          ? path.resolve(this.cwd, searchPath.replace(/^\//, ""))
          : path.resolve(this.cwd, searchPath);

    try {
      const stat = await fs.stat(resolvedSearchPath);
      if (!stat.isDirectory()) return [];
    } catch {
      return [];
    }

    const formatPath = (rel: string) => (this.virtualMode ? `/${rel}` : rel);

    const globOpts = { cwd: resolvedSearchPath, absolute: false, dot: true };
    const [fileMatches, dirMatches] = await Promise.all([
      fg(pattern, { ...globOpts, onlyFiles: true }),
      fg(pattern, { ...globOpts, onlyDirectories: true }),
    ]);

    const statFile = async (match: string): Promise<FileInfo | null> => {
      try {
        const entryStat = await fs.stat(path.join(resolvedSearchPath, match));
        if (entryStat.isFile()) {
          return {
            path: formatPath(match),
            is_dir: false,
            size: entryStat.size,
            modified_at: entryStat.mtime.toISOString(),
          };
        }
      } catch {
        /* skip unstatable entries */
      }
      return null;
    };

    const statDir = async (match: string): Promise<FileInfo | null> => {
      try {
        const entryStat = await fs.stat(path.join(resolvedSearchPath, match));
        if (entryStat.isDirectory()) {
          return {
            path: formatPath(match),
            is_dir: true,
            size: 0,
            modified_at: entryStat.mtime.toISOString(),
          };
        }
      } catch {
        /* skip unstatable entries */
      }
      return null;
    };

    const [fileInfos, dirInfos] = await Promise.all([
      Promise.all(fileMatches.map(statFile)),
      Promise.all(dirMatches.map(statDir)),
    ]);

    const results = [...fileInfos, ...dirInfos].filter(
      (info): info is FileInfo => info !== null,
    );
    results.sort((a, b) => a.path.localeCompare(b.path));
    return results;
  }

  /**
   * Execute a shell command directly on the host system.
   *
   * Commands are executed directly on your host system using `spawn()`
   * with `shell: true`. There is NO sandboxing, isolation, or security
   * restrictions. The command runs with your user's full permissions.
   *
   * The command is executed using the system shell with the working directory
   * set to the backend's rootDir. Stdout and stderr are combined into a single
   * output stream, with stderr lines prefixed with `[stderr]`.
   *
   * @param command - Shell command string to execute
   * @returns ExecuteResponse containing output, exit code, and truncation flag
   */
  async execute(command: string): Promise<ExecuteResponse> {
    if (!command || typeof command !== "string") {
      return {
        output: "Error: Command must be a non-empty string.",
        exitCode: 1,
        truncated: false,
      };
    }

    return new Promise<ExecuteResponse>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const child = cp.spawn(command, {
        shell: true,
        env: this.#env,
        cwd: this.cwd,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.#timeout * 1000);

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          output: `Error executing command: ${err.message}`,
          exitCode: 1,
          truncated: false,
        });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);

        if (timedOut || signal === "SIGTERM") {
          resolve({
            output: `Error: Command timed out after ${this.#timeout.toFixed(1)} seconds.`,
            exitCode: 124,
            truncated: false,
          });
          return;
        }

        const outputParts: string[] = [];
        if (stdout) {
          outputParts.push(stdout);
        }
        if (stderr) {
          const stderrLines = stderr.trim().split("\n");
          outputParts.push(
            ...stderrLines.map((line: string) => `[stderr] ${line}`),
          );
        }

        let output =
          outputParts.length > 0 ? outputParts.join("\n") : "<no output>";

        let truncated = false;
        if (output.length > this.#maxOutputBytes) {
          output = output.slice(0, this.#maxOutputBytes);
          output += `\n\n... Output truncated at ${this.#maxOutputBytes} bytes.`;
          truncated = true;
        }

        const exitCode = code ?? 1;

        if (exitCode !== 0) {
          output = `${output.trimEnd()}\n\nExit code: ${exitCode}`;
        }

        resolve({
          output,
          exitCode,
          truncated,
        });
      });
    });
  }

  /**
   * Create and initialize a new LocalShellBackend in one step.
   *
   * This is the recommended way to create a backend when the rootDir may
   * not exist yet. It combines construction and initialization (ensuring
   * rootDir exists) into a single async operation.
   *
   * @param options - Configuration options for the backend
   * @returns An initialized and ready-to-use backend
   */
  static async create(
    options: LocalShellBackendOptions = {},
  ): Promise<LocalShellBackend> {
    const { initialFiles, ...backendOptions } = options;
    const backend = new LocalShellBackend(backendOptions);
    await backend.initialize();

    if (initialFiles) {
      const encoder = new TextEncoder();
      const files: Array<[string, Uint8Array]> = Object.entries(
        initialFiles,
      ).map(([filePath, content]) => [filePath, encoder.encode(content)]);
      await backend.uploadFiles(files);
    }

    return backend;
  }
}
