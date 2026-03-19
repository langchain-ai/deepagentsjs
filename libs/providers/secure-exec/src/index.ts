/**
 * @langchain/secure-exec
 *
 * Sandboxed JavaScript/TypeScript REPL for deepagents using secure-exec (Node.js V8 isolate).
 *
 * Provides a middleware that adds a `js_eval` tool to any deepagent,
 * enabling code execution in a fully isolated Node.js V8 worker with
 * real TypeScript type checking via @secure-exec/typescript.
 *
 * Features:
 * - V8 isolate-based execution (full Node.js + npm compatibility)
 * - Real TypeScript compilation and type checking
 * - Persistent REPL state via declaration re-accumulation
 * - VFS integration via readFile/writeFile backed by deepagents backends
 * - Programmatic tool calling (PTC) via HTTP bridge
 * - Serializable sessions (safe across graph interrupts)
 *
 * @packageDocumentation
 */

export { createSecureExecMiddleware, DEFAULT_PTC_EXCLUDED_TOOLS } from "./middleware.js";
export { generatePtcPrompt } from "./middleware.js";

export type {
  SecureExecMiddlewareOptions,
  SecureExecSessionOptions,
  ReplResult,
} from "./types.js";

export {
  SecureExecSession,
  DEFAULT_MEMORY_LIMIT_MB,
  DEFAULT_CPU_TIME_LIMIT_MS,
  DEFAULT_SESSION_ID,
} from "./session.js";
export type { PendingWrite } from "./session.js";

export { BackendVirtualFileSystem } from "./vfs.js";

export { formatReplResult, toCamelCase } from "./utils.js";

export { transformForEval } from "./transform.js";
export type { TransformResult } from "./transform.js";
