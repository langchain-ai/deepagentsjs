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
 */

import { shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { QuickJSHandle } from "quickjs-emscripten";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
} from "quickjs-emscripten-core";
import type { BackendProtocol } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";

import type { ReplSessionOptions, ReplResult, EnvConfig } from "./types.js";
import { isEnvVarConfig } from "./types.js";
import { toCamelCase, collectStrings } from "./utils.js";
import { transformForEval } from "./transform.js";

const secretRef = (key: string): string => `__secret__${key}__`;

export const DEFAULT_MEMORY_LIMIT = 50 * 1024 * 1024;
export const DEFAULT_MAX_STACK_SIZE = 320 * 1024;
export const DEFAULT_EXECUTION_TIMEOUT = 30_000;

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

/**
 * Sandboxed JavaScript REPL session backed by QuickJS WASM.
 *
 * Use `ReplSession.getOrCreate()` to obtain a session (deduped by `threadId`),
 * then `session.eval(code, timeoutMs)` to execute code.
 */
export class ReplSession {
  private static sessions = new Map<string, ReplSession>();

  readonly runtime: QuickJSAsyncRuntime;
  readonly context: QuickJSAsyncContext;
  readonly logs: string[] = [];

  private _backend: BackendProtocol | null = null;
  private _envRestrictions = new Map<
    string,
    { realValue: string; allowedTools: Set<string> | null }
  >();

  private constructor(
    runtime: QuickJSAsyncRuntime,
    context: QuickJSAsyncContext,
  ) {
    this.runtime = runtime;
    this.context = context;
    this.setupConsole();
  }

  get backend(): BackendProtocol | null {
    return this._backend;
  }

  /**
   * Retrieve an existing session by threadId, or null if none exists.
   */
  static get(threadId: string): ReplSession | null {
    return ReplSession.sessions.get(threadId) ?? null;
  }

  /**
   * Create or retrieve a session for the given threadId.
   *
   * Sessions are deduped by threadId — calling `getOrCreate` twice with the
   * same threadId returns the same instance. VFS and PTC tools are
   * injected once at creation time.
   */
  static async getOrCreate(
    threadId: string,
    options: ReplSessionOptions = {},
  ): Promise<ReplSession> {
    const existing = ReplSession.sessions.get(threadId);
    if (existing) return existing;

    const {
      memoryLimitBytes = DEFAULT_MEMORY_LIMIT,
      maxStackSizeBytes = DEFAULT_MAX_STACK_SIZE,
      backend,
      tools,
      env,
    } = options;

    const asyncModule = await getAsyncModule();
    const runtime: QuickJSAsyncRuntime = asyncModule.newRuntime();
    runtime.setMemoryLimit(memoryLimitBytes);
    runtime.setMaxStackSize(maxStackSizeBytes);

    const context: QuickJSAsyncContext = runtime.newContext();
    const session = new ReplSession(runtime, context);

    if (backend) {
      session._backend = backend;
    }
    if (env) {
      session.injectEnv(env);
    }
    session.injectVfs();
    if (tools && tools.length > 0) {
      session.injectTools(tools);
    }

    ReplSession.sessions.set(threadId, session);
    return session;
  }

  /**
   * Evaluate code in this session.
   *
   * Code is transformed via an AST pipeline that strips TypeScript syntax,
   * hoists top-level declarations to globalThis for cross-eval persistence,
   * auto-returns the last expression, and wraps in an async IIFE.
   */
  async eval(code: string, timeoutMs: number): Promise<ReplResult> {
    this.logs.length = 0;

    if (timeoutMs >= 0) {
      this.runtime.setInterruptHandler(
        shouldInterruptAfterDeadline(Date.now() + timeoutMs),
      );
    } else {
      this.runtime.setInterruptHandler(() => false);
    }

    const transformed = transformForEval(code);
    const result = await this.context.evalCodeAsync(transformed);

    if (result.error) {
      const error = this.context.dump(result.error);
      result.error.dispose();
      return { ok: false, error, logs: [...this.logs] };
    }

    const promiseState = this.context.getPromiseState(result.value);

    if (promiseState.type === "fulfilled") {
      if (promiseState.notAPromise) {
        const value = this.context.dump(result.value);
        result.value.dispose();
        return { ok: true, value, logs: [...this.logs] };
      }
      const value = this.context.dump(promiseState.value);
      promiseState.value.dispose();
      result.value.dispose();
      return { ok: true, value, logs: [...this.logs] };
    }

    if (promiseState.type === "rejected") {
      const error = this.context.dump(promiseState.error);
      promiseState.error.dispose();
      result.value.dispose();
      return { ok: false, error, logs: [...this.logs] };
    }

    const noTimeout = timeoutMs < 0;
    const deadline = noTimeout ? Infinity : Date.now() + timeoutMs;
    while (noTimeout || Date.now() < deadline) {
      this.context.runtime.executePendingJobs();
      const state = this.context.getPromiseState(result.value);
      if (state.type === "fulfilled") {
        const value = this.context.dump(state.value);
        state.value.dispose();
        result.value.dispose();
        return { ok: true, value, logs: [...this.logs] };
      }
      if (state.type === "rejected") {
        const error = this.context.dump(state.error);
        state.error.dispose();
        result.value.dispose();
        return { ok: false, error, logs: [...this.logs] };
      }
      await new Promise((r) => setTimeout(r, 1));
    }

    result.value.dispose();
    return {
      ok: false,
      error: { message: "Promise timed out — execution interrupted" },
      logs: [...this.logs],
    };
  }

