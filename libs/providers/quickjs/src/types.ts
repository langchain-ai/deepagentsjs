import type { StructuredToolInterface } from "@langchain/core/tools";
import type { InterpreterLibrary } from "./library.js";

import type {
  AnyBackendProtocol,
  BackendFactory,
  SkillMetadata,
} from "deepagents";

/**
 * Configuration options for the Code Interpreter middleware.
 */
export interface CodeInterpreterMiddlewareOptions {
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
   * @default 67108864 (64MB)
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
   * @default 5000 (5s)
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

  /**
   * Name of the tool exposed to the model.
   * @default "eval"
   */
  toolName?: string;

  /**
   * If true, install a `console` object that buffers `console.log/warn/error`
   * calls and emits them alongside the result. If false, console output is
   * silently discarded.
   * @default true
   */
  captureConsole?: boolean;

  /**
   * Interpreter libraries to pre-load into the QuickJS module resolver.
   *
   * Each library is always available for `import` by name. Libraries
   * bundle their own PTC tool requirements — the middleware aggregates
   * them with any explicit `ptc` tools.
   * @default []
   */
  libraries?: InterpreterLibrary[];

  /**
   * Register workflow tools (`run_workflow`, `list_workflows`,
   * `load_workflow`, `save_workflow`) alongside the eval tool.
   *
   * When enabled, the agent can compose reusable pipelines via
   * `run_workflow` which executes code in the interpreter and
   * auto-saves it as a draft workflow.
   *
   * @default false
   */
  enableWorkflows?: boolean;
}

/**
 * Lightweight library descriptor passed from middleware to session.
 *
 * Carries only the data the session needs to register a library:
 * module source and optional sub-module files. Instructions live
 * in the middleware layer (injected into the system prompt).
 */
export interface LibraryEntry {
  /**
   * Module name used in bare-specifier imports.
   */
  name: string;

  /**
   * JS source for the entrypoint module.
   */
  source: string;

  /**
   * Additional module files keyed by relative POSIX path.
   *
   * Enables multi-file libraries — QuickJS resolves
   * `import { x } from "<name>/table.js"` to `files.get("table.js")`.
   * Single-file libraries can omit this.
   */
  files?: Map<string, string>;
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
  captureConsole?: boolean;
  sessionId?: string;
  libraries?: LibraryEntry[];
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
