/**
 * JSON-RPC protocol types and stdio helpers for the Harbor bridge.
 *
 * Communication uses newline-delimited JSON (NDJSON) over stdio.
 * Python writes to node's stdin, node writes to Python via stdout.
 * Node uses stderr for logging so it doesn't interfere with the protocol.
 *
 * @packageDocumentation
 */

import { createInterface, type Interface as ReadlineInterface } from "readline";

// ============================================================================
// Message types: Python -> Node (sent over stdin)
// ============================================================================

/**
 * Initialization message sent by Python to start the agent run.
 */
export interface InitMessage {
  type: "init";
  /** The task instruction for the agent */
  instruction: string;
  /** Harbor session ID for this task */
  sessionId: string;
  /** Model name (e.g., "anthropic:claude-sonnet-4-5-20250929") */
  model: string;
  /** Pre-formatted system prompt with directory context */
  systemPrompt: string;
  /**
   * LangSmith distributed tracing headers (optional).
   * When present, the runner uses these to nest all agent traces
   * (LLM calls, tool invocations) under the parent Python trace.
   * @see https://docs.langchain.com/langsmith/distributed-tracing
   */
  langsmithHeaders?: Record<string, string>;
}

/**
 * Response to an execute request, sent by Python after running the command
 * via Harbor's environment.exec().
 */
export interface ExecResponse {
  type: "exec_response";
  /** Request ID to match with the pending request */
  id: string;
  /** Combined stdout/stderr output */
  output: string;
  /** Process exit code */
  exitCode: number;
}

/** Messages that Python sends to Node over stdin. */
export type IncomingMessage = InitMessage | ExecResponse;

// ============================================================================
// Message types: Node -> Python (sent over stdout)
// ============================================================================

/**
 * Request to execute a shell command in the Harbor sandbox.
 * Python will call environment.exec() and send back an ExecResponse.
 */
export interface ExecRequest {
  type: "exec_request";
  /** Unique request ID for matching responses */
  id: string;
  /** Shell command to execute */
  command: string;
}

/**
 * Serialized message from the LangChain message history,
 * used to transfer the agent result back to Python for trajectory saving.
 */
export interface SerializedMessage {
  /** Message type: "human", "ai", "tool", "system" */
  role: string;
  /** Text content or stringified content blocks */
  content: string;
  /** For AI messages: token usage */
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  /** For AI messages: tool calls in content_blocks */
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  /** For tool messages: the tool_call_id */
  toolCallId?: string;
}

/**
 * Final message sent when the agent run completes.
 * Contains the full message history for trajectory saving.
 */
export interface DoneMessage {
  type: "done";
  /** Serialized LangChain messages for ATIF trajectory */
  messages: SerializedMessage[];
}

/**
 * Error message sent if the agent run fails.
 */
export interface ErrorMessage {
  type: "error";
  /** Error description */
  message: string;
  /** Optional stack trace */
  stack?: string;
}

/** Messages that Node sends to Python over stdout. */
export type OutgoingMessage = ExecRequest | DoneMessage | ErrorMessage;

// ============================================================================
// Stdio helpers
// ============================================================================

/**
 * Write a JSON message to stdout (Node -> Python).
 * Each message is a single line of JSON followed by a newline.
 */
export function sendMessage(msg: OutgoingMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/**
 * Log a message to stderr (does not interfere with the protocol).
 */
export function log(...args: unknown[]): void {
  process.stderr.write(
    `[harbor-js] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
  );
}

/**
 * Create a readline-based line reader for stdin.
 * Returns an async iterator that yields parsed JSON messages.
 */
export function createStdinReader(): ReadlineInterface {
  return createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
}

/**
 * Parse a single line from stdin into a typed message.
 * Returns null if the line is empty or unparseable.
 */
export function parseIncomingMessage(line: string): IncomingMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as IncomingMessage;
    if (!parsed.type) return null;
    return parsed;
  } catch {
    log("Failed to parse incoming message:", trimmed);
    return null;
  }
}

// ============================================================================
// Request ID generation
// ============================================================================

let _requestCounter = 0;

/**
 * Generate a unique request ID for exec requests.
 */
export function nextRequestId(): string {
  _requestCounter += 1;
  return `req-${_requestCounter}`;
}

/**
 * Reset the request counter (for testing).
 */
export function resetRequestCounter(): void {
  _requestCounter = 0;
}
