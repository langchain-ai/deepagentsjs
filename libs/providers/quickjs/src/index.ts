/**
 * @langchain/quickjs
 *
 * Sandboxed JavaScript REPL for deepagents using QuickJS (WASM).
 *
 * Provides a middleware that adds a `js_eval` tool to any deepagent,
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

export { createQuickJSMiddleware } from "./middleware.js";

export type {
  QuickJSMiddlewareOptions,
  ReplSessionOptions,
  ReplResult,
} from "./types.js";

export {
  ReplSession,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_MAX_STACK_SIZE,
  DEFAULT_EXECUTION_TIMEOUT,
} from "./session.js";

export {
  formatReplResult,
  toCamelCase,
  formatSkillNotAvailable,
} from "./utils.js";

export { transformForEval, stripTypeSyntax } from "./transform.js";

export {
  loadSkill,
  scanSkillReferences,
  SKILL_MODULE_EXTENSIONS,
  MAX_SKILL_BUNDLE_BYTES,
  type LoadedSkill,
} from "./skills.js";
