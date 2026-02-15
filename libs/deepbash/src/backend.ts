/* eslint-disable no-instanceof/no-instanceof */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  BaseSandbox,
  type BackendProtocol,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from "deepagents";

import load, { Wasmer, Directory, registerLocalPackage, setSdkUrl } from "../rust/runtime/pkg/deepbash_runtime";

import {
  DeepbashError,
  type DeepbashBackendOptions,
  type DeepbashExecuteResult,
  type DeepbashShellSession,
  type SpawnRequest,
} from "./types.js";

type DeepbashPkg = Awaited<ReturnType<typeof Wasmer.fromFile>>;

/**
 * Deepbash execution backend.
 *
 * Provides an in-process sandbox using a WASM-based execution engine.
 * File operations use an in-memory virtual filesystem; command execution
 * delegates to the deepbash WASIX runtime.
 *
 * Use the static `DeepbashBackend.create()` factory method to create instances.
 */
export class DeepbashBackend extends BaseSandbox {
  readonly #id: string;
  readonly #options: DeepbashBackendOptions;

  /** In-memory virtual filesystem */
  readonly #fs = new Map<string, Uint8Array>();

  /** Track directories for path validation */
  readonly #dirs = new Set<string>(["/", "/workspace"]);

  /** External backend mounts (path → BackendProtocol) */
  readonly #mounts: ReadonlyMap<string, BackendProtocol>;

  /** Loaded bash package */
  #wasmerPkg: DeepbashPkg | null = null;

  /** Pre-loaded subagent WASM binary (mounted onto PATH at runtime) */
  #subagentBinary: Uint8Array | null = null;

  #initialized = false;

  get id(): string {
    return this.#id;
  }

