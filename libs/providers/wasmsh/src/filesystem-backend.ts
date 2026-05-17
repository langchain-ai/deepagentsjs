/**
 * `WasmshFilesystemBackend` — DeepAgents memory backend over a wasmsh VFS.
 *
 * A thin shim that adapts a `WasmshSandbox` to the DeepAgents
 * `BackendProtocolV2`. Unlike using the sandbox directly, this backend:
 *
 *   - never exposes `execute()` — it is a memory store, not a code-runner;
 *   - supports a `namespace` prefix so several memory routes can share one
 *     sandbox without colliding (e.g. `/memories`, `/skills`, …);
 *   - is composable as a sub-backend in `CompositeBackend`.
 *
 * Mirrors `langchain_wasmsh.WasmshFilesystemBackend` from the Python adapter.
 */
import type {
  EditResult,
  FileDownloadResponse,
  FileUploadResponse,
  GlobResult,
  GrepResult,
  LsResult,
  ReadResult,
  ReadRawResult,
  WriteResult,
} from "deepagents";
import type { WasmshSandbox } from "./sandbox.js";

export interface WasmshFilesystemBackendOptions {
  /**
   * Absolute-path prefix silently prepended to every path the agent uses
   * (e.g. `"/memories"`). Lets one sandbox host multiple memory routes
   * without collisions.
   */
  namespace?: string;
}

function normaliseNamespace(namespace: string | undefined): string {
  if (!namespace) return "";
  const prefixed = namespace.startsWith("/") ? namespace : `/${namespace}`;
  return prefixed.replace(/\/+$/, "");
}

export class WasmshFilesystemBackend {
  readonly #sandbox: WasmshSandbox;

  readonly #namespace: string;

  constructor(
    sandbox: WasmshSandbox,
    options: WasmshFilesystemBackendOptions = {},
  ) {
    this.#sandbox = sandbox;
    this.#namespace = normaliseNamespace(options.namespace);
  }

  get id(): string {
    const sandboxId = (this.#sandbox as unknown as { id?: string }).id;
    return `wasmsh-fs:${sandboxId ?? "anon"}${this.#namespace || "/"}`;
  }

  // ── namespace mapping ──────────────────────────────────────────────

  #scope(path: string | null | undefined): string {
    if (path == null) return this.#namespace || "/";
    if (!this.#namespace) return path;
    const abs = path.startsWith("/") ? path : `/${path}`;
    if (abs === "/") return this.#namespace || "/";
    return `${this.#namespace}${abs}`;
  }

  #unscope(path: string): string {
    if (!this.#namespace) return path;
    if (path.startsWith(this.#namespace)) {
      const stripped = path.slice(this.#namespace.length);
      return stripped || "/";
    }
    return path;
  }

  // ── BackendProtocolV2 surface ──────────────────────────────────────

  async ls(path: string): Promise<LsResult> {
    const result = await this.#sandbox.ls(this.#scope(path));
    if (result.error || !result.files) return result;
    return {
      files: result.files.map((f) => ({ ...f, path: this.#unscope(f.path) })),
    };
  }

  async read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): Promise<ReadResult> {
    return this.#sandbox.read(this.#scope(filePath), offset, limit);
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    return this.#sandbox.readRaw(this.#scope(filePath));
  }

  async grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
  ): Promise<GrepResult> {
    const scoped = path ? this.#scope(path) : null;
    const result = await this.#sandbox.grep(
      pattern,
      scoped ?? "/",
      glob ?? null,
    );
    if (result.error || !result.matches) return result;
    return {
      matches: result.matches.map((m) => ({
        ...m,
        path: this.#unscope(m.path),
      })),
    };
  }

  async glob(pattern: string, path?: string): Promise<GlobResult> {
    const result = await this.#sandbox.glob(pattern, this.#scope(path ?? "/"));
    if (result.error || !result.files) return result;
    return {
      files: result.files.map((f) => ({ ...f, path: this.#unscope(f.path) })),
    };
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    return this.#sandbox.write(this.#scope(filePath), content);
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    return this.#sandbox.edit(
      this.#scope(filePath),
      oldString,
      newString,
      replaceAll,
    );
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const scoped = files.map(
      ([path, content]) => [this.#scope(path), content] as [string, Uint8Array],
    );
    const responses = await this.#sandbox.uploadFiles(scoped);
    return responses.map((r) => ({ ...r, path: this.#unscope(r.path) }));
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const scoped = paths.map((p) => this.#scope(p));
    const responses = await this.#sandbox.downloadFiles(scoped);
    return responses.map((r) => ({ ...r, path: this.#unscope(r.path) }));
  }
}
