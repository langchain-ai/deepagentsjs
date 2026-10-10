import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import { Machine, type ConnectOptions, type MachineConfig } from "smolmachines";
import {
  BaseSandbox,
  SandboxError,
  type BackendFactory,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from "deepagents";

/** Configuration for a local or hosted Smol Machines microVM. */
export interface SmolSandboxOptions {
  /** Explicit target so an ambient Cloud token cannot move local work into the Cloud. */
  target?: "local" | "cloud";
  /** OCI image with /bin/sh and standard shell utilities. */
  image?: string;
  resources?: MachineConfig["resources"];
  /** Other native machine settings, including egress policy, ports, and TTL. */
  machine?: Omit<MachineConfig, "image" | "resources" | "workdir">;
  /** Cloud credentials and connection settings; target is selected above. */
  connection?: Omit<ConnectOptions, "target">;
  /** Files written before the sandbox is returned to the agent. */
  initialFiles?: Record<string, string | Uint8Array>;
}

const WORKDIR = "/workspace";

function filePath(path: string, target: "local" | "cloud"): string {
  if (!path || path.includes("\0"))
    throw new SandboxError("Invalid file path", "INVALID_PATH");
  // The Cloud forwarding layer currently strips controls and interprets
  // decoded URL syntax (#, ?, %) before sending paths to the node. Until the
  // forwarding fix is deployed, reject paths that could address another file.
  if (
    target === "cloud" &&
    Array.from(path).some(
      (char) =>
        char.charCodeAt(0) < 32 ||
        char.charCodeAt(0) === 127 ||
        "#?%".includes(char),
    )
  ) {
    throw new SandboxError(
      "Cloud file paths cannot contain URL control or reserved characters",
      "INVALID_PATH",
    );
  }
  return posix.resolve(WORKDIR, path);
}

function fileError(error: unknown): FileOperationError {
  if (SandboxError.isInstance(error) && error.code === "INVALID_PATH")
    return "invalid_path";
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : null;
  if (
    code === "NOT_FOUND" ||
    /\b(ENOENT|not found|no such file)\b|→ 404\b/i.test(message)
  )
    return "file_not_found";
  if (/\b(EACCES|EPERM|permission denied|403)\b/i.test(message))
    return "permission_denied";
  if (/\b(EISDIR|is a directory)\b/i.test(message)) return "is_directory";
  if (/\b(EINVAL|invalid path|invalid file name)\b/i.test(message))
    return "invalid_path";
  // Infrastructure and transport errors are not file errors. Let the caller
  // retry or surface them instead of misreporting a missing file.
  throw error;
}

/** A Deep Agents backend backed by a real microVM, on this host or in Cloud. */
export class SmolSandbox extends BaseSandbox {
  readonly #options: SmolSandboxOptions;
  readonly #target: "local" | "cloud";
  #machine: Machine | null = null;
  #initializing: Promise<void> | null = null;
  #id = `smol-${randomUUID()}`;

  constructor(options: SmolSandboxOptions = {}) {
    super();
    this.#options = options;
    this.#target = options.target ?? "local";
  }

  get id(): string {
    return this.#id;
  }

  get isRunning(): boolean {
    return this.#machine !== null;
  }

  /** Access native checkpoints, branches, endpoints, and resource controls. */
  get instance(): Machine {
    if (!this.#machine)
      throw new SandboxError("Sandbox is not initialized", "NOT_INITIALIZED");
    return this.#machine;
  }

  static async create(options: SmolSandboxOptions = {}): Promise<SmolSandbox> {
    const sandbox = new SmolSandbox(options);
    await sandbox.initialize();
    return sandbox;
  }

  async initialize(): Promise<void> {
    if (this.#machine)
      throw new SandboxError(
        "Sandbox is already initialized",
        "ALREADY_INITIALIZED",
      );
    if (this.#initializing) return this.#initializing;
    this.#initializing = this.#createMachine();
    try {
      await this.#initializing;
    } finally {
      this.#initializing = null;
    }
  }

  async #createMachine(): Promise<void> {
    const connection: ConnectOptions = {
      ...this.#options.connection,
      target: this.#target,
      // The agent process owns cleanup and signal handling.
      ...(this.#target === "local" &&
      this.#options.connection?.handleSignals === undefined
        ? { handleSignals: false }
        : {}),
    };
    const machine = await Machine.create(
      {
        ...this.#options.machine,
        image: this.#options.image ?? "node:22-alpine",
        resources: this.#options.resources,
        workdir: WORKDIR,
        ...(this.#target === "cloud" &&
        this.#options.machine?.ttlSeconds === undefined
          ? { ttlSeconds: 1800 }
          : {}),
      },
      connection,
    );
    try {
      this.#machine = machine;
      this.#id = machine.id;
      if (this.#options.initialFiles) {
        const uploaded = await this.uploadFiles(
          Object.entries(this.#options.initialFiles).map(([path, value]) => [
            path,
            typeof value === "string" ? new TextEncoder().encode(value) : value,
          ]),
        );
        const failure = uploaded.find((result) => result.error);
        if (failure)
          throw new SandboxError(
            `Failed to upload ${failure.path}: ${failure.error}`,
            "FILE_UPLOAD_FAILED",
          );
      }
    } catch (error) {
      try {
        await machine.delete();
      } catch {
        // Keep the original initialization error; the Cloud TTL bounds cleanup.
      }
      this.#machine = null;
      throw error;
    }
  }

  async execute(command: string): Promise<ExecuteResponse> {
    const result = await this.instance.exec(["sh", "-lc", command], {
      workdir: WORKDIR,
    });
    return {
      output: result.output,
      exitCode: result.exitCode,
      truncated: result.stdoutTruncated || result.stderrTruncated,
    };
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const machine = this.instance;
    const results: FileUploadResponse[] = [];
    for (const [path, content] of files) {
      try {
        const absolute = filePath(path, this.#target);
        const parent = posix.dirname(absolute);
        const mkdir = await machine.exec(["mkdir", "-p", "--", parent]);
        if (mkdir.exitCode !== 0)
          throw new Error(`Cannot create ${parent}: ${mkdir.stderr}`);
        await machine.writeFile(absolute, content);
        results.push({ path, error: null });
      } catch (error) {
        results.push({ path, error: fileError(error) });
      }
    }
    return results;
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const machine = this.instance;
    const results: FileDownloadResponse[] = [];
    for (const path of paths) {
      try {
        const content = await machine.readFile(filePath(path, this.#target));
        results.push({ path, content: new Uint8Array(content), error: null });
      } catch (error) {
        results.push({ path, content: null, error: fileError(error) });
      }
    }
    return results;
  }

  async getWorkDir(): Promise<string> {
    return WORKDIR;
  }

  async getUserHomeDir(): Promise<string> {
    const result = await this.execute('printf %s "$HOME"');
    if (result.exitCode !== 0)
      throw new Error(`Cannot determine guest home: ${result.output}`);
    return result.output;
  }

  /** Delete the machine and its stored files. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.#initializing) await this.#initializing;
    if (!this.#machine) return;
    await this.#machine.delete();
    this.#machine = null;
  }
}

/** Reuse a pre-created sandbox across agent invocations; the caller owns close(). */
export function createSmolSandboxFactoryFromSandbox(
  sandbox: SmolSandbox,
): BackendFactory {
  return () => sandbox;
}
