/**
 * Types for the Sandbox PTC (Programmatic Tool Calling) system.
 *
 * Defines the IPC protocol between instrumented scripts running inside
 * sandboxes and the host-side PTC engine.
 */

import type { BackendProtocol, BackendFactory } from "../backends/protocol.js";

/**
 * IPC request parsed from stdout markers.
 * The sandbox script writes these between __DA_REQ_START__ / __DA_REQ_END__ markers.
 */
export interface IpcRequest {
  type: "tool_call";
  name: string;
  input: Record<string, unknown>;
}

/**
 * Options for the sandbox PTC middleware.
 */
export interface SandboxPtcMiddlewareOptions {
  /**
   * Backend instance or factory that implements SandboxBackendProtocol.
   * Must support `spawnInteractive()` for PTC to be active.
   *
   * If not provided, an in-process Worker-based JavaScript REPL is used
   * instead (Web Worker in browsers, Node.js Worker Threads in Node).
   * In this mode, a `js_eval` tool is added so the agent can run JS code
   * with `toolCall()` and `spawnAgent()` available as globals.
   */
  backend?: BackendProtocol | BackendFactory;

  /**
   * Which tools to expose inside the sandbox via PTC.
   *
   * - `true`  — expose all tools except filesystem tools (default)
   * - `false` — disable PTC
   * - `string[]` — expose only the named tools
   * - `{ include: string[] }` — expose only the named tools
   * - `{ exclude: string[] }` — expose all except the named tools
   */
  ptc?: boolean | string[] | { include: string[] } | { exclude: string[] };

  /** Execution timeout in milliseconds (default: 300_000 — 5 minutes) */
  timeoutMs?: number;
}

/**
 * A single tool invocation recorded during PTC execution.
 */
export interface PtcToolCallTrace {
  /** Tool name that was invoked */
  name: string;
  /** Input arguments passed to the tool */
  input: Record<string, unknown>;
  /** Result string on success, undefined on error */
  result?: string;
  /** Error message on failure */
  error?: string;
  /** Wall-clock duration of the tool invocation in milliseconds */
  durationMs: number;
}

/**
 * Extended execute response that includes PTC tool call traces.
 */
export interface PtcExecuteResult {
  output: string;
  exitCode: number | null;
  truncated: boolean;
  /** Every tool_call invocation that occurred during execution */
  toolCalls: PtcToolCallTrace[];
}

/**
 * Tools excluded from PTC by default (redundant inside the sandbox
 * since the sandbox already has filesystem access via shell commands).
 */
export const DEFAULT_PTC_EXCLUDED_TOOLS = [
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "execute",
] as const;
