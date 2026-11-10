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

import type { QuickJSHandle } from "quickjs-emscripten";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
  QuickJSAsyncWASMModule,
  QuickJSDeferredPromise,
} from "quickjs-emscripten-core";
import type { StructuredToolInterface } from "@langchain/core/tools";

import { PTCCallBudgetExceededError } from "./errors.js";
import type {
  ReplSessionOptions,
  ReplResult,
  SubagentBridgeOptions,
} from "./types.js";
import { toCamelCase } from "./utils.js";
import { unwrapToolEnvelope } from "./coerce.js";
import { transformForEval } from "./transform.js";
import { AsyncEvalQueue } from "./eval-queue.js";
import PQueue from "p-queue";

export const DEFAULT_MEMORY_LIMIT = 64 * 1024 * 1024;
export const DEFAULT_MAX_STACK_SIZE = 320 * 1024;
export const DEFAULT_EXECUTION_TIMEOUT = 5_000;
export const DEFAULT_SESSION_ID = "__default__";
export const DEFAULT_MAX_PTC_CALLS = 256;
export const DEFAULT_MAX_RESULTS_CHARS = 4000;
export const DEFAULT_MAX_SUBAGENT_CONCURRENCY = 32;

const LINE_NUMBER_RE = /^\s*\d+(?:\.\d+)?\t/;

const READ_STATUS_HEADER_RE =
  /^@@ lines (\d+)-(\d+)(?: of \d+)?(?: \| .*)? @@$/;

// Matches only fs.ts's two known notices, by opening clause (not full prose, to survive wording tweaks) — anything else bracketed is real content.
const READ_NOTICE_RE =
  /^\[(?:Output was truncated due to size limits|Requested offset -?\d+(?:\.\d+)? is before the start of the file)\b.*\]$/;

// Bounds how far down the string `stripLineNumbers` looks for the header, so real content that merely looks like one isn't mistaken for it.
const MAX_READ_NOTICE_LINES = 2;

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

/**
 * Unwrap a PTC tool result to a plain string for use inside QuickJS.
 *
 * Tool results may arrive as a raw string, or as an array of LangChain
 * content blocks (`{ type: "text", text: "..." }`). Blocks are joined
 * with newlines; non-text block types are silently skipped. Anything
 * else (objects, nulls) is JSON-serialised as a fallback.
 *
 * @param result - Raw return value from `tool.invoke()`.
 * @returns Plain string representation of the tool output.
 */
function extractToolText(result: unknown): string {
  // Unwrap LangChain Command / ToolMessage / message-list envelopes (e.g. a
  // PTC tool that returns a Command) before extracting text.
  result = unwrapToolEnvelope(result);

  if (typeof result === "string") {
    return result;
  }

  if (Array.isArray(result)) {
    const texts: string[] = [];
    for (const block of result) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        texts.push((block as Record<string, unknown>).text as string);
      }
    }

    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  return JSON.stringify(result);
}

/**
 * Remove the `cat -n` line-number prefix from every line of a string, or
 * the newer `@@ lines A-B ... @@` status header `read_file` now uses instead.
 *
 * The filesystem backend formats file content with line numbers in the
 * form `"     N\t"` so human readers can navigate by line. That prefix
 * is useful for the agent but noise for QuickJS code that parses the
 * text programmatically (e.g. swarm reading `/context.txt`).
 *
 * The function is conservative: if neither format matches, the text is
 * returned unchanged so nothing is silently corrupted.
 *
 * @param text - Raw file content, possibly line-number or header prefixed.
 * @returns Content with the prefix or header stripped, or the original
 *          text if it doesn't match either expected format.
 */
