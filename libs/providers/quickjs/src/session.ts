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
 * Remove the `cat -n` line-number prefix from every line of a string.
 *
 * The filesystem backend formats file content with line numbers in the
 * form `"     N\t"` so human readers can navigate by line. That prefix
 * is useful for the agent but noise for QuickJS code that parses the
 * text programmatically (e.g. swarm reading `/context.txt`).
 *
 * The function is conservative: if any non-empty line lacks the prefix,
 * the text is returned unchanged so nothing is silently corrupted.
 *
 * @param text - Raw file content, possibly line-number prefixed.
 * @returns Content with line-number prefixes stripped, or the original
 *          text if it doesn't match the expected format throughout.
 */
function stripLineNumbers(text: string): string {
  const lines = text.split("\n");
  if (lines.length === 0) {
    return text;
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
    await this.ensureStarted();
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
              let text = extractToolText(result);
              if (t.name === "read_file") {
                text = stripLineNumbers(text);
              }
              const val = context.newString(text);
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
      const promise = context.newPromise();

      (async () => {
        try {
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
            const val = context.newString(result);
            promise.resolve(val);
            val.dispose();
          } else {
            const jsonResult = context.evalCode(`(${JSON.stringify(result)})`);
            if (jsonResult.error) {
              const errDump = context.dump(jsonResult.error);
              jsonResult.error.dispose();
              throw new Error(
                `task: failed to marshal structured response: ${JSON.stringify(errDump)}`,
              );
            }
            promise.resolve(jsonResult.value);
            jsonResult.value.dispose();
          }
        } catch (e: unknown) {
          const msg =
            e != null && typeof (e as Error).message === "string"
              ? (e as Error).message
              : String(e);
          const err = context.newError(msg);
          promise.reject(err);
          err.dispose();
        }
        promise.settled.then(context.runtime.executePendingJobs);
      })();

      return promise.handle;
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
