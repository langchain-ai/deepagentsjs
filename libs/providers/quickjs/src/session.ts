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
  QuickJSAsyncWASMModule,
} from "quickjs-emscripten-core";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { loadSkill, scanSkillReferences, type LoadedSkill } from "./skills.js";
import { PTCCallBudgetExceededError } from "./errors.js";
import type { ReplSessionOptions, ReplResult, SkillsContext } from "./types.js";
import { toCamelCase } from "./utils.js";
import { transformForEval } from "./transform.js";
import { AsyncEvalQueue } from "./eval-queue.js";

export const DEFAULT_MEMORY_LIMIT = 64 * 1024 * 1024;
export const DEFAULT_MAX_STACK_SIZE = 320 * 1024;
export const DEFAULT_EXECUTION_TIMEOUT = 5_000;
export const DEFAULT_SESSION_ID = "__default__";
export const DEFAULT_MAX_PTC_CALLS = 256;
export const DEFAULT_MAX_RESULTS_CHARS = 4000;

const variantImport = import("@jitl/quickjs-ng-wasmfile-release-asyncify");

/**
 * Process-global eval queue. Serializes all evalCodeAsync calls across
 * sessions to enforce the asyncify one-at-a-time constraint.
 */
const sharedEvalQueue = new AsyncEvalQueue();

/**
 * Process-global WASM module shared by all sessions.
 *
 * Each session creates its own runtime and context on this module,
 * providing full isolation for globals, heap, and stack. The module
 * itself is stateless between runtimes — only the compiled WASM code
 * and Emscripten infrastructure are shared.
 *
 * This is safe because:
 * - The module loader is synchronous (preloaded skill cache), so
 *   imports don't cause asyncify suspensions.
 * - Tool injection uses the promise-based pattern (newFunction +
 *   newPromise), not newAsyncifiedFunction, so tool calls don't
 *   cause asyncify suspensions.
 * - The eval queue serializes evalCodeAsync calls to satisfy the
 *   one-concurrent-async-call-per-module constraint.
 */
let sharedModulePromise: Promise<QuickJSAsyncWASMModule> | undefined;

function getSharedModule(): Promise<QuickJSAsyncWASMModule> {
  if (!sharedModulePromise) {
    sharedModulePromise = (async () => {
      const variant = await variantImport;
      return newQuickJSAsyncWASMModuleFromVariant(
        (variant.default ?? variant) as any,
      );
    })();
  }
  return sharedModulePromise;
}

// The module loader must never reject. A rejected Promise in the loader
// path triggers a WASM FFI call at the wrong point in the asyncify
// lifecycle, which corrupts memory. This helper returns source code that
// throws at evaluation time inside the VM instead.
//
// The thrown value is a plain object (not `new Error()`) because QuickJS
// stores Error's `name` and `message` as non-enumerable properties (per
// spec), which causes `context.dump()` (JSON.stringify) to return `{}`.
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
 * Fixed-size character buffer for capturing console output from the QuickJS VM.
 *
 * Lines are accumulated up to `maxChars`. Once the cap is reached, excess
 * characters are counted as dropped rather than silently discarded without
 * attribution, so callers can surface a truncation notice to the user.
 */
class ConsoleBuffer {
  private readonly maxChars: number;
  private buffer: string = "";
  private droppedChars: number = 0;

  constructor(maxChars: number) {
    this.maxChars = Math.max(maxChars, 0);
  }

  /**
   * Append `line` to the buffer.
   *
   * If the buffer is already full the entire line is counted as dropped.
   * If `line` partially fits, the fitting prefix is stored and the remainder
   * is counted as dropped.
   */
  append(line: string): void {
    const remaining = this.maxChars - this.buffer.length;
    if (remaining <= 0) {
      this.droppedChars += line.length;
      return;
    }

    if (line.length <= remaining) {
      this.buffer += line;
    } else {
      this.buffer += line.slice(0, remaining);
      this.droppedChars += line.length - remaining;
    }
  }

