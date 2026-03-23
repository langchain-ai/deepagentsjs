import type { BackendProtocol, BackendFactory } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * Configuration options for the QuickJS REPL middleware.
 */
export interface QuickJSMiddlewareOptions {
  /**
   * Backend for file I/O (readFile/writeFile) inside the REPL.
   * Accepts a BackendProtocol instance or a BackendFactory function.
   * Defaults to StateBackend (reads/writes LangGraph checkpoint state).
   * @default StateBackend
   */
  backend?: BackendProtocol | BackendFactory;

  /**
   * Enable programmatic tool calling from within the REPL.
   *
   * - `false` — disabled (default)
   * - `true` — expose all agent tools except standard vfs tools
   * - `string[]` — expose only these tools (alias for `{ include }`)
   * - `{ include: string[] }` — expose only these tools
   * - `{ exclude: string[] }` — expose all agent tools except these
   *
   * @default false
   */
  ptc?: boolean | string[] | { include: string[] } | { exclude: string[] };

  /**
   * Memory limit in bytes.
   * @default 52428800 (50MB)
   */
  memoryLimitBytes?: number;

  /**
   * Max stack size in bytes.
   * @default 327680 (320KB)
   */
  maxStackSizeBytes?: number;

  /**
   * Execution timeout in milliseconds per evaluation.
   * Set to a negative value to disable the timeout entirely.
   * @default 30000 (30s)
   */
  executionTimeoutMs?: number;

  /**
   * Custom system prompt override. Set to null to disable the system prompt.
   * @default null (uses built-in prompt)
   */
  systemPrompt?: string | null;
}

/**
 * Options for creating a ReplSession.
 */
export interface ReplSessionOptions {
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  backend?: BackendProtocol;
  tools?: StructuredToolInterface[];
}

/**
 * Result of a single REPL evaluation.
 */
export interface ReplResult {
  ok: boolean;
  value?: unknown;
  error?: { name?: string; message?: string; stack?: string };
  logs: string[];
}
