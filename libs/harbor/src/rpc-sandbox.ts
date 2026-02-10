/**
 * RpcSandbox: A BaseSandbox implementation that bridges execute() calls
 * to a Python process via JSON-RPC over stdin/stdout.
 *
 * The Python process (Harbor wrapper) calls environment.exec() in the
 * actual sandbox container and sends the results back.
 *
 * All higher-level file operations (read, write, edit, ls, grep, glob)
 * are inherited from BaseSandbox and work automatically via execute().
 *
 * @packageDocumentation
 */

import type { Interface as ReadlineInterface } from "readline";

import type {
  ExecuteResponse,
  FileDownloadResponse,
  FileOperationError,
  FileUploadResponse,
} from "deepagents";
import { BaseSandbox } from "deepagents";

import {
  type ExecResponse,
  type IncomingMessage,
  log,
  nextRequestId,
  parseIncomingMessage,
  sendMessage,
} from "./rpc-protocol.js";

/**
 * A pending execute request waiting for a response from Python.
 */
interface PendingRequest {
  resolve: (response: ExecuteResponse) => void;
  reject: (error: Error) => void;
}

/**
 * RpcSandbox extends BaseSandbox to execute commands via a JSON-RPC bridge.
 *
 * When the agent calls execute("ls -la"), this class:
 * 1. Writes an exec_request JSON to stdout
 * 2. Waits for the matching exec_response JSON from stdin
 * 3. Returns the result as an ExecuteResponse
 *
 * The Python wrapper reads the request, calls environment.exec() in Harbor,
 * and writes the response back.
 *
 * uploadFiles and downloadFiles are implemented via execute() using
 * base64-encoded shell commands, since the sandbox is only accessible
 * through Harbor's environment.exec().
 */
export class RpcSandbox extends BaseSandbox {
  readonly id: string;

  /** Map of request IDs to pending promise resolvers */
  #pendingRequests = new Map<string, PendingRequest>();

  /** Whether the stdin reader has been started */
  #readerStarted = false;

  /** The readline interface for reading stdin */
  #reader: ReadlineInterface;

  /** Callback for non-exec_response messages (e.g., used by runner for init) */
  #onMessage?: (msg: IncomingMessage) => void;

  /** Bound line handler so we can remove it in dispose() */
  #lineHandler?: (line: string) => void;

  constructor(sessionId: string, reader: ReadlineInterface) {
    super();
    this.id = sessionId;
    this.#reader = reader;
  }

  /**
   * Set a callback for incoming messages that are NOT exec_response.
   * Used by the runner to receive init messages.
   */
  setMessageHandler(handler: (msg: IncomingMessage) => void): void {
    this.#onMessage = handler;
  }

  /**
   * Start listening for incoming messages on stdin.
   * Must be called before any execute() calls.
   */
  startListening(): void {
    if (this.#readerStarted) return;
    this.#readerStarted = true;

    this.#lineHandler = (line: string) => {
      const msg = parseIncomingMessage(line);
      if (!msg) return;

      if (msg.type === "exec_response") {
        this.#handleExecResponse(msg);
      } else if (this.#onMessage) {
        this.#onMessage(msg);
      }
    };

    this.#reader.on("line", this.#lineHandler);
  }

  /**
   * Handle an exec_response message by resolving the matching pending request.
   */
  #handleExecResponse(msg: ExecResponse): void {
    const pending = this.#pendingRequests.get(msg.id);
    if (!pending) {
      log(`Warning: received exec_response for unknown request ID: ${msg.id}`);
      return;
    }

    this.#pendingRequests.delete(msg.id);
    pending.resolve({
      output: msg.output,
      exitCode: msg.exitCode,
      truncated: false,
    });
  }

  /**
   * Execute a command in the Harbor sandbox via the Python bridge.
   *
   * Sends an exec_request to stdout and waits for the matching
   * exec_response from stdin.
   */
  async execute(command: string): Promise<ExecuteResponse> {
    const id = nextRequestId();

    // Create a promise that will be resolved when the response arrives
    const promise = new Promise<ExecuteResponse>((resolve, reject) => {
      this.#pendingRequests.set(id, { resolve, reject });
    });

    // Send the request to Python via stdout
    sendMessage({
      type: "exec_request",
      id,
      command,
    });

    return promise;
  }

  /**
   * Upload files to the sandbox via execute().
   *
   * Uses base64 encoding to safely transfer file content through
   * shell commands, similar to the Python HarborSandbox approach.
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const results: FileUploadResponse[] = [];

    for (const [filePath, content] of files) {
      try {
        // Base64-encode the content
        const b64 = Buffer.from(content).toString("base64");

        // Use heredoc to pass content via stdin to avoid ARG_MAX limits
        const cmd = `
parent_dir=$(dirname '${filePath.replace(/'/g, "'\\''")}')
mkdir -p "$parent_dir" 2>/dev/null
base64 -d > '${filePath.replace(/'/g, "'\\''")}' <<'__DEEPAGENTS_EOF__'
${b64}
__DEEPAGENTS_EOF__`;

        const result = await this.execute(cmd);

        if (result.exitCode !== 0) {
          results.push({
            path: filePath,
            error: this.#mapError(result.output),
          });
        } else {
          results.push({ path: filePath, error: null });
        }
      } catch {
        results.push({ path: filePath, error: "invalid_path" });
      }
    }

    return results;
  }

  /**
   * Download files from the sandbox via execute().
   *
   * Reads files by base64-encoding their content in the sandbox
   * and decoding it on the JS side.
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = [];

    for (const filePath of paths) {
      try {
        const safePath = filePath.replace(/'/g, "'\\''");
        const cmd = `if [ -f '${safePath}' ]; then base64 '${safePath}'; else echo '__NOT_FOUND__'; exit 1; fi`;

        const result = await this.execute(cmd);

        if (result.exitCode !== 0 || result.output.trim() === "__NOT_FOUND__") {
          results.push({
            path: filePath,
            content: null,
            error: "file_not_found",
          });
        } else {
          // Decode the base64 output
          const content = Buffer.from(result.output.trim(), "base64");
          results.push({
            path: filePath,
            content: new Uint8Array(content),
            error: null,
          });
        }
      } catch {
        results.push({ path: filePath, content: null, error: "invalid_path" });
      }
    }

    return results;
  }

  /**
   * Stop listening, remove the line handler, and reject all pending requests.
   */
  dispose(): void {
    // Remove the readline listener so it doesn't fire after disposal
    if (this.#lineHandler) {
      this.#reader.removeListener("line", this.#lineHandler);
      this.#lineHandler = undefined;
      this.#readerStarted = false;
    }

    for (const [id, pending] of this.#pendingRequests) {
      pending.reject(new Error(`RpcSandbox disposed, request ${id} cancelled`));
    }
    this.#pendingRequests.clear();
  }

  /**
   * Map error output to a standardized FileOperationError.
   */
  #mapError(output: string): FileOperationError {
    const lower = output.toLowerCase();
    if (lower.includes("not found") || lower.includes("no such file")) {
      return "file_not_found";
    }
    if (lower.includes("permission denied")) {
      return "permission_denied";
    }
    if (lower.includes("is a directory")) {
      return "is_directory";
    }
    return "invalid_path";
  }
}
