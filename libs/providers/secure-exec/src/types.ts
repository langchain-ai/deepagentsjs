import type { AnyBackendProtocol, BackendFactory } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * Configuration options for the SecureExec REPL middleware.
 */
export interface SecureExecMiddlewareOptions {
  /**
   * Backend for file I/O (readFile/writeFile) inside the REPL.
   * Accepts an AnyBackendProtocol instance or a BackendFactory function.
   * @default StateBackend
   */
  backend?: AnyBackendProtocol | BackendFactory;

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
   * Memory limit in megabytes.
   * @default 64
   */
  memoryLimitMb?: number;

  /**
   * CPU time limit in milliseconds per evaluation.
   * @default 30000
   */
  cpuTimeLimitMs?: number;

  /**
   * Allow the sandbox to access the Node.js filesystem.
   * @default false
   */
  allowNodeFs?: boolean;

  /**
   * Allow outbound network access from the sandbox.
   * @default false
   */
  allowNetwork?: boolean;

  /**
   * Custom system prompt override. Set to null to disable the system prompt.
   * @default null (uses built-in prompt)
   */
  systemPrompt?: string | null;
}

/**
 * Options for creating a SecureExecSession.
 */
export interface SecureExecSessionOptions {
  memoryLimitMb?: number;
  cpuTimeLimitMs?: number;
  backend?: AnyBackendProtocol;
  tools?: StructuredToolInterface[];
  allowNodeFs?: boolean;
  allowNetwork?: boolean;
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
