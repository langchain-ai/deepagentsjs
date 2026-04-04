import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileUploadResponse,
  type GrepMatch,
  type GrepResult,
} from "deepagents";
import {
  DEFAULT_WORKSPACE_DIR,
  createBrowserWorkerSession,
  createNodeSession,
} from "@mayflowergmbh/wasmsh-pyodide";

import {
  errorMessage,
  getDiagnosticError,
  mapDownloadError,
  shellQuote,
  toInitialFiles,
} from "./internal.js";

type Session = Awaited<ReturnType<typeof createNodeSession>>;

export interface WasmshNodeSandboxOptions {
  distPath?: string;
  stepBudget?: number;
  initialFiles?: Record<string, string | Uint8Array>;
  workingDirectory?: string;
  /** Hostnames allowed for network access (empty = deny all). */
  allowedHosts?: string[];
}

export interface WasmshBrowserWorkerOptions {
  assetBaseUrl: string;
  worker?: Worker;
  stepBudget?: number;
  initialFiles?: Record<string, string | Uint8Array>;
  workingDirectory?: string;
}

type WasmshSandboxMode =
  | { kind: "node"; options: WasmshNodeSandboxOptions }
  | { kind: "browser"; options: WasmshBrowserWorkerOptions };

export class WasmshSandbox extends BaseSandbox {
  #mode: WasmshSandboxMode;

  #session: Session | null = null;

  #workingDirectory: string;

  #id: string;

  private constructor(mode: WasmshSandboxMode) {
    super();
    this.#mode = mode;
    this.#workingDirectory =
      mode.options.workingDirectory ?? DEFAULT_WORKSPACE_DIR;
    this.#id = `wasmsh-${mode.kind}-${crypto.randomUUID()}`;
  }

  get id(): string {
    return this.#id;
  }

  get isRunning(): boolean {
    return this.#session !== null;
  }

  static async createNode(
    options: WasmshNodeSandboxOptions = {},
  ): Promise<WasmshSandbox> {
    const sandbox = new WasmshSandbox({ kind: "node", options });
    await sandbox.initialize();
    return sandbox;
  }

  static async createBrowserWorker(
    options: WasmshBrowserWorkerOptions,
  ): Promise<WasmshSandbox> {
    const sandbox = new WasmshSandbox({ kind: "browser", options });
    await sandbox.initialize();
    return sandbox;
  }

  async initialize(): Promise<void> {
    if (this.#session) {
      throw new Error("WasmshSandbox is already initialized");
    }
    if (this.#mode.kind === "node") {
      this.#session = await createNodeSession({
        assetDir: this.#mode.options.distPath,
        stepBudget: this.#mode.options.stepBudget,
        initialFiles: toInitialFiles(this.#mode.options.initialFiles),
        allowedHosts: this.#mode.options.allowedHosts,
      });
      return;
    }
    this.#session = await createBrowserWorkerSession({
      assetBaseUrl: this.#mode.options.assetBaseUrl,
      worker: this.#mode.options.worker,
      stepBudget: this.#mode.options.stepBudget,
      initialFiles: toInitialFiles(this.#mode.options.initialFiles),
    });
  }

  async stop(): Promise<void> {
    if (!this.#session) {
      return;
    }
    await this.#session.close();
    this.#session = null;
  }

  async close(): Promise<void> {
    await this.stop();
  }

  async execute(command: string): Promise<ExecuteResponse> {
    if (!this.#session) {
      throw new Error("WasmshSandbox is not initialized");
    }
    const result = await this.#session.run(
      `cd ${shellQuote(this.#workingDirectory)} && ${command}`,
    );
    return {
      output: result.output,
      exitCode: result.exitCode,
      truncated: false,
    };
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    if (!this.#session) {
      throw new Error("WasmshSandbox is not initialized");
    }
    const session = this.#session;
    return Promise.all(
      files.map(async ([path, content]): Promise<FileUploadResponse> => {
        if (!path.startsWith("/")) {
          return { path, error: "invalid_path" };
        }
        try {
          const result = await session.writeFile(path, content);
          const diagnostic = getDiagnosticError(result.events);
          return {
            path,
            error: diagnostic ? mapDownloadError(diagnostic) : null,
          };
        } catch (error: unknown) {
          return { path, error: mapDownloadError(errorMessage(error)) };
        }
      }),
    );
  }

  async grep(
    pattern: string,
    path: string = "/",
    glob: string | null = null,
  ): Promise<GrepResult> {
    // Non-glob path matches BaseSandbox exactly — delegate to share parser
    // (including binary-file skip).
    if (!glob) {
      return super.grep(pattern, path, glob);
    }

    if (!this.#session) {
      throw new Error("WasmshSandbox is not initialized");
    }
    // wasmsh's `find` lacks `-exec`, so use `grep --include=GLOB` instead of
    // BaseSandbox's `find -name GLOB -exec grep`.
    const command = `grep -rHnF --include=${shellQuote(glob)} -e ${shellQuote(pattern)} ${shellQuote(path)} 2>/dev/null || true`;
    const result = await this.execute(command);
    const output = result.output.trim();
    if (!output) {
      return { matches: [] };
    }
    const matches: GrepMatch[] = [];
    for (const line of output.split("\n")) {
      const parts = line.split(":");
      if (parts.length < 3) continue;
      const lineNum = parseInt(parts[1], 10);
      if (isNaN(lineNum)) continue;
      matches.push({
        path: parts[0],
        line: lineNum,
        text: parts.slice(2).join(":"),
      });
    }
    return { matches };
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    if (!this.#session) {
      throw new Error("WasmshSandbox is not initialized");
    }
    const session = this.#session;
    return Promise.all(
      paths.map(async (path): Promise<FileDownloadResponse> => {
        if (!path.startsWith("/")) {
          return { path, content: null, error: "invalid_path" };
        }
        try {
          const result = await session.readFile(path);
          const diagnostic = getDiagnosticError(result.events);
          if (diagnostic) {
            return { path, content: null, error: mapDownloadError(diagnostic) };
          }
          return { path, content: result.content, error: null };
        } catch (error: unknown) {
          return {
            path,
            content: null,
            error: mapDownloadError(errorMessage(error)),
          };
        }
      }),
    );
  }
}
