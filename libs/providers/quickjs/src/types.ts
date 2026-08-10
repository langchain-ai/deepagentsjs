import type { StructuredToolInterface } from "@langchain/core/tools";

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
   * Expose the built-in `task()` global for subagent orchestration.
   *
   * When `true` (default) and subagent specs are available, a `task()`
   * global is installed in the REPL that dispatches subagents
   * programmatically with a fixed concurrency cap of 32.
   * Set to `false` to require subagent dispatch through the normal
   * `task` tool path.
   *
   * @default true
   */
  subagents?: boolean;
}

/**
 * Configuration for the built-in subagent primitive.
 *
 * When provided to a ReplSession, a frozen `subagent()` global is
 * installed in the QuickJS context. Calls are gated by a concurrency
 * queue and forwarded to the dispatch callback.
 */
export interface SubagentBridgeOptions {
  /**
   * Callback that invokes a subagent. Receives validated input from
   * the QuickJS guest and returns the subagent's output — a string
   * for text responses or an object for structured (responseSchema)
   * responses.
   */
  dispatch: (input: {
    description: string;
    subagentType: string;
    responseSchema?: Record<string, unknown>;
  }) => Promise<unknown>;

  /**
   * Maximum number of concurrent subagent calls within a single eval.
   * Excess calls queue and resolve as permits free up.
   */
  maxConcurrency: number;
}

/**
 * Options for creating a ReplSession.
 */
export interface ReplSessionOptions {
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  tools?: StructuredToolInterface[];
  maxPtcCalls?: number | null;
  maxResultChars?: number;
  captureConsole?: boolean;
  sessionId?: string;
  subagentBridge?: SubagentBridgeOptions;
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