function stripLineNumbers(text: string): string {
  const lines = text.split("\n");
  if (lines.length === 0) {
    return text;
  }

  const headerIndex = lines
    .slice(0, MAX_READ_NOTICE_LINES + 1)
    .findIndex((l) => READ_STATUS_HEADER_RE.test(l));
  if (
    headerIndex !== -1 &&
    lines.slice(0, headerIndex).every((l) => READ_NOTICE_RE.test(l))
  ) {
    return lines.slice(headerIndex + 1).join("\n");
  }

  if (!lines.every((l) => l === "" || LINE_NUMBER_RE.test(l))) {
    return text;
  }

  return lines.map((l) => l.replace(LINE_NUMBER_RE, "")).join("\n");
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

interface HostCall {
  promise: QuickJSDeferredPromise;
  kind: "tool" | "task";
  /** The eval stopped waiting on it: its result must not reach the guest. */
  detached: boolean;
  /** Its promise and resolvers have been disposed. */
  freed: boolean;
}

function errorMessage(e: unknown): string {
  return e != null && typeof (e as Error).message === "string"
    ? (e as Error).message
    : String(e);
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
  private readonly maxPtcCalls: number | null;
  private ptcCallsRemaining: number | null = null;
  private subagentQueue: PQueue | null = null;
  private bridgeDispatchRef: {
    current: SubagentBridgeOptions["dispatch"];
  } | null = null;
  /** Guest execution time charged to the current eval's budget. */
  private executionMs = 0;
  /** Start of the guest execution currently running, if any. */
  private executionStartedAt: number | null = null;
  /** `tools.*` and `task()` calls the current eval is still waiting on. */
  private inFlight = new Set<HostCall>();
  /** Calls an eval stopped waiting on; their results are dropped when they settle. */
  private detached = new Set<HostCall>();
  /** Handles the running eval holds across an await; `dispose()` frees them. */
  private heldHandles = new Set<QuickJSHandle>();
  /** Tail of the evals queued on this session; they run one at a time. */
  private evalChain: Promise<unknown> = Promise.resolve();
  /** Bumped by `dispose()`, so evals queued before it don't restart the session. */
  private generation = 0;

  /** Allowed keys in the subagent input object. */
  private static readonly SUBAGENT_ALLOWED_KEYS = new Set([
    "description",
    "subagentType",
    "responseSchema",
  ]);

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

    const { subagentBridge } = this.options;
    if (subagentBridge) {
      this.subagentQueue = new PQueue({
        concurrency: subagentBridge.maxConcurrency,
      });
      this.injectSubagentBridge(subagentBridge.dispatch);
    }

    const sessionId = this.options.sessionId ?? "default";
    const sessionIdHandle = context.newString(sessionId);
    context.setProp(context.global, "__sessionId__", sessionIdHandle);
    sessionIdHandle.dispose();
  }

  /**
   * Run guest code and charge its duration to the eval's execution budget.
   * Re-entrant calls are already covered by the outer measurement.
   */
  private runGuest<T>(fn: () => T): T {
    if (this.executionStartedAt !== null) {
      return fn();
    }
    this.executionStartedAt = Date.now();
    try {
      return fn();
    } finally {
      this.executionMs += Date.now() - this.executionStartedAt;
      this.executionStartedAt = null;
    }
  }

  private async runGuestAsync<T>(fn: () => Promise<T>): Promise<T> {
    if (this.executionStartedAt !== null) {
      return fn();
    }
    this.executionStartedAt = Date.now();
    try {
      return await fn();
    } finally {
      this.executionMs += Date.now() - this.executionStartedAt;
      this.executionStartedAt = null;
    }
  }

  /**
   * Run the runtime's pending jobs as guest execution. An exception that stops
   * the queue (an interrupt included) comes back as a handle this call owns:
   * left undisposed, it keeps an object alive and `JS_FreeRuntime` aborts the
   * shared WASM module when the session is disposed.
   */
  private runPendingJobs(context: QuickJSAsyncContext): void {
    this.runGuest(() => context.runtime.executePendingJobs()).dispose();
  }

  /**
   * Convert a guest value to a host value. `dump` runs guest code
   * (`toJSON`, getters), so it is charged to the budget like any other.
   */
  private dumpGuest(context: QuickJSAsyncContext, handle: QuickJSHandle) {
    return this.runGuest(() => context.dump(handle));
  }

  /**
   * Start a host call that settles a guest promise. Each call belongs to the
   * eval that started it, as in Python's per-eval TaskGroup: the eval waits for
   * it on success and detaches it otherwise, so no call outlives its eval.
   * `work` returns a function that builds the guest value, which runs only if
   * the call is still attached.
   */
  private startHostCall(
    context: QuickJSAsyncContext,
    kind: HostCall["kind"],
    work: () => Promise<() => QuickJSHandle>,
  ): QuickJSHandle {
    const call: HostCall = {
      promise: context.newPromise(),
      kind,
      detached: false,
      freed: false,
    };
    this.inFlight.add(call);
    void (async () => {
      try {
        const toGuest = await work();
        if (!call.detached) {
          const value = toGuest();
          call.promise.resolve(value);
          value.dispose();
        }
      } catch (e: unknown) {
        if (!call.detached) {
          const err = context.newError(errorMessage(e));
          call.promise.reject(err);
          err.dispose();
        }
      } finally {
        this.inFlight.delete(call);
        if (this.detached.delete(call)) this.freeHostCall(call);
      }
      if (!call.detached) {
        call.promise.settled.then(() => this.runPendingJobs(context));
      }
    })();
    return call.promise.handle;
  }

  private hold(handle: QuickJSHandle): void {
    this.heldHandles.add(handle);
  }

  /** Free a handle the eval held, unless `dispose()` already has. */
  private release(handle: QuickJSHandle): void {
    this.heldHandles.delete(handle);
    if (handle.alive) handle.dispose();
  }

  /** Stop waiting on the current eval's calls; they no longer touch the guest. */
  private detachInFlight(): void {
    for (const call of this.inFlight) {
      call.detached = true;
      this.detached.add(call);
    }
    this.inFlight.clear();
  }

  /**
   * Free a call's promise and resolvers. A call left holding them when the
   * session is disposed makes `JS_FreeRuntime` abort the shared WASM module.
   */
  private freeHostCall(call: HostCall): void {
    if (call.freed) return;
    call.freed = true;
    try {
      call.promise.dispose();
    } catch {
      /* the context may already be gone */
    }
  }

  /**
   * Run the eval's un-awaited host calls to completion, as Python's TaskGroup
   * does. Waiting is not charged to the budget; code they resume is.
   */
  private async awaitInFlight(
    context: QuickJSAsyncContext,
    overBudget: () => boolean,
  ): Promise<void> {
    while (
      this.inFlight.size > 0 &&
      !overBudget() &&
      this.context === context
    ) {
      this.runPendingJobs(context);
      if (this.inFlight.size === 0) break;
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  private elapsedExecutionMs(): number {
    return (
      this.executionMs +
      (this.executionStartedAt === null
        ? 0
        : Date.now() - this.executionStartedAt)
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
   * Evaluate code in this session.
   *
   * Lazily starts the QuickJS runtime on the first call. Code is
   * transformed via an AST pipeline that strips TypeScript syntax,
   * hoists top-level declarations to globalThis for cross-eval
   * persistence, auto-returns the last expression, and wraps in an
   * async IIFE.
   */
  async eval(code: string, timeoutMs: number): Promise<ReplResult> {
    // Evals share the session's globals, budget and host calls, so they run
    // one at a time; quickjs_rs likewise refuses concurrent evals on a context.
    // An eval started by a subagent this session's own task() is waiting on
    // would queue behind that wait forever, so it fails fast instead.
    if ([...this.inFlight].some((call) => call.kind === "task")) {
      return Promise.resolve({
        ok: false,
        error: {
          message:
            "REPL session busy: an eval on it is waiting on task(). Run this again once that eval finishes.",
        },
        logs: [],
        logsDroppedChars: 0,
      });
    }
    const generation = this.generation;
    const run = this.evalChain.then(() =>
      this.generation === generation
        ? this.runEval(code, timeoutMs, generation)
        : {
            ok: false,
            error: { message: "Session disposed before the eval started" },
            logs: [],
            logsDroppedChars: 0,
          },
    );
    this.evalChain = run.catch(() => undefined);
    return run;
  }

  private async runEval(
    code: string,
    timeoutMs: number,
    generation: number,
  ): Promise<ReplResult> {
    await this.ensureStarted();
    if (this.generation !== generation) {
      // Disposed while starting up: free the runtime that was just built.
      this.dispose();
      return {
        ok: false,
        error: { message: "Session disposed before the eval started" },
        logs: [],
        logsDroppedChars: 0,
      };
    }
    const runtime = this.runtime!;
    const context = this.context!;

    const drainLogs = (): { logs: string[]; logsDroppedChars: number } => {
      const [raw, dropped] = this.consoleBuffer.drain();
      return {
        logs: raw.length > 0 ? raw.split("\n").filter((l) => l.length > 0) : [],
        logsDroppedChars: dropped,
      };
    };

    this.resetPtcBudget();
    this.executionMs = 0;
    // The budget covers guest execution only, like the Python middleware's
    // `timeout`: time spent awaiting `tools.*` / `task()`, or queued behind
    // other sessions' evals, is not counted.
    const noTimeout = timeoutMs < 0;
    const overBudget = () =>
      !noTimeout && this.elapsedExecutionMs() > timeoutMs;
    // Records that the handler stopped guest code, so a dump it cut short is
    // reported as a timeout rather than as the fallback string `dump` returns.
    let interrupted = false;
    const interruptHandler = () => {
      if (!overBudget()) return false;
      interrupted = true;
      return true;
    };
    const timedOut = (): ReplResult => ({
      ok: false,
      error: { message: "Promise timed out — execution interrupted" },
      ...drainLogs(),
    });
    /** Convert and free a settled value or reason. */
    const settle = (ok: boolean, handle: QuickJSHandle): ReplResult => {
      interrupted = false;
      const dumped = this.dumpGuest(context, handle);
      this.release(handle);
      if (interrupted) return timedOut();
      return ok
        ? { ok: true, value: dumped, ...drainLogs() }
        : { ok: false, error: dumped, ...drainLogs() };
    };
    const disposed = () => this.context !== context;
    const sessionDisposed = (): ReplResult => ({
      ok: false,
      error: { message: "Session disposed while the eval was running" },
      ...drainLogs(),
    });
    /**
     * Wait for the eval's un-awaited calls. Code they resume runs under the
     * budget, so an interrupt there, or calls still running when it runs out,
     * make the eval a timeout.
     */
    const finishCalls = async (): Promise<ReplResult | null> => {
      interrupted = false;
      await this.awaitInFlight(context, overBudget);
      if (disposed()) return sessionDisposed();
      if (interrupted || this.inFlight.size > 0) return timedOut();
      return null;
    };
    try {
      runtime.setInterruptHandler(interruptHandler);

      const transformed = transformForEval(code);
      const result = await sharedEvalQueue.enqueue(() =>
        disposed()
          ? Promise.resolve(null)
          : this.runGuestAsync(() => context.evalCodeAsync(transformed)),
      );
      if (result === null || disposed()) return sessionDisposed();

      if (result.error) {
        return settle(false, result.error);
      }

      const promiseState = context.getPromiseState(result.value);

      if (promiseState.type === "fulfilled") {
        this.hold(result.value);
        if (!promiseState.notAPromise) this.hold(promiseState.value);
        const failed = await finishCalls();
        if (failed) {
          if (!promiseState.notAPromise) this.release(promiseState.value);
          this.release(result.value);
          return failed;
        }
        if (promiseState.notAPromise) {
          return settle(true, result.value);
        }
        const settled = settle(true, promiseState.value);
        this.release(result.value);
        return settled;
      }

      if (promiseState.type === "rejected") {
        const settled = settle(false, promiseState.error);
        result.value.dispose();
        return settled;
      }

      this.hold(result.value);

      while (!overBudget()) {
        this.runPendingJobs(context);
        const state = context.getPromiseState(result.value);
        if (state.type === "fulfilled") {
          this.hold(state.value);
          const failed = await finishCalls();
          if (failed) {
            this.release(state.value);
            this.release(result.value);
            return failed;
          }
          const settled = settle(true, state.value);
          this.release(result.value);
          return settled;
        }
        if (state.type === "rejected") {
          const settled = settle(false, state.error);
          this.release(result.value);
          return settled;
        }
        // A job stopped for running over budget leaves the promise pending.
        if (overBudget()) break;
        // The guest has no timers or I/O of its own, so with no host call in
        // flight nothing can ever settle the promise.
        if (this.inFlight.size === 0) {
          this.release(result.value);
          return {
            ok: false,
            error: {
              message: "Promise never settles — nothing it awaits is pending",
            },
            ...drainLogs(),
          };
        }
        await new Promise((r) => setTimeout(r, 1));
        if (disposed()) return sessionDisposed();
      }

      this.release(result.value);
      return timedOut();
    } finally {
      this.detachInFlight();
      this.ptcCallsRemaining = null;
    }
  }

  dispose(): void {
    this.generation++;
    this.detachInFlight();
    for (const call of this.detached) this.freeHostCall(call);
    this.detached.clear();
    for (const handle of this.heldHandles) {
      try {
        if (handle.alive) handle.dispose();
      } catch {
        /* may already be disposed */
      }
    }
    this.heldHandles.clear();
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
    // A stale instance must not remove the session that replaced it.
    if (ReplSession.sessions.get(this.id) === this) {
      ReplSession.sessions.delete(this.id);
    }
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
          return this.startHostCall(context, "tool", async () => {
            try {
              this.consumePtcBudget(camelName);
              const rawInput =
                typeof input === "object" && input !== null ? input : {};
              const result = await t.invoke(rawInput);
              let text = extractToolText(result);
              if (t.name === "read_file") {
                text = stripLineNumbers(text);
              }
              return () => context.newString(text);
            } catch (e: unknown) {
              throw new Error(`Tool '${t.name}' failed: ${errorMessage(e)}`, {
                cause: e,
              });
            }
          });
        },
      );
      context.setProp(toolsNs, camelName, fnHandle);
      fnHandle.dispose();
    }

    context.setProp(context.global, "tools", toolsNs);
    toolsNs.dispose();
  }

  /**
   * Install the `task` global on the QuickJS context.
   *
   * Registers the host function directly as `globalThis.task`,
   * then freezes it via `evalCode`. Structured results (when
   * responseSchema is provided) are marshaled into native QuickJS
   * objects on the host side — no JS wrapper needed.
   */
  /**
   * Replace the active bridge dispatch with a fresh one.
   *
   * Call this before each eval so the dispatch closure carries
   * the current invocation's config (tracing callbacks, run ID, etc.)
   * rather than the stale config from session creation.
   */
  updateBridgeDispatch(dispatch: SubagentBridgeOptions["dispatch"]): void {
    if (this.bridgeDispatchRef) {
      this.bridgeDispatchRef.current = dispatch;
    }
  }

  private injectSubagentBridge(
    dispatch: SubagentBridgeOptions["dispatch"],
  ): void {
    const context = this.context!;
    const queue = this.subagentQueue!;

    this.bridgeDispatchRef = { current: dispatch };
    const ref = this.bridgeDispatchRef;

    const hostFn = context.newFunction("task", (inputHandle: QuickJSHandle) => {
      const input = context.dump(inputHandle);

      return this.startHostCall(context, "task", async () => {
        if (
          input == null ||
          typeof input !== "object" ||
          Array.isArray(input)
        ) {
          throw new Error("task: expected an object argument");
        }
        const raw = input as Record<string, unknown>;

        // Accept snake_case aliases so models don't need to know our convention
        const obj: Record<string, unknown> = { ...raw };
        if ("subagent_type" in obj) {
          obj.subagentType ??= obj.subagent_type;
          delete obj.subagent_type;
        }
        if ("response_schema" in obj) {
          obj.responseSchema ??= obj.response_schema;
          delete obj.response_schema;
        }

        const unknownKeys = Object.keys(obj).filter(
          (k) => !ReplSession.SUBAGENT_ALLOWED_KEYS.has(k),
        );
        if (unknownKeys.length > 0) {
          throw new Error(
            `task: unknown keys: ${unknownKeys.join(", ")}. ` +
              `Allowed: ${[...ReplSession.SUBAGENT_ALLOWED_KEYS].join(", ")}`,
          );
        }

        const { description, subagentType, responseSchema } = obj;

        if (typeof description !== "string" || description.length === 0) {
          throw new Error(
            "task: 'description' is required and must be a non-empty string",
          );
        }
        if (typeof subagentType !== "string" || subagentType.length === 0) {
          throw new Error(
            "task: 'subagentType' is required and must be a non-empty string",
          );
        }
        if (
          responseSchema !== undefined &&
          (responseSchema == null ||
            typeof responseSchema !== "object" ||
            Array.isArray(responseSchema))
        ) {
          throw new Error(
            "task: 'responseSchema' must be a plain object (JSON Schema) when provided",
          );
        }

        const result = await queue.add(() =>
          ref.current({
            description: description as string,
            subagentType: subagentType as string,
            ...(responseSchema !== undefined && {
              responseSchema: responseSchema as Record<string, unknown>,
            }),
          }),
        );
        if (typeof result === "string") {
          return () => context.newString(result);
        }
        return () => {
          const jsonResult = context.evalCode(`(${JSON.stringify(result)})`);
          if (jsonResult.error) {
            const errDump = context.dump(jsonResult.error);
            jsonResult.error.dispose();
            throw new Error(
              `task: failed to marshal structured response: ${JSON.stringify(errDump)}`,
            );
          }
          return jsonResult.value;
        };
      });
    });

    context.setProp(context.global, "task", hostFn);
    hostFn.dispose();

    context.evalCode(
      "Object.freeze(globalThis.task);" +
        "Object.defineProperty(globalThis, 'task', {" +
        " value: globalThis.task," +
        " writable: false," +
        " configurable: false," +
        "}); undefined",
    );
  }
}