  /**
   * Return the buffered output and dropped-character count as `[buffered,
   * droppedChars]`, then reset both to zero.
   */
  drain(): [string, number] {
    const out = this.buffer;
    const dropped = this.droppedChars;

    this.buffer = "";
    this.droppedChars = 0;

    return [out, dropped];
  }
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
  private consoleBuffer: ConsoleBuffer = new ConsoleBuffer(
    DEFAULT_MAX_RESULTS_CHARS,
  );
  private options: ReplSessionOptions;
  private skillsContext: SkillsContext | undefined;
  private skillsLoaded: Map<string, LoadedSkill> = new Map();
  private skillsFailed: Map<string, Error> = new Map();
  private readonly maxPtcCalls: number | null;
  private ptcCallsRemaining: number | null = null;

  /**
   * Reset the shared WASM module. Forces the next session to instantiate
   * a fresh module. Only needed in tests where module state must be
   * isolated between test files.
   *
   * @internal
   */
  static resetSharedModule(): void {
    sharedModulePromise = undefined;
  }

  constructor(id: string, options: ReplSessionOptions = {}) {
    this.id = id;
    this.options = options;
    this.maxPtcCalls =
      options.maxPtcCalls !== undefined
        ? options.maxPtcCalls
        : DEFAULT_MAX_PTC_CALLS;
  }