  /**
   * Private constructor — use `DeepbashBackend.create()` instead.
   */
  private constructor(options: DeepbashBackendOptions) {
    super();
    this.#id = `deepbash-${crypto.randomUUID()}`;
    this.#options = { timeout: 30000, ...options };
    this.#mounts = new Map(
      options.mounts ? Object.entries(options.mounts) : [],
    );
  }

  /**
   * Create and initialize a new DeepbashBackend.
   */
  static async create(
    options: DeepbashBackendOptions = {},
  ): Promise<DeepbashBackend> {
    const backend = new DeepbashBackend(options);
    await backend.initialize();
    return backend;
  }

  /**
   * Initialize the deepbash backend.
   * Loads the WASM runtime and loads bash from the bundled .webc file.
   */
  async initialize(): Promise<void> {
    if (this.#initialized) {
      throw new DeepbashError(
        "Deepbash backend is already initialized.",
        "ALREADY_INITIALIZED",
      );
    }

    // Polyfill Worker for Node.js (required by the WASM thread pool)
    if (!globalThis.Worker) {
      const { default: Worker } = await import("web-worker");
      globalThis.Worker = Worker;
    }

    const thisDir = path.dirname(fileURLToPath(import.meta.url));

    // Load and initialize the WASM runtime
    const wasmPath = path.join(
      thisDir,
      "..",
      "rust",
      "runtime",
      "pkg",
      "deepbash_runtime_bg.wasm",
    );
    const wasmModule = readFileSync(wasmPath);
    await load({ module_or_path: wasmModule });

    // Set the SDK URL so worker threads can import the runtime via absolute path.
    // Workers run from data URLs and can't resolve relative imports.
    const sdkPath = path.join(
      thisDir,
      "..",
      "rust",
      "runtime",
      "pkg",
      "deepbash_runtime.js",
    );
    setSdkUrl(new URL(`file://${sdkPath}`).href);

    // Register bundled coreutils package for offline dependency resolution
    const coreutilsWebc = readFileSync(
      path.join(thisDir, "..", "assets", "coreutils.webc"),
    );
    registerLocalPackage("wasmer/coreutils@1.0.19", coreutilsWebc);

    // Load bash from the bundled .webc file
    const bashWebc = readFileSync(
      path.join(thisDir, "..", "assets", "bash.webc"),
    );
    this.#wasmerPkg = await Wasmer.fromFile(bashWebc);

    // Load the subagent WASM binary (optional — if missing, subagent commands won't work)
    const subagentPath =
      this.#options.subagentWasmPath ??
      path.join(thisDir, "..", "assets", "subagent.wasm");
    try {
      this.#subagentBinary = readFileSync(subagentPath);
    } catch {
      this.#subagentBinary = null;
    }

    this.#initialized = true;
  }

  /**
   * Execute a command in the WASIX sandbox.
   *
   * Uses the deepbash runtime to run bash with the given command.
   * Files from the in-memory FS are mounted into the WASIX instance,
   * and any file changes are synced back after execution.
   */
  async execute(command: string): Promise<DeepbashExecuteResult> {
    this.#ensureInitialized();

    if (this.#wasmerPkg === null) {
      throw new DeepbashError(
        "Deepbash runtime not available. Failed to initialize.",
        "WASM_ENGINE_NOT_INITIALIZED",
      );
    }

    const entrypoint = this.#wasmerPkg.entrypoint;
    if (!entrypoint) {
      throw new DeepbashError(
        "Bash package has no entrypoint.",
        "WASM_ENGINE_FAILED",
      );
    }

    let mountRecord: Record<string, Directory>;
    let mountSnapshots: Map<string, Map<string, Uint8Array>>;
    const cwd = this.#mounts.size > 0 ? [...this.#mounts.keys()][0] : "/work";

    if (this.#mounts.size > 0) {
      // Mount mode: populate directories from external backends
      const result = await this.#populateMountDirectories();
      mountRecord = result.directories;
      mountSnapshots = result.snapshots;
    } else {
      // Legacy mode: single in-memory FS mounted at /work
      const dir = new Directory();
      await this.#populateDirectoryFromFs(dir);
      mountRecord = { "/work": dir };
      mountSnapshots = new Map();
    }

    // Mount subagent binary onto PATH and RPC spool directory
    const { binDir, rpcDir } = await this.#createSubagentMounts();
    mountRecord["/usr/local/sbin"] = binDir;
    mountRecord["/.rpc"] = rpcDir;

    // Run bash -c <command> with the directory/directories mounted.
    // Provide empty stdin to prevent bash from waiting for input.
    const instance = await entrypoint.run({
      args: ["-c", command],
      mount: mountRecord,
      cwd,
      stdin: "",
    });

    const output = await instance.wait();

    if (this.#mounts.size > 0) {
      // Sync changes back to mounted backends
      await this.#syncMountsBack(mountRecord, mountSnapshots);
    } else {
      // Legacy: sync back to in-memory FS
      await this.#syncDirectoryToFs(mountRecord["/work"], "/");
    }

    // Collect spawn requests from both the /.rpc directory (new subagent
    // function writes here) and the in-memory FS (legacy /work/.rpc path)
    const rpcRequests = await this.#collectSpawnRequestsFromDir(rpcDir);
    const fsRequests = this.#collectSpawnRequests();
    const seenIds = new Set(rpcRequests.map((r) => r.id));
    const spawnRequests = [
      ...rpcRequests,
      ...fsRequests.filter((r) => !seenIds.has(r.id)),
    ];

    return {
      output: output.stdout + output.stderr,
      exitCode: output.code,
      truncated: false,
      spawnRequests,
    };
  }

  /**
   * Start an interactive shell session with streaming I/O.
   *
   * Unlike `execute()` which runs a batch command, `shell()` starts a
   * long-lived bash process and returns stream handles for stdin/stdout/stderr.
   * Files from the in-memory FS are mounted, and changes are synced back
   * when the session ends (via `wait()`).
   */
  async shell(): Promise<DeepbashShellSession> {
    this.#ensureInitialized();

    if (this.#wasmerPkg === null) {
      throw new DeepbashError(
        "Deepbash runtime not available. Failed to initialize.",
        "WASM_ENGINE_NOT_INITIALIZED",
      );
    }

    const entrypoint = this.#wasmerPkg.entrypoint;
    if (!entrypoint) {
      throw new DeepbashError(
        "Bash package has no entrypoint.",
        "WASM_ENGINE_FAILED",
      );
    }

    let mountRecord: Record<string, Directory>;
    let mountSnapshots: Map<string, Map<string, Uint8Array>>;
    const cwd = this.#mounts.size > 0 ? [...this.#mounts.keys()][0] : "/work";

    if (this.#mounts.size > 0) {
      const result = await this.#populateMountDirectories();
      mountRecord = result.directories;
      mountSnapshots = result.snapshots;
    } else {
      const dir = new Directory();
      await this.#populateDirectoryFromFs(dir);
      mountRecord = { "/work": dir };
      mountSnapshots = new Map();
    }

    // Mount subagent binary onto PATH and RPC spool directory
    const { binDir, rpcDir } = await this.#createSubagentMounts();
    mountRecord["/usr/local/sbin"] = binDir;
    mountRecord["/.rpc"] = rpcDir;

    // Start bash WITHOUT stdin — this gives us the WritableStream.
    const instance = await entrypoint.run({
      args: ["-i"],
      mount: mountRecord,
      cwd,
      // No stdin property — leaves instance.stdin as a WritableStream
    });

    if (!instance.stdin) {
      throw new DeepbashError(
        "Failed to get stdin stream for interactive shell.",
        "WASM_ENGINE_FAILED",
      );
    }

    const stdinStream = instance.stdin;
    const encoder = new TextEncoder();

    // Capture `this` for use in the session closure
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const backend = this;

    return {
      stdin: stdinStream,
      stdout: instance.stdout,
      stderr: instance.stderr,

      async wait() {
        const output = await instance.wait();
        if (backend.#mounts.size > 0) {
          await backend.#syncMountsBack(mountRecord, mountSnapshots);
        } else {
          await backend.#syncDirectoryToFs(mountRecord["/work"], "/");
        }
        return { exitCode: output.code };
      },

      async writeLine(line: string) {
        const writer = stdinStream.getWriter();
        await writer.write(encoder.encode(line + "\n"));
        writer.releaseLock();
      },

      kill() {
        try {
          // close() returns a Promise — catch async rejection too
          const p = stdinStream.close();
          p.catch(() => {});
        } catch {
          // May already be closed
        }
      },
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
    this.#subagentBinary = null;
    this.#fs.clear();
    this.#dirs.clear();
    this.#initialized = false;
  }

  // --- Private helpers ---

  /**
   * Populate a Directory from the in-memory FS map.
   */
  async #populateDirectoryFromFs(dir: Directory): Promise<void> {
    for (const [path, data] of this.#fs) {
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
  }

  /**
   * For each mount, discover files via globInfo, download via
   * downloadFiles, and populate a Directory. Returns the directories
   * and pre-execution snapshots for diff detection.
   */
  async #populateMountDirectories(): Promise<{
    directories: Record<string, Directory>;
    snapshots: Map<string, Map<string, Uint8Array>>;
  }> {
    const directories: Record<string, Directory> = {};
    const snapshots = new Map<string, Map<string, Uint8Array>>();

    for (const [mountPath, backend] of this.#mounts) {
      const dir = new Directory();
      const snapshot = new Map<string, Uint8Array>();

      // Skip mounts that don't support download
      if (!backend.downloadFiles) {
        directories[mountPath] = dir;
        snapshots.set(mountPath, snapshot);
        continue;
      }

      // Discover all files in the backend
      const fileInfos = await backend.globInfo("**/*", "/");
      const filePaths = fileInfos.filter((f) => !f.is_dir).map((f) => f.path);

      if (filePaths.length > 0) {
        // Download all files
        const downloads = await backend.downloadFiles(filePaths);

        for (const dl of downloads) {
          if (dl.error || !dl.content) continue;

          const filePath = dl.path.startsWith("/") ? dl.path : `/${dl.path}`;

          // Store snapshot for later diff
          snapshot.set(filePath, new Uint8Array(dl.content));

          // Populate the directory
          const parts = filePath.split("/").filter(Boolean);
          for (let i = 1; i < parts.length; i++) {
            const parentDir = "/" + parts.slice(0, i).join("/");
            try {
              await dir.createDir(parentDir);
            } catch {
              // Directory may already exist — ignore
            }
          }
          await dir.writeFile(filePath, dl.content);
        }
      }

      directories[mountPath] = dir;
      snapshots.set(mountPath, snapshot);
    }

    return { directories, snapshots };
  }

  /**
   * After execution, walk each mount's Directory, diff against the
   * pre-execution snapshot, and upload changed/new files back to the
   * backend via `uploadFiles()`.
   */
  async #syncMountsBack(
    directories: Record<string, Directory>,
    snapshots: Map<string, Map<string, Uint8Array>>,
  ): Promise<void> {
    for (const [mountPath, backend] of this.#mounts) {
      const dir = directories[mountPath];
      if (!dir || !backend.uploadFiles) continue;

      const snapshot =
        snapshots.get(mountPath) ?? new Map<string, Uint8Array>();

      // Walk the directory to get all current files
      const currentFiles = new Map<string, Uint8Array>();
      await this.#walkDirectory(dir, "/", currentFiles);

      // Diff: find new and modified files
      const toUpload: Array<[string, Uint8Array]> = [];
      for (const [filePath, content] of currentFiles) {
        const original = snapshot.get(filePath);
        if (!original || !this.#bytesEqual(original, content)) {
          toUpload.push([filePath, content]);
        }
      }

      if (toUpload.length > 0) {
        await backend.uploadFiles(toUpload);
      }
    }
  }

  /**
   * Recursively walk a Directory and collect all file paths
   * and their contents.
   */
  async #walkDirectory(
    dir: Directory,
    prefix: string,
    result: Map<string, Uint8Array>,
  ): Promise<void> {
    const entries = await dir.readDir(prefix);
    for (const entry of entries) {
      const fullPath =
        prefix === "/" ? `/${entry.name}` : `${prefix}/${entry.name}`;
      if (entry.type === "dir") {
        await this.#walkDirectory(dir, fullPath, result);
      } else if (entry.type === "file") {
        const data = await dir.readFile(fullPath);
        result.set(fullPath, data);
      }
    }
  }

  /**
   * Compare two Uint8Arrays for byte equality.
   */
  #bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Recursively walk a Directory and sync all files back into
   * the in-memory Map (and directories into the Set).
   */
  async #syncDirectoryToFs(dir: Directory, prefix: string): Promise<void> {
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

  /**
   * Create mount directories for the subagent WASM binary and RPC spool.
   * The binary is placed at `/usr/local/sbin/subagent` which is on the
   * default WASIX PATH, making `subagent` available as a regular command.
   */
  async #createSubagentMounts(): Promise<{
    binDir: Directory;
    rpcDir: Directory;
  }> {
    const binDir = new Directory();
    const rpcDir = new Directory();

    if (this.#subagentBinary) {
      // Mounting a .wasm binary onto the filesystem makes it executable
      // in WASIX — the runtime recognizes WASM files as native executables.
      await binDir.writeFile("/subagent", this.#subagentBinary);
    }

    return { binDir, rpcDir };
  }

  /**
   * Collect spawn requests from a mounted `/.rpc` Directory.
   * Reads JSON files from `/requests/` within the directory.
   */
  async #collectSpawnRequestsFromDir(
    rpcDir: Directory,
  ): Promise<SpawnRequest[]> {
    const requests: SpawnRequest[] = [];
    try {
      const entries = await rpcDir.readDir("/requests");
      for (const entry of entries) {
        if (entry.type === "file" && entry.name.endsWith(".json")) {
          try {
            const data = await rpcDir.readFile(`/requests/${entry.name}`);
            const text = new TextDecoder().decode(data);
            const parsed = JSON.parse(text) as SpawnRequest;
            if (
              typeof parsed.id === "string" &&
              parsed.method === "spawn" &&
              typeof parsed.args?.task === "string"
            ) {
              // The WASM binary can't access SystemTime, so the host
              // sets a real timestamp when it reads the RPC file.
              if (!parsed.timestamp || parsed.timestamp === "0") {
                parsed.timestamp = `${Date.now() / 1000}`;
              }
              requests.push(parsed);
            }
          } catch {
            // Ignore malformed JSON files
          }
        }
      }
    } catch {
      // /requests directory may not exist if no subagent commands were run
    }
    return requests;
  }

  #ensureInitialized(): void {
    if (!this.#initialized) {
      throw new DeepbashError(
        "Deepbash backend not initialized. Use DeepbashBackend.create().",
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
