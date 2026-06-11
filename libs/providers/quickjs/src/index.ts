/**
 * @langchain/quickjs
 *
 * Sandboxed JavaScript REPL for deepagents using QuickJS (WASM).
 *
 * Provides a middleware that adds an `eval` tool to any deepagent,
 * enabling code execution in a fully isolated QuickJS WASM sandbox.
 *
 * Features:
 * - Complete network and filesystem isolation (WASM boundary)
 * - Persistent REPL state across evaluations
 * - VFS integration via readFile/writeFile
 * - Programmatic tool calling (PTC) — agent tools available inside the REPL
 * - Serializable sessions (safe across graph interrupts)
 *
 * @packageDocumentation
 */

export { createCodeInterpreterMiddleware } from "./middleware.js";

export { PTCCallBudgetExceededError } from "./errors.js";

export type {
  CodeInterpreterMiddlewareOptions,
  ReplSessionOptions,
  ReplResult,
  SubagentBridgeOptions,
} from "./types.js";

export {
  ReplSession,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_MAX_STACK_SIZE,
  DEFAULT_EXECUTION_TIMEOUT,
  DEFAULT_MAX_PTC_CALLS,
} from "./session.js";

export { formatReplResult, toCamelCase } from "./utils.js";

export { transformForEval, stripTypeSyntax } from "./transform.js";

export { validateResponseSchema } from "./subagent-dispatch.js";
