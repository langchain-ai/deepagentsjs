import type { BackendProtocol, BackendFactory } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * An environment variable with access control.
 *
 * When `secret: true`, the real value is never exposed inside the REPL —
 * `env[key]` returns an opaque placeholder. The real value is
 * substituted back only when the agent calls a tool in `allowedTools`.
 *
 * When `secret` is omitted or false, the value is exposed as-is inside the
 * REPL, but `allowedTools` still restricts which PTC tools may receive it.
 *
 * **Note:** Non-secret `allowedTools` restrictions rely on exact string matching
 * against tool input values. Use this sparingly and only with distinctive values
 * (e.g. API URLs, hostnames) — not short or common strings.
 */
export interface EnvVarConfig {
  /**
   * The actual value of the environment variable.
   */
  value: string;
  
  /**
   * When true, the value is hidden inside the REPL (replaced with an opaque placeholder).
   * The real value is only substituted when calling tools in `allowedTools`.
   * @default false
   */
  secret?: boolean;
  
  /**
   * List of tool names that are allowed to receive this environment variable value.
   * If specified, only these tools will have access to the value during PTC calls.
   */
  allowedTools?: string[];
}

/**
 * Environment variable configuration. Each key maps to either:
 * - A plain string (exposed as-is, no tool restrictions)
 * - An `EnvVarConfig` object (with optional secrecy and tool allowlisting)
 */
export type EnvConfig = Record<string, string | EnvVarConfig>;

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

  /**
   * Environment variables available as `env` inside the REPL.
   *
   * Plain string values are exposed as-is. Secret values (`{ secret: true }`)
   * are replaced with opaque placeholders inside the REPL. The real value is
   * only substituted when the agent calls a tool in the secret's `allowedTools`.
   *
   * @example
   * ```ts
   * env: {
   *   NODE_ENV: "production",
   *   DB_HOST: { value: "10.0.0.1", allowedTools: ["db_query"] },
   *   API_KEY: { value: "sk-real-key", secret: true, allowedTools: ["http_request"] },
   * }
   * ```
   */
  env?: EnvConfig;
}

/**
 * Options for creating a ReplSession.
 */
export interface ReplSessionOptions {
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  backend?: BackendProtocol;
  tools?: StructuredToolInterface[];
  env?: EnvConfig;
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

/**
 * Type guard to check if a value is an EnvVarConfig object.
 */
export function isEnvVarConfig(v: string | EnvVarConfig): v is EnvVarConfig {
  return typeof v === "object";
}
