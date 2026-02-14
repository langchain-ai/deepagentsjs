import {
  SandboxError,
  type SandboxErrorCode,
  type ExecuteResponse,
  type BackendProtocol,
} from "deepagents";

/**
 * An interactive shell session with streaming I/O.
 * Created via `WasixBackend.shell()`.
 */
export interface WasixShellSession {
  /** Writable stream for sending input to the shell */
  readonly stdin: WritableStream;
  /** Readable stream of shell stdout */
  readonly stdout: ReadableStream;
  /** Readable stream of shell stderr */
  readonly stderr: ReadableStream;
  /** Wait for the shell to exit. Returns the exit code. */
  wait(): Promise<{ exitCode: number }>;
  /** Convenience: write a line to stdin (appends newline) */
  writeLine(line: string): Promise<void>;
  /** Kill the shell process */
  kill(): void;
}

/**
 * An RPC request written by the subagent CLI inside the WASIX sandbox.
 * Files are written to `/.rpc/requests/<id>.json`.
 */
export interface SpawnRequest {
  id: string;
  method: "spawn";
  args: { task: string };
  timestamp: string;
}

/**
 * Extended execute result that includes any spawn requests found
 * in the `/.rpc/requests/` directory after command execution.
 */
export interface WasixExecuteResult extends ExecuteResponse {
  spawnRequests: SpawnRequest[];
}

/**
 * Configuration options for creating a WASIX Sandbox backend.
 */
export interface WasixBackendOptions {
  /**
   * List of standard WASIX packages to install (e.g., ["bash", "coreutils"]).
   * These are fetched from the Wasmer registry.
   */
  packages?: string[];

  /**
   * Custom packages to install, specified as name-to-URL mappings.
   * URLs should point to .wasm files or Wasmer package identifiers.
   */
  customPackages?: Record<string, string>;

  /**
   * Local packages to load, specified as name-to-path mappings.
   * Paths are resolved relative to the working directory.
   */
  localPackages?: Record<string, string>;

  /**
   * Command execution timeout in milliseconds.
   * @default 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Mount external backends into the WASIX sandbox.
   *
   * Each key is a mount path (e.g. "/work", "/memories") and each value
   * is a BackendProtocol that provides files for that mount point.
   *
   * When provided, the in-memory Map is NOT used — all filesystem state
   * comes from the mounted backends. When omitted, falls back to the
   * default in-memory filesystem mounted at "/work".
   */
  mounts?: Record<string, BackendProtocol>;
}

/**
 * Error codes for WASIX Sandbox operations.
 */
export type WasixSandboxErrorCode =
  | SandboxErrorCode
  | "WASM_ENGINE_NOT_INITIALIZED"
  | "WASM_ENGINE_FAILED";

const WASIX_SANDBOX_ERROR_SYMBOL = Symbol.for("wasix.sandbox.error");

/**
 * Custom error class for WASIX Sandbox operations.
 */
export class WasixSandboxError extends SandboxError {
  [WASIX_SANDBOX_ERROR_SYMBOL] = true as const;

  override readonly name = "WasixSandboxError";

  constructor(
    message: string,
    public readonly code: WasixSandboxErrorCode,
    public readonly cause?: Error,
  ) {
    super(message, code as SandboxErrorCode, cause);
    Object.setPrototypeOf(this, WasixSandboxError.prototype);
  }

  static isInstance(error: unknown): error is WasixSandboxError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[WASIX_SANDBOX_ERROR_SYMBOL] === true
    );
  }
}
