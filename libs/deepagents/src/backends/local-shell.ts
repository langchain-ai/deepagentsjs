/**
 * LocalShellBackend: Filesystem backend with unrestricted local shell execution.
 *
 * This backend extends FilesystemBackend to add shell command execution on the local
 * host system. It provides NO sandboxing or isolation - all operations run directly
 * on the host machine with full system access.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { FilesystemBackend } from "./filesystem.js";
import type { ExecuteResponse, SandboxBackendProtocol } from "./protocol.js";

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
 * const result = backend.execute("ls -la");
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
    this.#sandboxId = `local-${randomBytes(4).toString("hex")}`;

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

  /**
   * Execute a shell command directly on the host system.
   *
   * Commands are executed directly on your host system using `spawnSync()`
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
  execute(command: string): ExecuteResponse {
    if (!command || typeof command !== "string") {
      return {
        output: "Error: Command must be a non-empty string.",
        exitCode: 1,
        truncated: false,
      };
    }

    try {
      const result = spawnSync(command, {
        shell: true,
        timeout: this.#timeout * 1000,
        env: this.#env,
        cwd: this.cwd,
        encoding: "utf-8",
        maxBuffer: this.#maxOutputBytes * 2,
      });

      // Handle timeout (spawnSync kills the process and sets signal)
      if (result.signal === "SIGTERM" || result.error?.message?.includes("ETIMEDOUT")) {
        return {
          output: `Error: Command timed out after ${this.#timeout.toFixed(1)} seconds.`,
          exitCode: 124,
          truncated: false,
        };
      }

      // Combine stdout and stderr, prefix stderr lines with [stderr]
      const outputParts: string[] = [];
      if (result.stdout) {
        outputParts.push(result.stdout);
      }
      if (result.stderr) {
        const stderrLines = result.stderr.trim().split("\n");
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

      const exitCode = result.status ?? 1;

      if (exitCode !== 0) {
        output = `${output.trimEnd()}\n\nExit code: ${exitCode}`;
      }

      return {
        output,
        exitCode,
        truncated,
      };
    } catch (e: unknown) {
      const err = e as { message?: string };
      const message = err.message ?? String(e);
      return {
        output: `Error executing command: ${message}`,
        exitCode: 1,
        truncated: false,
      };
    }
  }
}
