/**
 * Core REPL engine built on quickjs-emscripten (asyncify variant).
 *
 * Host async functions (backend I/O, PTC tools) are exposed as
 * promise-returning functions inside the QuickJS guest. Guest code
 * uses `await` to consume them, enabling real concurrency via
 * `Promise.all`, `Promise.race`, etc.
 *
 * We still use the asyncify WASM variant because `evalCodeAsync` is
 * required to drive promise resolution from the host side.
 *
 * ## Architecture
 *
 * `ReplSession` is a serializable handle that can live in LangGraph state.
 * It holds an `id` that keys into a static session map. The heavy QuickJS
 * runtime is lazily started on the first `.eval()` call, making the session
 * safe across graph interrupts and checkpointing.
 *
 * File writes inside the REPL are buffered (`pendingWrites`) and only
 * flushed to the backend after a script finishes executing. Call
 * `session.flushWrites(backend)` after eval to persist them.
 */

import { shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { QuickJSHandle } from "quickjs-emscripten";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
} from "quickjs-emscripten-core";
import type { AnyBackendProtocol, BackendProtocolV2 } from "deepagents";
import {
  adaptBackendProtocol,
  createTable,
  executeSwarm,
  type SwarmFilter,
} from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";

import type { ReplSessionOptions, ReplResult } from "./types.js";
import { toCamelCase } from "./utils.js";
import { transformForEval } from "./transform.js";

export const DEFAULT_MEMORY_LIMIT = 50 * 1024 * 1024;
export const DEFAULT_MAX_STACK_SIZE = 320 * 1024;
export const DEFAULT_EXECUTION_TIMEOUT = 30_000;
export const DEFAULT_SESSION_ID = "__default__";

let asyncModulePromise: Promise<any> | undefined;

async function getAsyncModule() {
  if (!asyncModulePromise) {
    asyncModulePromise = (async () => {
      const variant =
        await import("@jitl/quickjs-ng-wasmfile-release-asyncify");
      return newQuickJSAsyncWASMModuleFromVariant(
        (variant.default ?? variant) as any,
      );
    })();
  }
  return asyncModulePromise;
}

export interface PendingWrite {
  path: string;
  content: string;
}

/**
 * Sandboxed JavaScript REPL session backed by QuickJS WASM.
 *
 * Serializable — holds an `id` that keys into a static session map.
 * The QuickJS runtime is lazily started on the first `.eval()` call
 * and reconnected if a session with the same id already exists.
 * This makes it safe to store in LangGraph state across interrupts.
 *
 * File writes are buffered during execution and flushed via
 * `flushWrites(backend)` after eval completes.
 */
export class ReplSession {
  private static sessions = new Map<string, ReplSession>();

  readonly id: string;
  readonly pendingWrites: PendingWrite[] = [];

  private runtime: QuickJSAsyncRuntime | null = null;
  private context: QuickJSAsyncContext | null = null;
  private logs: string[] = [];
  private _options: ReplSessionOptions;

  private _backend: BackendProtocolV2 | null = null;

  /**
   * Abort controller scoped to the current `eval()` call. Aborted on timeout so in-flight swarm dispatches are cancelled.
   */
  private _evalAbortController: AbortController | null = null;

  constructor(id: string, options: ReplSessionOptions = {}) {
    this.id = id;
    this._options = options;
  }

  get backend(): BackendProtocolV2 | null {
    return this._backend;
  }

  set backend(b: AnyBackendProtocol | null) {
    this._backend = b ? adaptBackendProtocol(b) : null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.runtime) return;

    const {
      memoryLimitBytes = DEFAULT_MEMORY_LIMIT,
      maxStackSizeBytes = DEFAULT_MAX_STACK_SIZE,
      backend,
      tools,
      subagentGraphs,
    } = this._options;

    const asyncModule = await getAsyncModule();
    const runtime: QuickJSAsyncRuntime = asyncModule.newRuntime();
    runtime.setMemoryLimit(memoryLimitBytes);
    runtime.setMaxStackSize(maxStackSizeBytes);

    const context: QuickJSAsyncContext = runtime.newContext();
    this.runtime = runtime;
    this.context = context;

    this.setupConsole();

    if (backend) {
      this._backend = adaptBackendProtocol(backend);
    }

    this.injectVfs();
    if (tools && tools.length > 0) {
      this.injectTools(tools);
    }

