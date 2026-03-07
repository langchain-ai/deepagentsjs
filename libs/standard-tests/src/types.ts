import type {
  MaybePromise,
  FileUploadResponse,
  SandboxBackendProtocol,
  FileDownloadResponse,
} from "deepagents";

/* ------------------------------------------------------------------ */
/*  Test-runner primitives                                             */
/* ------------------------------------------------------------------ */

/** A `describe` / suite function accepted by the standard tests. */
export interface SuiteFn {
  (name: string, fn: () => void): void;
  skip?: SuiteFn;
  sequential?: SuiteFn;
  skipIf?: (condition: boolean) => SuiteFn;
}

/** An `it` / test function accepted by the standard tests. */
export interface TestFn {
  (name: string, fn: () => void | Promise<void>, timeout?: number): void;
  skipIf?: (condition: boolean) => TestFn;
}

/** A `beforeAll` / `afterAll` hook function. */
export type HookFn = (fn: () => void | Promise<void>, timeout?: number) => void;

/**
 * An `expect` function.
 *
 * The return type is intentionally `any` — every test framework exposes
 * its own matcher API and fully typing it would couple the package to a
 * specific runner.
 */
export type ExpectFn = (value: unknown) => any;

/**
 * Test-runner primitives required by the standard test suite.
 *
 * Pass the primitives from your test framework (Vitest, Jest, …) when
 * importing from the root entry point.  The `@langchain/sandbox-standard-tests/vitest`
 * sub-export fills these in automatically.
 */
export interface TestRunner {
  describe: SuiteFn;
  it: TestFn;
  expect: ExpectFn;
  beforeAll: HookFn;
  afterAll: HookFn;
}

/* ------------------------------------------------------------------ */
/*  Sandbox types                                                      */
/* ------------------------------------------------------------------ */

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
   * Test-runner primitives (`describe`, `it`, `expect`, `beforeAll`, `afterAll`).
   *
   * Required when importing from the root entry point.  Pre-filled when
   * importing from `@langchain/sandbox-standard-tests/vitest`.
   */
  runner: TestRunner;

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
