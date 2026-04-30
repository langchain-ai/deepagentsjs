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
 */

import { shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { QuickJSHandle } from "quickjs-emscripten";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
} from "quickjs-emscripten-core";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { loadSkill, type LoadedSkill } from "./skills.js";
import type { ReplSessionOptions, ReplResult, SkillsContext } from "./types.js";
import { toCamelCase } from "./utils.js";
import { transformForEval } from "./transform.js";

export const DEFAULT_MEMORY_LIMIT = 50 * 1024 * 1024;
export const DEFAULT_MAX_STACK_SIZE = 320 * 1024;
export const DEFAULT_EXECUTION_TIMEOUT = 30_000;
export const DEFAULT_SESSION_ID = "__default__";

// The variant descriptor (WASM binary + glue) is safe to share across sessions;
// only the instantiated module carries asyncify state. Import once, instantiate per session.
const variantImport = import("@jitl/quickjs-ng-wasmfile-release-asyncify");

// Each ReplSession needs its own WASM module. The asyncify WASM variant allows only one
// concurrent async call per module instance, and multi-file skill imports (2+ unwind/rewind
// cycles inside a single evalCodeAsync) leave the module's asyncify state corrupted after
// the owning runtime is disposed — new runtimes on the same module silently skip module
// loader callbacks. A fresh instantiation per session gives each session clean asyncify state.
async function newAsyncModule() {
  const variant = await variantImport;
  return newQuickJSAsyncWASMModuleFromVariant(
    (variant.default ?? variant) as any,
  );
}

// After a successful asyncify unwind/rewind cycle, a rejected module loader
// Promise causes a WASM crash ("memory access out of bounds"). The rejection
// path in quickjs-emscripten's `maybeAsyncFn` catch block calls
// `context.throw(error)` — a WASM FFI call while the asyncify stack is still
// unwound — which corrupts memory. To avoid this, the module loader must never
// reject. This helper returns source code that throws at evaluation time inside
// the VM instead.
//
// The thrown value is a plain object (not `new Error()`) because QuickJS stores
// Error's `name` and `message` as non-enumerable properties (per spec), which
// causes `context.dump()` (JSON.stringify) to return `{}`.
function makeErrorSource(message: string): string {
  return `throw { name: "Error", message: ${JSON.stringify(message)} };`;
}

/**
 * Parse a canonicalized skill specifier into `{ name, rel }`.
 * Returns `undefined` for anything that isn't a valid `@/skills/<name>` or
 * `@/skills/<name>/<rel>` shape. `rel` is absent for the bare form.
 */
function parseSkillSpecifier(
  specifier: string,
): { name: string; rel?: string } | undefined {
  const prefix = "@/skills/";
  if (!specifier.startsWith(prefix)) {
    return;
  }

  const tail = specifier.slice(prefix.length);
  const slashIdx = tail.indexOf("/");
  const name = slashIdx === -1 ? tail : tail.slice(0, slashIdx);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return;
  }

  const rel = slashIdx === -1 ? undefined : tail.slice(slashIdx + 1);
  if (rel !== undefined && rel === "") {
    return;
  }

  return { name, rel };
}

/**
 * Return the `@/skills/<name>` prefix for the skill that owns `base`, or `undefined`.
 */
function matchSkillPrefix(base: string): string | undefined {
  const parsed = parseSkillSpecifier(base);
  if (parsed === undefined) {
    return;
  }
  return `@/skills/${parsed.name}`;
}

/**
 * Return the directory portion of a slash-separated specifier path.
 */
function posixDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx === -1) {
    return "";
  }
  return p.slice(0, idx);
}

/**
 * POSIX join for slash-separated specifiers. Avoids `node:path/posix`
 * since session.ts is consumed in browser bundles.
 */
function posixJoin(base: string, rel: string): string {
  const out: string[] = [];

  const segments = `${base}/${rel}`.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      out.pop();
      continue;
    }

    out.push(segment);
  }

  return out.join("/");
}

/**
 * Sandboxed JavaScript REPL session backed by QuickJS WASM.
 *
 * Serializable — holds an `id` that keys into a static session map.
 * The QuickJS runtime is lazily started on the first `.eval()` call
 * and reconnected if a session with the same id already exists.
 * This makes it safe to store in LangGraph state across interrupts.
 */
export class ReplSession {
  private static sessions = new Map<string, ReplSession>();

  readonly id: string;

  private runtime: QuickJSAsyncRuntime | null = null;
  private context: QuickJSAsyncContext | null = null;
  private logs: string[] = [];
  private options: ReplSessionOptions;
  private skillsContext: SkillsContext | undefined;
  private skillsLoaded: Map<string, LoadedSkill> = new Map();
  private skillsFailed: Map<string, Error> = new Map();

  constructor(id: string, options: ReplSessionOptions = {}) {
    this.id = id;
    this.options = options;
  }