    if (subagentGraphs && Object.keys(subagentGraphs).length > 0) {
      this.injectSwarm();
    }
  }

  /**
   * Get or create a session for the given id.
   *
   * Sessions are deduped by id — calling `getOrCreate` twice with the
   * same id returns the same instance. The QuickJS runtime is lazily
   * started on the first `.eval()` call.
   */
  static getOrCreate(
    id: string,
    options: ReplSessionOptions = {},
  ): ReplSession {
    const existing = ReplSession.sessions.get(id);
    if (existing) {
      if (options.backend) {
        existing._backend = adaptBackendProtocol(options.backend);
      }

      if (options.subagentGraphs !== undefined) {
        existing._options.subagentGraphs = options.subagentGraphs;
      }

      if (options.currentState !== undefined) {
        existing._options.currentState = options.currentState;
      }

      if (options.subagentFactories !== undefined) {
        existing._options.subagentFactories = options.subagentFactories;
      }

      return existing;
    }

    const session = new ReplSession(id, options);
    ReplSession.sessions.set(id, session);
    return session;
  }

  /**
   * Retrieve an existing session by id, or null if none exists.
   */
  static get(id: string): ReplSession | null {
    return ReplSession.sessions.get(id) ?? null;
  }

  /**
   * Evaluate code in this session.
   *
   * Lazily starts the QuickJS runtime on the first call. Code is
   * transformed via an AST pipeline that strips TypeScript syntax,
   * hoists top-level declarations to globalThis for cross-eval
   * persistence, auto-returns the last expression, and wraps in an
   * async IIFE.
   */
  async eval(code: string, timeoutMs: number): Promise<ReplResult> {
    await this.ensureStarted();
    const runtime = this.runtime!;
    const context = this.context!;

    this.logs.length = 0;
    this._evalAbortController = new AbortController();

    if (timeoutMs >= 0) {
      runtime.setInterruptHandler(
        shouldInterruptAfterDeadline(Date.now() + timeoutMs),
      );
    } else {
      runtime.setInterruptHandler(() => false);
    }

    const transformed = transformForEval(code);
    const result = await context.evalCodeAsync(transformed);

    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      return { ok: false, error, logs: [...this.logs] };
    }

    const promiseState = context.getPromiseState(result.value);

    if (promiseState.type === "fulfilled") {
      if (promiseState.notAPromise) {
        const value = context.dump(result.value);
        result.value.dispose();
        return { ok: true, value, logs: [...this.logs] };
      }
      const value = context.dump(promiseState.value);
      promiseState.value.dispose();
      result.value.dispose();
      return { ok: true, value, logs: [...this.logs] };
    }

    if (promiseState.type === "rejected") {
      const error = context.dump(promiseState.error);
      promiseState.error.dispose();
      result.value.dispose();
      return { ok: false, error, logs: [...this.logs] };
    }

    const noTimeout = timeoutMs < 0;
    const deadline = noTimeout ? Infinity : Date.now() + timeoutMs;
    while (noTimeout || Date.now() < deadline) {
      context.runtime.executePendingJobs();
      const state = context.getPromiseState(result.value);
      if (state.type === "fulfilled") {
        const value = context.dump(state.value);
        state.value.dispose();
        result.value.dispose();
        return { ok: true, value, logs: [...this.logs] };
      }
      if (state.type === "rejected") {
        const error = context.dump(state.error);
        state.error.dispose();
        result.value.dispose();
        return { ok: false, error, logs: [...this.logs] };
      }
      await new Promise((r) => setTimeout(r, 1));
    }

    result.value.dispose();
    this._evalAbortController?.abort();
    return {
      ok: false,
      error: { message: "Promise timed out — execution interrupted" },
      logs: [...this.logs],
    };
  }

  async flushWrites(backend: AnyBackendProtocol): Promise<void> {
    const adapted = adaptBackendProtocol(backend);
    const writes = this.pendingWrites.splice(0);
    for (const { path, content } of writes) {
      const result = await adapted.write(path, content);
      if (result.error?.includes("already exists")) {
        // File already exists — overwrite by reading current content and replacing
        const raw = await adapted.readRaw(path);
        if (!raw.error && raw.data) {
          const data = raw.data;
          const oldContent = Array.isArray(data.content)
            ? data.content.join("\n")
            : typeof data.content === "string"
              ? data.content
              : null;
          if (oldContent !== null && oldContent !== content) {
            await adapted.edit(path, oldContent, content);
          }
        }
      }
    }
  }

  dispose(): void {
    try {
      this.context?.dispose();
    } catch {
      /* may already be disposed */
    }
    try {
      this.runtime?.dispose();
    } catch {
      /* may already be disposed */
    }
    this.runtime = null;
    this.context = null;
    ReplSession.sessions.delete(this.id);
  }

  toJSON(): { id: string } {
    return { id: this.id };
  }

  static fromJSON(data: { id: string }): ReplSession {
    return ReplSession.sessions.get(data.id) ?? new ReplSession(data.id);
  }

  /**
   * Clear the static session cache. Useful for testing.
   * @internal
   */
  static clearCache(): void {
    for (const session of ReplSession.sessions.values()) {
      session.dispose();
    }
    ReplSession.sessions.clear();
  }

  private setupConsole(): void {
    const context = this.context!;
    const logs = this.logs;
    const consoleHandle = context.newObject();
    for (const method of ["log", "warn", "error", "info", "debug"] as const) {
      const fnHandle = context.newFunction(
        method,
        (...args: QuickJSHandle[]) => {
          const nativeArgs = args.map((a: QuickJSHandle) => context.dump(a));
          const formatted = nativeArgs
            .map((a: unknown) =>
              typeof a === "object" && a !== null
                ? JSON.stringify(a)
                : String(a),
            )
            .join(" ");
          logs.push(
            method === "log" || method === "info" || method === "debug"
              ? formatted
              : `[${method}] ${formatted}`,
          );
        },
      );
      context.setProp(consoleHandle, method, fnHandle);
      fnHandle.dispose();
    }
    context.setProp(context.global, "console", consoleHandle);
    consoleHandle.dispose();
  }

  private injectVfs(): void {
    const context = this.context!;
    const getBackend = () => this._backend;
    const { pendingWrites } = this;

    const readFileHandle = context.newFunction(
      "readFile",
      (pathHandle: QuickJSHandle) => {
        const backend = getBackend();
        if (!backend) {
          const promise = context.newPromise();
          const err = context.newError("Backend not available");
          promise.reject(err);
          err.dispose();
          promise.settled.then(context.runtime.executePendingJobs);
          return promise.handle;
        }
        const path = context.getString(pathHandle);
        const promise = context.newPromise();
        (async () => {
          try {
            const result = await backend.readRaw(path);
            if (result.error || !result.data) {
              const err = context.newError(
                `ENOENT: no such file or directory '${path}'.`,
              );
              promise.reject(err);
              err.dispose();
            } else {
              const content = Array.isArray(result.data.content)
                ? result.data.content.join("\n")
                : typeof result.data.content === "string"
                  ? result.data.content
                  : null;
              if (content === null) {
                const err = context.newError(
                  `Cannot read binary file '${path}' as text.`,
                );
                promise.reject(err);
                err.dispose();
                return;
              }
              const val = context.newString(content);
              promise.resolve(val);
              val.dispose();
            }
          } catch {
            const err = context.newError(
              `ENOENT: no such file or directory '${path}'.`,
            );
            promise.reject(err);
            err.dispose();
          }
          promise.settled.then(context.runtime.executePendingJobs);
        })();
        return promise.handle;
      },
    );
    context.setProp(context.global, "readFile", readFileHandle);
    readFileHandle.dispose();

    const writeFileHandle = context.newFunction(
      "writeFile",
      (pathHandle: QuickJSHandle, contentHandle: QuickJSHandle) => {
        const path = context.getString(pathHandle);
        const content = context.getString(contentHandle);
        const promise = context.newPromise();
        pendingWrites.push({ path, content });
        promise.resolve(context.undefined);
        promise.settled.then(context.runtime.executePendingJobs);
        return promise.handle;
      },
    );
    context.setProp(context.global, "writeFile", writeFileHandle);
    writeFileHandle.dispose();
  }

  /**
   * Bridge a native async function into a QuickJS promise handle.
   *
   * Executes `fn`, resolves/rejects the QuickJS promise accordingly,
   * disposes returned handles, and flushes pending QuickJS microtasks.
   * All QuickJS-to-native async bridges in this class should use this
   * helper to avoid duplicating the error-handling and flush logic.
   */
  private wrapAsync(fn: () => Promise<QuickJSHandle>): QuickJSHandle {
    const context = this.context!;
    const promise = context.newPromise();
    (async () => {
      try {
        const value = await fn();
        promise.resolve(value);
        if (value !== context.undefined) {
          value.dispose();
        }
      } catch (err) {
        const error = context.newError((err as Error).message ?? String(err));
        promise.reject(error);
        error.dispose();
      }
      promise.settled.then(context.runtime.executePendingJobs);
    })();
    return promise.handle;
  }

  /**
   * Register the `swarm` namespace object on the QuickJS global scope,
   * exposing `swarm.create(file, source)` and `swarm.execute(file, options)`
   * as async functions callable from `js_eval`.
   *
   * Writes are routed through the session's `pendingWrites` buffer so
   * they are visible to subsequent `readFile` calls within the same eval.
   */
  private injectSwarm(): void {
    const context = this.context!;
    const session = this;

    /**
     * Write to pendingWrites, replacing any existing entry for the same
     * path so only the latest version is flushed after eval completes.
     */
    const write = (path: string, content: string): void => {
      const idx = session.pendingWrites.findIndex((w) => w.path === path);
      if (idx !== -1) {
        session.pendingWrites.splice(idx, 1);
      }
      session.pendingWrites.push({ path, content });
    };

    /**
     * Read a file, checking pendingWrites first so that files written
     * by swarm.create (or a prior swarm.execute) in the same eval are
     * visible before they're flushed to the backend.
     */
    const read = async (path: string): Promise<string> => {
      const pending = session.pendingWrites.find((w) => w.path === path);
      if (pending) {
        return pending.content;
      }

      const backend = session._backend;
      if (!backend) {
        throw new Error("Backend not available");
      }

      const result = await backend.read(path);
      if (result.error || result.content == null) {
        throw new Error(`Failed to read "${path}": ${result.error ?? "empty"}`);
      }

      return result.content as string;
    };

    const swarmNs = context.newObject();

    // swarm.create
    const createHandle = context.newFunction(
      "create",
      (fileHandle: QuickJSHandle, sourceHandle: QuickJSHandle) => {
        const file = context.getString(fileHandle);
        const source = context.dump(sourceHandle) as Record<string, unknown>;

        return session.wrapAsync(async () => {
          const backend = session._backend;
          if (!backend) {
            throw new Error("Backend not available");
          }

          await createTable(
            file,
            {
              glob: source.glob as string | string[] | undefined,
              filePaths: source.filePaths as string[] | undefined,
              tasks: source.tasks as Array<Record<string, unknown>> | undefined,
            },
            backend,
            write,
          );
          session.logs.push(`[swarm.create] Table written to ${file}.`);

          return context.undefined;
        });
      },
    );
    context.setProp(swarmNs, "create", createHandle);
    createHandle.dispose();

    // swarm.execute
    const executeHandle = context.newFunction(
      "execute",
      (fileHandle: QuickJSHandle, optionsHandle: QuickJSHandle) => {
        const file = context.getString(fileHandle);
        const opts = context.dump(optionsHandle) as Record<string, unknown>;

        return session.wrapAsync(async () => {
          if (!session._backend) {
            throw new Error("Backend not available");
          }

          const {
            subagentGraphs = {},
            subagentFactories,
            currentState = {},
          } = session._options;

          if (
            typeof opts.instruction !== "string" ||
            opts.instruction.length === 0
          ) {
            throw new Error("swarm.execute: `instruction` is required.");
          }

          const summary = await executeSwarm({
            file,
            instruction: opts.instruction,
            column: typeof opts.column === "string" ? opts.column : undefined,
            filter: opts.filter as SwarmFilter | undefined,
            subagentType:
              typeof opts.subagentType === "string"
                ? opts.subagentType
                : undefined,
            responseSchema: opts.responseSchema as
              | Record<string, unknown>
              | undefined,
            concurrency:
              typeof opts.concurrency === "number"
                ? opts.concurrency
                : undefined,
            subagentGraphs,
            subagentFactories,
            currentState: currentState as Record<string, unknown>,
            signal: session._evalAbortController?.signal,
            read,
            write,
          });
          session.logs.push(
            `[swarm.execute] ${summary.completed} completed, ${summary.failed} failed, ${summary.skipped} skipped. Results → "${file}" column "${summary.column}".`,
          );
          if (summary.failed > 0) {
            const sample = summary.failedTasks.slice(0, 3);
            for (const t of sample) {
              session.logs.push(
                `[swarm.execute] failure id="${t.id}" error=${t.error}`,
              );
            }
            if (summary.failedTasks.length > 3) {
              session.logs.push(
                `[swarm.execute] ... and ${summary.failedTasks.length - 3} more failures`,
              );
            }
          }
          return context.newString(JSON.stringify(summary));
        });
      },
    );
    context.setProp(swarmNs, "execute", executeHandle);
    executeHandle.dispose();

    context.setProp(context.global, "swarm", swarmNs);
    swarmNs.dispose();
  }

  private injectTools(tools: StructuredToolInterface[]): void {
    const context = this.context!;
    const toolsNs = context.newObject();

    for (const t of tools) {
      const camelName = toCamelCase(t.name);
      const fnHandle = context.newFunction(
        camelName,
        (inputHandle: QuickJSHandle) => {
          const input = context.dump(inputHandle);
          const promise = context.newPromise();
          (async () => {
            try {
              const rawInput =
                typeof input === "object" && input !== null ? input : {};
              const result = await t.invoke(rawInput);
              const val = context.newString(
                typeof result === "string" ? result : JSON.stringify(result),
              );
              promise.resolve(val);
              val.dispose();
            } catch (e: unknown) {
              const msg =
                e != null && typeof (e as Error).message === "string"
                  ? (e as Error).message
                  : String(e);
              const err = context.newError(`Tool '${t.name}' failed: ${msg}`);
              promise.reject(err);
              err.dispose();
            }
            promise.settled.then(context.runtime.executePendingJobs);
          })();
          return promise.handle;
        },
      );
      context.setProp(toolsNs, camelName, fnHandle);
      fnHandle.dispose();
    }

    context.setProp(context.global, "tools", toolsNs);
    toolsNs.dispose();
  }
}
