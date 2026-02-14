/* eslint-disable no-instanceof/no-instanceof */
import crypto from "node:crypto";

import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from "deepagents";

import { WasixSandboxError, type WasixBackendOptions } from "./types.js";
import {
  initEngine,
  createRuntime,
  executeCommand,
  isEngineInitialized,
  type WasmRuntimeHandle,
} from "./engine.js";
import { createFsCallbacks } from "./fs-callbacks.js";

/**
 * WASIX execution backend for deepagents.
 *
 * Provides an in-process sandbox using a WASM-based execution engine.
 * File operations use an in-memory virtual filesystem; command execution
 * delegates to the Rust WASM engine.
 *
 * Use the static `WasixBackend.create()` factory method to create instances.
 */
export class WasixBackend extends BaseSandbox {
  readonly #id: string;
  readonly #options: WasixBackendOptions;

  /** In-memory virtual filesystem (stub for direct memory FS) */
  readonly #fs = new Map<string, Uint8Array>();

  /** Track directories for path validation */
  readonly #dirs = new Set<string>(["/", "/workspace"]);

  /** WASM runtime handle (null when engine is not available) */
  #runtimeHandle: WasmRuntimeHandle | null = null;

  #initialized = false;

  get id(): string {
    return this.#id;
  }

  /**
   * Private constructor — use `WasixBackend.create()` instead.
   */
  private constructor(options: WasixBackendOptions) {
    super();
    this.#id = `wasix-${crypto.randomUUID()}`;
    this.#options = { timeout: 30000, ...options };
  }

  /**
   * Create and initialize a new WasixBackend.
   */
  static async create(
    options: WasixBackendOptions = {},
  ): Promise<WasixBackend> {
    const backend = new WasixBackend(options);
    await backend.initialize();
    return backend;
  }

  /**
   * Initialize the WASIX backend.
   * Loads the WASM engine and creates a runtime with filesystem callbacks.
   */
  async initialize(): Promise<void> {
    if (this.#initialized) {
      throw new WasixSandboxError(
        "WASIX backend is already initialized.",
        "ALREADY_INITIALIZED",
      );
    }

    // Packages will be used when the full wasmer-wasix runtime is integrated
    void this.#options;

    try {
      await initEngine();
      const callbacks = createFsCallbacks(this.#fs, this.#dirs);
      this.#runtimeHandle = createRuntime(callbacks);
    } catch (err) {
      // If WASM isn't available, proceed without it — execute() will
      // return a stub response. This allows uploadFiles/downloadFiles
      // to work even without the WASM engine.
      if (
        err instanceof WasixSandboxError &&
        err.code === "WASM_ENGINE_NOT_INITIALIZED"
      ) {
        this.#runtimeHandle = null;
      } else {
        throw err;
      }
    }

    this.#initialized = true;
  }

  /**
   * Execute a command in the WASIX sandbox.
   *
   * Delegates to the Rust WASM engine when available, otherwise returns a
   * stub response indicating the engine is not loaded.
   */
  async execute(command: string): Promise<ExecuteResponse> {
    this.#ensureInitialized();

    if (!isEngineInitialized() || this.#runtimeHandle === null) {
      return {
        output: `[WASIX stub] Command received: ${command}\nWASM engine not yet initialized.`,
        exitCode: 1,
        truncated: false,
      };
    }

    const result = executeCommand(command);
    return {
      output: result.output,
      exitCode: result.exit_code,
      truncated: result.truncated,
    };
  }

  /**
   * Upload files to the in-memory virtual filesystem.
   * Parent directories are created automatically.
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    this.#ensureInitialized();
    const results: FileUploadResponse[] = [];

    for (const [filePath, content] of files) {
      try {
        const normalized = this.#normalizePath(filePath);
        this.#ensureParentDirs(normalized);
        this.#fs.set(normalized, new Uint8Array(content));
        results.push({ path: filePath, error: null });
      } catch (error) {
        results.push({ path: filePath, error: this.#mapError(error) });
      }
    }

    return results;
  }

  /**
   * Download files from the in-memory virtual filesystem.
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    this.#ensureInitialized();
    const results: FileDownloadResponse[] = [];

    for (const filePath of paths) {
      const normalized = this.#normalizePath(filePath);

      if (this.#dirs.has(normalized)) {
        results.push({ path: filePath, content: null, error: "is_directory" });
        continue;
      }

      const content = this.#fs.get(normalized);
      if (content === undefined) {
        results.push({
          path: filePath,
          content: null,
          error: "file_not_found",
        });
        continue;
      }

      results.push({
        path: filePath,
        content: new Uint8Array(content),
        error: null,
      });
    }

    return results;
  }

  /**
   * Release resources. Safe to call multiple times.
   */
  close(): void {
    if (this.#runtimeHandle !== null) {
      try {
        this.#runtimeHandle.free();
      } catch {
        // Ignore errors during cleanup (handle may already be freed)
      }
      this.#runtimeHandle = null;
    }
    this.#fs.clear();
    this.#dirs.clear();
    this.#initialized = false;
  }

  // --- Private helpers ---

  #ensureInitialized(): void {
    if (!this.#initialized) {
      throw new WasixSandboxError(
        "WASIX backend not initialized. Use WasixBackend.create().",
        "NOT_INITIALIZED",
      );
    }
  }

  #normalizePath(filePath: string): string {
    // Ensure leading slash for consistency
    return filePath.startsWith("/") ? filePath : `/${filePath}`;
  }

  #ensureParentDirs(filePath: string): void {
    const parts = filePath.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += `/${parts[i]}`;
      this.#dirs.add(current);
    }
  }

  #mapError(error: unknown): FileOperationError {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes("not found")) return "file_not_found";
      if (msg.includes("permission")) return "permission_denied";
      if (msg.includes("directory")) return "is_directory";
    }
    return "invalid_path";
  }
}