  private async ensureStarted(): Promise<void> {
    if (this.runtime) return;

    const {
      memoryLimitBytes = DEFAULT_MEMORY_LIMIT,
      maxStackSizeBytes = DEFAULT_MAX_STACK_SIZE,
      tools,
      skillsEnabled = false,
    } = this.options;

    const asyncModule = await newAsyncModule();
    const runtime: QuickJSAsyncRuntime = asyncModule.newRuntime();
    runtime.setMemoryLimit(memoryLimitBytes);
    runtime.setMaxStackSize(maxStackSizeBytes);

    const context: QuickJSAsyncContext = runtime.newContext();
    this.runtime = runtime;
    this.context = context;

    this.setupConsole();

    if (tools !== undefined && tools.length > 0) {
      this.injectTools(tools);
    }

    if (skillsEnabled) {
      this.installModuleLoader();
    }
  }

  /**
   * Load the skill into cache on first access and replay cached errors.
   */
  private async ensureSkillLoaded(name: string): Promise<LoadedSkill> {
    const cached = this.skillsLoaded.get(name);
    if (cached !== undefined) {
      return cached;
    }

    const cachedError = this.skillsFailed.get(name);
    if (cachedError !== undefined) {
      throw cachedError;
    }

    const ctx = this.skillsContext;
    if (ctx === undefined) {
      throw new Error(
        `Skill '${name}' referenced but skills are not configured for this session`,
      );
    }

    const metadata = ctx.metadata.find((m) => m.name === name);
    if (metadata === undefined) {
      throw new Error(
        `Skill '${name}' referenced but not available on this agent`,
      );
    }

    try {
      const loaded = await loadSkill(metadata, ctx.backend);
      this.skillsLoaded.set(name, loaded);
      return loaded;
    } catch (err) {
      this.skillsFailed.set(name, err as Error);
      throw err;
    }
  }

  private async resolveSpecifier(specifier: string): Promise<string> {
    const parsed = parseSkillSpecifier(specifier);
    if (parsed === undefined) {
      return makeErrorSource(`Module not found: ${specifier}`);
    }

    let loaded: LoadedSkill;
    try {
      loaded = await this.ensureSkillLoaded(parsed.name);
    } catch (err) {
      return makeErrorSource((err as Error).message ?? String(err));
    }

    if (parsed.rel === undefined) {
      const source = loaded.files.get(loaded.entryRel);
      if (source === undefined) {
        return makeErrorSource(
          `Skill '${parsed.name}': entrypoint '${loaded.entryRel}' missing from bundle`,
        );
      }
      return source;
    }

    const source = loaded.files.get(parsed.rel);
    if (source === undefined) {
      return makeErrorSource(
        `Skill '${parsed.name}': '${parsed.rel}' not found in bundle`,
      );
    }

    return source;
  }

  /**
   * Canonicalize an `import` specifier. Bare specifiers pass through;
   * relative specifiers are resolved against the importing module's path.
   * Traversal out of a skill's `@/skills/<name>/` namespace is rejected.
   */
  private normalizeSpecifier(base: string, requested: string): string {
    const isRelative =
      requested.startsWith("./") || requested.startsWith("../");
    if (!isRelative) {
      return requested;
    }

    // A bare skill specifier like "@/skills/my-skill" has no file component, so
    // posixDirname would return "@/skills". Treat the bare specifier itself as
    // the directory so that "./lib/math.js" resolves to "@/skills/my-skill/lib/math.js".
    const parsed = parseSkillSpecifier(base);
    const baseDir =
      parsed !== undefined && parsed.rel === undefined
        ? base
        : posixDirname(base);
    const resolved = posixJoin(baseDir, requested);

    const skillPrefix = matchSkillPrefix(base);
    if (skillPrefix === undefined) {
      return resolved;
    }

    if (!resolved.startsWith(`${skillPrefix}/`)) {
      return `__resolve_error__:${requested} escapes ${skillPrefix}`;
    }

    return resolved;
  }

  /**
   * Wire the QuickJS module loader and normalizer on this session's runtime.
   */
  private installModuleLoader(): void {
    if (this.runtime === null) {
      return;
    }

    this.runtime.setModuleLoader(
      async (specifier: string) => this.resolveSpecifier(specifier),
      (base: string, requested: string) =>
        this.normalizeSpecifier(base, requested),
    );
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
   * Returns true if any session exists whose key equals `threadId` or starts
   * with `threadId:`. Useful for tests that need to confirm a session was
   * created without knowing the full `threadId:middlewareId` key.
   */
  static hasAnyForThread(threadId: string): boolean {
    const prefix = `${threadId}:`;
    for (const key of ReplSession.sessions.keys()) {
      if (key === threadId || key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Dispose and remove the session with the given key, if it exists.
   */
  static deleteSession(key: string): void {
    const session = ReplSession.sessions.get(key);
    if (session) {
      session.dispose();
    }
  }

  /**
   * Push the current skills metadata + backend into the session.
   * Called by the middleware once per `js_eval` invocation, before eval runs.
   * Pass `undefined` to clear the context (no skill imports will resolve).
   */
  setSkillsContext(ctx?: SkillsContext): void {
    this.skillsContext = ctx;
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
    return {
      ok: false,
      error: { message: "Promise timed out — execution interrupted" },
      logs: [...this.logs],
    };
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
