/**
 * Sandbox PTC (Programmatic Tool Calling) — enables tool calling and
 * subagent spawning from within any sandbox environment.
 */

export { createSandboxPtcMiddleware } from "./middleware.js";

export type {
  SandboxPtcMiddlewareOptions,
  PtcToolCallTrace,
  PtcExecuteResult,
} from "./types.js";
export { DEFAULT_PTC_EXCLUDED_TOOLS } from "./types.js";

export {
  PtcExecutionEngine,
  StdoutScanner,
  type PtcEngineOptions,
} from "./engine.js";

export { generateSandboxPtcPrompt } from "./prompt.js";

export {
  BASH_RUNTIME,
  PYTHON_RUNTIME,
  NODE_RUNTIME,
  IPC_DIR,
  IPC_RES_DIR,
  REQ_LINE_MARKER,
} from "./runtimes.js";
