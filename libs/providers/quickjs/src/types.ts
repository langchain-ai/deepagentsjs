import type { StructuredToolInterface } from "@langchain/core/tools";

import type {
  AnyBackendProtocol,
  BackendFactory,
  SkillMetadata,
} from "deepagents";

/**
 * Configuration options for the QuickJS REPL middleware.
 */
export interface QuickJSMiddlewareOptions {
  /**
   * Enable programmatic tool calling from within the REPL.
   *
   * Array of tools to expose; strings are resolved from agent tools, instances
   * are injected directly without needing to be registered on the agent.
   *
   * Omit to disable PTC entirely (default).
   */
  ptc?: (string | StructuredToolInterface)[];

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
   * Backend the REPL reads skill module sources from. When provided alongside
   * `SkillsMiddleware`, skills with a `module:` key become dynamic-importable.
   */
  skillsBackend?: AnyBackendProtocol | BackendFactory;

  /**
   * Maximum number of `tools.*` bridge calls allowed per `eval()` invocation.
   *
   * Each call to any function in the `tools` namespace decrements the counter.
   * Once exhausted the next call rejects with a `PTCCallBudgetExceeded` error.
   * The budget resets to this value at the start of every new `eval()` call.
   *
   * Set to `null` to disable the limit entirely (unsafe — increases DoS risk).
   * Must be >= 1 when provided as a number.
   *
   * @default 256
   */
  maxPtcCalls?: number | null;

  /**
   * Maximum characters to retain from console output per evaluation.
   * Output exceeding this limit is dropped at capture time and a
   * `[truncated N chars]` marker is appended to the tool response.
   * The same limit also caps result and error strings in the formatted output.
   *
   * @default 4000
   */
  maxResultChars?: number;
}

/**
 * Options for creating a ReplSession.
 */
export interface ReplSessionOptions {
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  tools?: StructuredToolInterface[];
  skillsEnabled?: boolean;
  maxPtcCalls?: number | null;
  maxResultChars?: number;
}

/**
 * Result of a single REPL evaluation.
 */
export interface ReplResult {
  ok: boolean;
  value?: unknown;
  error?: { name?: string; message?: string; stack?: string };
  logs: string[];
  logsDroppedChars: number;
}

/**
 * Metadata + backend pair the session needs to resolve skill imports.
 */
export interface SkillsContext {
  /**
   * Per-eval snapshot of `state.skillsMetadata`.
   */
  metadata: SkillMetadata[];

  /**
   * Backend the session fetches skill source files from.
   */
  backend: AnyBackendProtocol;
}
