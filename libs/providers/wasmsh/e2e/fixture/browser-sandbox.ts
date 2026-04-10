/**
 * Browser-only WasmshSandbox that talks to the wasmsh worker via raw
 * postMessage. The Playwright fixture intentionally avoids the
 * `@mayflowergmbh/wasmsh-pyodide` browser session so we can exercise the
 * thinnest deps-free wire path. Production code should use
 * `WasmshSandbox.createBrowserWorker` instead.
 */
import { BaseSandbox } from "deepagents";

import {
  errorMessage,
  getDiagnosticError,
  mapDownloadError,
} from "../../src/internal.js";

interface UploadOk {
  events?: unknown[];
}

interface DownloadOk {
  events?: unknown[];
  contentBase64: string;
}

interface RunOk {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
}

type WorkerResponse<T> =
  | { id: number; ok: true; result: T }
  | { id: number; ok: false; error: string };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function toBase64(bytes: Uint8Array): string {
  // Chunk to keep String.fromCharCode argument list bounded for large files.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class BrowserSession {
  private _worker: Worker;
  private _nextId = 1;
  private _pending = new Map<number, Pending>();
  private _dead = false;

  constructor(worker: Worker) {
    this._worker = worker;

    worker.addEventListener("message", (event: MessageEvent) => {
      const response = event.data as WorkerResponse<unknown>;
      const entry = this._pending.get(response.id);
      if (!entry) return;
      this._pending.delete(response.id);
      if (response.ok) {
        entry.resolve(response.result);
      } else {
        entry.reject(new Error(response.error));
      }
    });

    worker.addEventListener("error", (event: ErrorEvent) => {
      this._dead = true;
      const error = new Error(`Worker error: ${event.message ?? "unknown"}`);
      for (const entry of this._pending.values()) entry.reject(error);
      this._pending.clear();
    });
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this._dead) {
      return Promise.reject(new Error("Worker session is closed"));
    }
    const id = this._nextId++;
    return new Promise<T>((resolve, reject) => {
      this._pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this._worker.postMessage({ id, method, params });
    });
  }

  terminate() {
    this._dead = true;
    this._worker.terminate();
  }
}

export interface BrowserSandboxOptions {
  workerUrl: string;
  assetBaseUrl: string;
  stepBudget?: number;
  workingDirectory?: string;
  initialFiles?: Record<string, string | Uint8Array>;
}

export class BrowserSandbox extends BaseSandbox {
  readonly id: string;
  private _session: BrowserSession | null = null;
  private _options: BrowserSandboxOptions;
  private _workingDirectory: string;

  constructor(options: BrowserSandboxOptions) {
    super();
    this.id = `wasmsh-browser-${crypto.randomUUID()}`;
    this._options = options;
    this._workingDirectory = options.workingDirectory ?? "/workspace";
  }

  get isRunning() {
    return this._session !== null;
  }

  async initialize(): Promise<void> {
    const worker = new Worker(this._options.workerUrl, {
      name: "wasmsh-pyodide",
    });
    this._session = new BrowserSession(worker);

    const initialFiles = this._options.initialFiles
      ? Object.entries(this._options.initialFiles).map(([path, content]) => ({
          path,
          contentBase64: toBase64(
            typeof content === "string"
              ? new TextEncoder().encode(content)
              : content,
          ),
        }))
      : [];

    await this._session.request("init", {
      assetBaseUrl: this._options.assetBaseUrl,
      stepBudget: this._options.stepBudget ?? 0,
      initialFiles,
    });
  }

  async execute(command: string) {
    const fullCommand = `cd '${this._workingDirectory.replace(/'/g, "'\\''")}' && ${command}`;
    const result = await this._session!.request<RunOk>("run", {
      command: fullCommand,
    });
    return {
      output: result.output ?? (result.stdout ?? "") + (result.stderr ?? ""),
      exitCode: result.exitCode ?? null,
      truncated: false,
    };
  }

  async uploadFiles(files: Array<[string, Uint8Array]>) {
    const session = this._session!;
    return Promise.all(
      files.map(async ([filePath, content]) => {
        if (!filePath.startsWith("/")) {
          return { path: filePath, error: "invalid_path" as const };
        }
        try {
          const result = await session.request<UploadOk>("writeFile", {
            path: filePath,
            contentBase64: toBase64(content),
          });
          const diagnostic = getDiagnosticError(result?.events);
          return {
            path: filePath,
            error: diagnostic ? mapDownloadError(diagnostic) : null,
          };
        } catch (error: unknown) {
          return {
            path: filePath,
            error: mapDownloadError(errorMessage(error)),
          };
        }
      }),
    );
  }

  async downloadFiles(paths: string[]) {
    const session = this._session!;
    return Promise.all(
      paths.map(async (filePath) => {
        if (!filePath.startsWith("/")) {
          return {
            path: filePath,
            content: null,
            error: "invalid_path" as const,
          };
        }
        try {
          const result = await session.request<DownloadOk>("readFile", {
            path: filePath,
          });
          const diagnostic = getDiagnosticError(result.events);
          if (diagnostic) {
            return {
              path: filePath,
              content: null,
              error: mapDownloadError(diagnostic),
            };
          }
          return {
            path: filePath,
            content: fromBase64(result.contentBase64),
            error: null,
          };
        } catch (error: unknown) {
          return {
            path: filePath,
            content: null,
            error: mapDownloadError(errorMessage(error)),
          };
        }
      }),
    );
  }

  async close(): Promise<void> {
    if (this._session) {
      try {
        await this._session.request("close", {});
      } finally {
        this._session.terminate();
        this._session = null;
      }
    }
  }

  async stop(): Promise<void> {
    return this.close();
  }
}
