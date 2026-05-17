import type { AnyBackendProtocol, BackendFactory } from "deepagents";
import type { WasmshSandbox } from "./sandbox.js";

/**
 * Configuration options for the Wasmsh Python REPL middleware.
 *
 * Mirrors the shape of the QuickJS middleware so application code can swap
 * interpreters with minimal churn; the underlying sandbox is Pyodide
 * inside WebAssembly with a full POSIX VFS and a real network capability.
 */
export interface WasmshMiddlewareOptions {
  /**
   * Factory returning a fresh `WasmshSandbox` for this middleware. The
   * sandbox is owned by the middleware and `stop()`-ed when the wrapping
   * agent shuts down. Defaults to `WasmshSandbox.createNode()`.
   */
  sandboxFactory?: () => Promise<WasmshSandbox>;

  /**
   * Backend for skill loading (and, eventually, filesystem persistence
   * inside the REPL). Accepts a `AnyBackendProtocol` instance or a
   * `BackendFactory` function. When unset, skill loading is disabled.
   */
  skillsBackend?: AnyBackendProtocol | BackendFactory;

  /**
   * Enable programmatic tool calling from within the REPL.
   *
   * - `false` — disabled (default).
   * - `true` — expose every agent tool except the default vfs helpers.
   * - `string[]` — expose only these tools (alias for `{ include }`).
   * - `{ include: string[] }` — expose only these tools.
   * - `{ exclude: string[] }` — expose every agent tool except these.
   *
   * @default false
   */
  ptc?: boolean | string[] | { include: string[] } | { exclude: string[] };

  /**
   * Per-call advisory timeout in milliseconds. Accepted today for API
   * parity with the Python adapter; not yet wired into the prompt or
   * the sandbox's budget. Budget enforcement happens via the sandbox's
   * `stepBudget` constructor option for now.
   *
   * @default 30000
   */
  timeoutMs?: number;

  /**
   * Truncate each result block (stdout, stderr, value, error) to this
   * many characters before sending to the model.
   *
   * @default 4000
   */
  maxResultChars?: number;

  /**
   * Custom system prompt override. Set to `null` to disable the
   * middleware's system prompt entirely (the model will only see your
   * outer prompt).
   *
   * @default null (uses the built-in Python prompt)
   */
  systemPrompt?: string | null;

  /**
   * Override the tool name. Default `py_eval` mirrors the Python
   * langchain-wasmsh adapter.
   */
  toolName?: string;

  /**
   * Optional structured logger for diagnostics that are otherwise
   * swallowed: PTC tool errors converted into envelopes, best-effort
   * skill-load failures, etc. The host application gets a stack-trace
   * and call context the model never sees.
   *
   * Defaults to a no-op so library consumers don't have to wire one up
   * unless they want host-side observability.
   */
  logger?: WasmshLogger;
}

/**
 * Diagnostic event surface for the middleware. Implementations are
 * called from inside catch blocks that would otherwise drop the error
 * (PTC dispatch / skill load), so the implementation must not throw.
 */
export interface WasmshLogger {
  /**
   * A PTC `host_call` round-tripped to a tool that threw or returned an
   * error envelope. `event.tool` is the snake-cased name the model
   * used; `event.error` is the original Error (or whatever was thrown).
   */
  ptcToolError?(event: {
    tool: string;
    callId: string;
    args: Record<string, unknown>;
    error: unknown;
  }): void;

  /**
   * Best-effort skill load failed. The middleware proceeds without the
   * skill staged, so an `import skills.<name>` in user code will raise
   * `ModuleNotFoundError` inside Python; this hook is the host's only
   * chance to learn why.
   */
  skillLoadError?(event: { skill: string; error: unknown }): void;
}

/**
 * The wire-shape of the launcher envelope returned by the wasmsh PTC
 * helper. `value` carries primitives natively (string, number, list,
 * dict); complex types are repr-stringified.
 */
export interface ReplEnvelope {
  ok: boolean;
  stdout: string;
  stderr: string;
  value?: unknown;
  error?: string;
  message?: string;
  traceback?: string;
}
