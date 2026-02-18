import type {
  MaybePromise,
  FileUploadResponse,
  SandboxBackendProtocol,
  FileDownloadResponse,
} from "deepagents";

/**
 * Interface for sandbox instances used in standard tests.
 *
 * Extends the canonical `SandboxBackendProtocol` from deepagents with
 * test-specific properties (`isRunning`, `initialize`) and makes
 * `uploadFiles`/`downloadFiles` required (they are optional in the
 * base protocol).
 */
export interface SandboxInstance extends SandboxBackendProtocol {
  /** Whether the sandbox is currently running */
  readonly isRunning: boolean;
  /** Upload multiple files (required for standard tests) */
  uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): MaybePromise<FileUploadResponse[]>;
  /** Download multiple files (required for standard tests) */
  downloadFiles(paths: string[]): MaybePromise<FileDownloadResponse[]>;
  /** Optional two-step initialization */
  initialize?(): Promise<void>;
}

/**
 * Configuration for the standard sandbox test suite.
 *
 * @typeParam T - The concrete sandbox type (e.g., ModalSandbox, DenoSandbox)
 */
export interface StandardTestsConfig<
  T extends SandboxInstance = SandboxInstance,
> {
  /**
   * Display name for the test suite (e.g., "ModalSandbox", "DenoSandbox").
   */
  name: string;

  /**
   * Skip all tests when true (e.g., when credentials are missing).
   */
  skip?: boolean;

  /**
   * Run tests sequentially to avoid concurrency limits.
   */
  sequential?: boolean;

  /**
   * Timeout for each test in milliseconds.
   * @default 120_000
   */
  timeout?: number;

  /**
   * Factory function to create a new sandbox instance.
   *
   * The test suite passes `initialFiles` with paths already resolved via
   * `resolvePath`. The implementation should pass them through to the
   * provider's create method.
   *
   * `initialFiles` values are always strings (not Uint8Array) in the
   * standard tests.
   */
  createSandbox: (options?: {
    initialFiles?: Record<string, string>;
  }) => Promise<T>;

  /**
   * Optional factory for creating an uninitialized sandbox for the
   * two-step initialization test. If omitted, the test is skipped.
   */
  createUninitializedSandbox?: () => T;

  /**
   * Close / cleanup a sandbox instance.
   */
  closeSandbox?: (sandbox: T) => Promise<void>;

  /**
   * Convert a relative file path (e.g., `"test-file.txt"`) to the
   * provider-specific absolute or working-directory path
   * (e.g., `"/tmp/test-file.txt"` or just `"test-file.txt"`).
   */
  resolvePath: (relativePath: string) => string;
}
