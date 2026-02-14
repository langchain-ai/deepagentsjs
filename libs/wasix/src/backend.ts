/* eslint-disable no-instanceof/no-instanceof */
import crypto from "node:crypto";

import {
  BaseSandbox,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from "deepagents";

import {
  WasixSandboxError,
  type WasixBackendOptions,
  type WasixExecuteResult,
  type SpawnRequest,
} from "./types.js";

// Lazily-loaded @wasmer/sdk bindings (Node.js entry point)
type WasmerSdk = typeof import("@wasmer/sdk/node");
type WasmerPkg = Awaited<
  ReturnType<(typeof import("@wasmer/sdk/node"))["Wasmer"]["fromRegistry"]>
>;
type WasmerDirectory = import("@wasmer/sdk/node").Directory;

/**
 * WASIX execution backend.
 *
 * Provides an in-process sandbox using a WASM-based execution engine.
 * File operations use an in-memory virtual filesystem; command execution
 * delegates to the `@wasmer/sdk` WASIX runtime (sharrattj/bash).
 *
 * Use the static `WasixBackend.create()` factory method to create instances.
 */
export class WasixBackend extends BaseSandbox {
  readonly #id: string;
  readonly #options: WasixBackendOptions;

  /** In-memory virtual filesystem */
  readonly #fs = new Map<string, Uint8Array>();

  /** Track directories for path validation */
  readonly #dirs = new Set<string>(["/", "/workspace"]);

  /** Lazily-loaded @wasmer/sdk module */
  #sdk: WasmerSdk | null = null;

  /** Loaded bash package from the Wasmer registry */
  #wasmerPkg: WasmerPkg | null = null;

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
   * Loads the @wasmer/sdk runtime and fetches the bash package from the registry.
   */
  async initialize(): Promise<void> {
    if (this.#initialized) {
      throw new WasixSandboxError(
        "WASIX backend is already initialized.",
        "ALREADY_INITIALIZED",
      );
    }

    void this.#options;

    try {
      this.#sdk = await import("@wasmer/sdk/node");
      await this.#sdk.init();
      this.#wasmerPkg = await this.#sdk.Wasmer.fromRegistry("sharrattj/bash");
    } catch {
      // If the SDK cannot load (e.g. missing native dependencies, no network),
      // mark as initialized but without execution capability. execute() will
      // throw; uploadFiles/downloadFiles still work against the in-memory FS.
      this.#sdk = null;
      this.#wasmerPkg = null;
    }

    this.#initialized = true;
  }

  /**
   * Execute a command in the WASIX sandbox.
   *
   * Uses the @wasmer/sdk to run bash with the given command.
   * Files from the in-memory FS are mounted into the WASIX instance,
   * and any file changes are synced back after execution.
   */
  async execute(command: string): Promise<WasixExecuteResult> {
    this.#ensureInitialized();

    if (this.#sdk === null || this.#wasmerPkg === null) {
      throw new WasixSandboxError(
        "WASIX runtime not available. @wasmer/sdk failed to initialize.",
        "WASM_ENGINE_NOT_INITIALIZED",
      );
    }

    const entrypoint = this.#wasmerPkg.entrypoint;
    if (!entrypoint) {
      throw new WasixSandboxError(
        "Bash package has no entrypoint.",
        "WASM_ENGINE_FAILED",
      );
    }

    // Build a Directory from the in-memory FS
    const dir = new this.#sdk.Directory();
    for (const [path, data] of this.#fs) {
      // Ensure parent directories exist in the Directory
      const parts = path.split("/").filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        const parentDir = "/" + parts.slice(0, i).join("/");
        try {
          await dir.createDir(parentDir);
        } catch {
          // Directory may already exist — ignore
        }
      }
      await dir.writeFile(path, data);
    }

    // Run bash -c <command> with the directory mounted at /work
    // Provide empty stdin to prevent bash from waiting for input.
    const instance = await entrypoint.run({
      args: ["-c", command],
      mount: { "/work": dir },
      cwd: "/work",
      stdin: "",
    });

    const output = await instance.wait();

    // Sync files back from the Directory to the in-memory Map
    await this.#syncDirectoryToFs(dir, "/");

    // Scan for RPC spawn requests and clean them up
    const spawnRequests = this.#collectSpawnRequests();

    return {
      output: output.stdout + output.stderr,
      exitCode: output.code,
      truncated: false,
      spawnRequests,
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
    if (this.#wasmerPkg !== null) {
      try {
        this.#wasmerPkg.free();
      } catch {
        // Ignore errors during cleanup (handle may already be freed)
      }
      this.#wasmerPkg = null;
    }
    this.#sdk = null;
    this.#fs.clear();
    this.#dirs.clear();
    this.#initialized = false;
  }

  // --- Private helpers ---

  /**
   * Recursively walk a @wasmer/sdk Directory and sync all files back into
   * the in-memory Map (and directories into the Set).
   */
  async #syncDirectoryToFs(
    dir: WasmerDirectory,
    prefix: string,
  ): Promise<void> {
    const entries = await dir.readDir(prefix);
    for (const entry of entries) {
      const fullPath =
        prefix === "/" ? `/${entry.name}` : `${prefix}/${entry.name}`;
      if (entry.type === "dir") {
        this.#dirs.add(fullPath);
        await this.#syncDirectoryToFs(dir, fullPath);
      } else if (entry.type === "file") {
        const data = await dir.readFile(fullPath);
        this.#ensureParentDirs(fullPath);
        this.#fs.set(fullPath, data);
      }
    }
  }

  /**
   * Scan the in-memory FS for RPC spawn requests in `/.rpc/requests/`,
   * parse them, and delete the files so they aren't re-processed.
   */
  #collectSpawnRequests(): SpawnRequest[] {
    const RPC_PREFIX = "/.rpc/requests/";
    const requests: SpawnRequest[] = [];

    for (const [path, data] of this.#fs) {
      if (path.startsWith(RPC_PREFIX) && path.endsWith(".json")) {
        try {
          const text = new TextDecoder().decode(data);
          const parsed = JSON.parse(text) as SpawnRequest;
          // Basic validation: ensure required fields exist
          if (
            typeof parsed.id === "string" &&
            parsed.method === "spawn" &&
            typeof parsed.args?.task === "string" &&
            typeof parsed.timestamp === "string"
          ) {
            requests.push(parsed);
          }
        } catch {
          // Ignore malformed JSON files
        }
      }
    }

    // Clean up processed request files
    for (const req of requests) {
      this.#fs.delete(`${RPC_PREFIX}${req.id}.json`);
    }

    return requests;
  }

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