  private async ensureStarted(): Promise<void> {
    if (this.runtime) return;

    const {
      memoryLimitBytes = DEFAULT_MEMORY_LIMIT,
      maxStackSizeBytes = DEFAULT_MAX_STACK_SIZE,
      tools,
      skillsEnabled = false,
      maxResultChars = DEFAULT_MAX_RESULTS_CHARS,
      captureConsole = true,
    } = this.options;

    const asyncModule = await getSharedModule();
    const runtime: QuickJSAsyncRuntime = asyncModule.newRuntime();
    runtime.setMemoryLimit(memoryLimitBytes);
    runtime.setMaxStackSize(maxStackSizeBytes);

    const context: QuickJSAsyncContext = runtime.newContext();
    this.runtime = runtime;
    this.context = context;

    this.consoleBuffer = new ConsoleBuffer(maxResultChars);
    if (captureConsole) {
      this.setupConsole();
    }

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

  /**
   * Pre-load all skills referenced in source code into the in-memory
   * cache. Must be called before `evalCodeAsync` so the module loader
   * can resolve synchronously. An async loader would cause asyncify
   * suspensions on each import, which is incompatible with the shared
   * WASM module used by all sessions.
   */
  async preloadReferencedSkills(code: string): Promise<void> {
    const refs = scanSkillReferences(code);
    for (const name of refs) {
      if (this.skillsLoaded.has(name) || this.skillsFailed.has(name)) {
        continue;
      }

      try {
        await this.ensureSkillLoaded(name);
      } catch (err) {
        if (!this.skillsFailed.has(name)) {
          this.skillsFailed.set(name, err as Error);
        }
      }
    }
  }

  /**
   * Resolve a module specifier to source code. Strictly synchronous —
   * only reads from the in-memory skill cache populated by
   * `preloadReferencedSkills`. Returns error source (not a thrown
   * exception) for missing or failed skills so QuickJS reports the
   * error inside the VM.
   */
  private resolveSpecifier(specifier: string): string {
    const parsed = parseSkillSpecifier(specifier);
    if (parsed === undefined) {
      return makeErrorSource(`Module not found: ${specifier}`);
    }

    const cachedError = this.skillsFailed.get(parsed.name);
    if (cachedError !== undefined) {
      return makeErrorSource(cachedError.message ?? String(cachedError));
    }

    const loaded = this.skillsLoaded.get(parsed.name);
    if (loaded === undefined) {
      return makeErrorSource(
        `Skill '${parsed.name}' was not preloaded. ` +
          `Ensure the import specifier is a static string literal ` +
          `(dynamic specifiers like \`import("@/skills/" + name)\` are not supported).`,
      );
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

    let source = loaded.files.get(parsed.rel);
    // TS convention: source files use .ts but import specifiers use .js
    if (source === undefined && parsed.rel.endsWith(".js")) {
      source = loaded.files.get(parsed.rel.slice(0, -3) + ".ts");
    }
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
   *
   * The loader is strictly synchronous — it reads from the in-memory skill
   * cache populated by `preloadReferencedSkills`. This is critical: an async
   * module loader causes asyncify suspensions on each import, and disposing
   * a runtime after multi-file imports corrupts the shared module's asyncify
   * state, silently breaking the loader for all subsequent sessions.
   */
  private installModuleLoader(): void {
    if (this.runtime === null) {
      return;
    }

    this.runtime.setModuleLoader(
      (specifier: string) => this.resolveSpecifier(specifier),
      (base: string, requested: string) =>
        this.normalizeSpecifier(base, requested),
    );
  }

  /**
   * Initialise the per-eval PTC counter. Called at the top of every `eval()`.
   */
  private resetPtcBudget(): void {
    this.ptcCallsRemaining =
      this.maxPtcCalls === null ? null : this.maxPtcCalls;
  }

  /**
   * Decrement the PTC call counter and throw if the budget is exhausted.
   * `null` budget means unlimited — returns immediately without decrementing.
   */
  private consumePtcBudget(functionName: string): void {
    if (this.ptcCallsRemaining === null) {
      return;
    }

    if (this.ptcCallsRemaining > 0) {
      this.ptcCallsRemaining--;
      return;
    }

    const limit = this.maxPtcCalls ?? 0;
    throw new PTCCallBudgetExceededError({
      limit,
      attempted: limit + 1,
      functionName,
    });
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
   * Called by the middleware once per `eval` invocation, before eval runs.
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

    // Pre-load referenced skills so the module loader resolves synchronously.
    await this.preloadReferencedSkills(code);

    const drainLogs = (): { logs: string[]; logsDroppedChars: number } => {
      const [raw, dropped] = this.consoleBuffer.drain();
      return {
        logs: raw.length > 0 ? raw.split("\n").filter((l) => l.length > 0) : [],
        logsDroppedChars: dropped,
      };
    };

    this.resetPtcBudget();
    try {
      if (timeoutMs >= 0) {
        runtime.setInterruptHandler(
          shouldInterruptAfterDeadline(Date.now() + timeoutMs),
        );
      } else {
        runtime.setInterruptHandler(() => false);
      }

      const transformed = transformForEval(code);
      const result = await sharedEvalQueue.enqueue(() =>
        context.evalCodeAsync(transformed),
      );

      if (result.error) {
        const error = context.dump(result.error);
        result.error.dispose();
        return { ok: false, error, ...drainLogs() };
      }

      const promiseState = context.getPromiseState(result.value);

      if (promiseState.type === "fulfilled") {
        if (promiseState.notAPromise) {
          const value = context.dump(result.value);
          result.value.dispose();
          return { ok: true, value, ...drainLogs() };
        }
        const value = context.dump(promiseState.value);
        promiseState.value.dispose();
        result.value.dispose();
        return { ok: true, value, ...drainLogs() };
      }

      if (promiseState.type === "rejected") {
        const error = context.dump(promiseState.error);
        promiseState.error.dispose();
        result.value.dispose();
        return { ok: false, error, ...drainLogs() };
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
          return { ok: true, value, ...drainLogs() };
        }
        if (state.type === "rejected") {
          const error = context.dump(state.error);
          state.error.dispose();
          result.value.dispose();
          return { ok: false, error, ...drainLogs() };
        }
        await new Promise((r) => setTimeout(r, 1));
      }

      result.value.dispose();
      return {
        ok: false,
        error: { message: "Promise timed out — execution interrupted" },
        ...drainLogs(),
      };
    } finally {
      this.ptcCallsRemaining = null;
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
          const line =
            method === "log" || method === "info" || method === "debug"
              ? formatted
              : `[${method}] ${formatted}`;
          this.consoleBuffer.append(line + "\n");
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
              this.consumePtcBudget(camelName);
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