  dispose(): void {
    try {
      this.context.dispose();
    } catch {
      /* may already be disposed */
    }
    try {
      this.runtime.dispose();
    } catch {
      /* may already be disposed */
    }
  }

  /**
   * Clear the static session cache. Useful for testing.
   * @internal
   */
  static clearCache(): void {
    ReplSession.sessions.clear();
  }

  private setupConsole(): void {
    const context = this.context;
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
    const context = this.context;
    const session = this;

    const readFileHandle = context.newFunction(
      "readFile",
      (pathHandle: QuickJSHandle) => {
        const backend = session._backend;
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
            const fileData = await backend.readRaw(path);
            const val = context.newString(fileData.content.join("\n"));
            promise.resolve(val);
            val.dispose();
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
        const backend = session._backend;
        if (!backend) {
          const promise = context.newPromise();
          const err = context.newError("Backend not available");
          promise.reject(err);
          err.dispose();
          promise.settled.then(context.runtime.executePendingJobs);
          return promise.handle;
        }
        const path = context.getString(pathHandle);
        const content = context.getString(contentHandle);
        const promise = context.newPromise();
        (async () => {
          try {
            session.blockEnvLeaks(path, content);
            const result = await backend.write(path, content);
            if (result.error) {
              const err = context.newError(
                `Write failed for '${path}': ${result.error}`,
              );
              promise.reject(err);
              err.dispose();
            } else {
              promise.resolve(context.undefined);
            }
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            const err = context.newError(`Write failed for '${path}': ${msg}`);
            promise.reject(err);
            err.dispose();
          }
          promise.settled.then(context.runtime.executePendingJobs);
        })();
        return promise.handle;
      },
    );
    context.setProp(context.global, "writeFile", writeFileHandle);
    writeFileHandle.dispose();
  }

  private injectEnv(env: EnvConfig): void {
    const context = this.context;
    const envHandle = context.newObject();

    for (const [key, entry] of Object.entries(env)) {
      if (!isEnvVarConfig(entry)) {
        const strHandle = context.newString(entry);
        context.setProp(envHandle, key, strHandle);
        strHandle.dispose();
        continue;
      }

      const allowedTools = entry.allowedTools
        ? new Set(entry.allowedTools)
        : null;
      const visibleValue = entry.secret ? secretRef(key) : entry.value;

      if (entry.secret || allowedTools) {
        this._envRestrictions.set(visibleValue, {
          realValue: entry.value,
          allowedTools,
        });
      }

      const handle = context.newString(visibleValue);
      context.setProp(envHandle, key, handle);
      handle.dispose();
    }

    context.setProp(context.global, "env", envHandle);
    envHandle.dispose();
  }

  private blockEnvLeaks(...values: string[]): void {
    if (this._envRestrictions.size === 0) return;
    for (const v of values) {
      for (const [visibleValue] of this._envRestrictions) {
        if (v.includes(visibleValue)) {
          throw new Error(
            "Env access denied: cannot write restricted environment variable values to files",
          );
        }
      }
    }
  }

  private checkEnvAccess(
    input: Record<string, unknown>,
    toolName: string,
  ): Record<string, unknown> {
    if (this._envRestrictions.size === 0) return input;

    const strings = collectStrings(input);
    const needsRewrite: Array<[string, string]> = [];

    for (const s of strings) {
      const restriction = this._envRestrictions.get(s);
      if (!restriction) continue;
      if (restriction.allowedTools && !restriction.allowedTools.has(toolName)) {
        throw new Error(
          `Env access denied: tool '${toolName}' is not allowed to use this environment variable`,
        );
      }
      if (s !== restriction.realValue) {
        needsRewrite.push([s, restriction.realValue]);
      }
    }

    if (needsRewrite.length === 0) return input;

    let serialized = JSON.stringify(input);
    for (const [ref, real] of needsRewrite) {
      serialized = serialized
        .split(ref)
        .join(real.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
    }
    return JSON.parse(serialized);
  }

  private injectTools(tools: StructuredToolInterface[]): void {
    const context = this.context;
    const session = this;
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
              const resolvedInput = session.checkEnvAccess(
                rawInput as Record<string, unknown>,
                t.name,
              );
              const result = await t.invoke(resolvedInput);
              const val = context.newString(
                typeof result === "string" ? result : JSON.stringify(result),
              );
              promise.resolve(val);
              val.dispose();
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
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
