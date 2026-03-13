/**
 * PTC Execution Engine — orchestrates IPC between host tools and sandbox scripts.
 *
 * Monitors an interactive process's stdout for IPC request markers,
 * dispatches tool calls on the host, and writes response files into
 * the sandbox filesystem so the instrumented script can resume.
 */

import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  SandboxBackendProtocol,
  InteractiveProcess,
} from "../backends/protocol.js";
import type {
  IpcRequest,
  PtcToolCallTrace,
  PtcExecuteResult,
} from "./types.js";
import {
  BASH_RUNTIME,
  PYTHON_RUNTIME,
  NODE_RUNTIME,
  IPC_RES_DIR,
  REQ_LINE_MARKER,
  RUNTIME_SETUP_COMMAND,
} from "./runtimes.js";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Parses a stream (stderr) line-by-line, extracting IPC request markers
 * and passing through all other content.
 *
 * Marker format (single line, atomic under PIPE_BUF):
 *   `__DA_REQ__<uuid> <json_payload>`
 */
export class StdoutScanner {
  private buffer = "";

  processChunk(
    chunk: string,
  ): Array<
    | { type: "output"; text: string }
    | { type: "request"; uuid: string; payload: string }
  > {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    const events: Array<
      | { type: "output"; text: string }
      | { type: "request"; uuid: string; payload: string }
    > = [];

    for (const line of lines) {
      if (line.startsWith(REQ_LINE_MARKER)) {
        const rest = line.slice(REQ_LINE_MARKER.length);
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx !== -1) {
          events.push({
            type: "request",
            uuid: rest.slice(0, spaceIdx),
            payload: rest.slice(spaceIdx + 1),
          });
        } else {
          events.push({ type: "output", text: line + "\n" });
        }
      } else {
        events.push({ type: "output", text: line + "\n" });
      }
    }

    return events;
  }

  flush(): string {
    const remaining = this.buffer;
    this.buffer = "";
    return remaining;
  }
}

export interface PtcEngineOptions {
  timeoutMs?: number;
}

export class PtcExecutionEngine {
  private runtimeInstalled = false;

  constructor(
    private sandbox: SandboxBackendProtocol,
    private tools: StructuredToolInterface[],
    private options: PtcEngineOptions = {},
  ) {}

  async execute(command: string): Promise<PtcExecuteResult> {
    if (!this.sandbox.spawnInteractive) {
      throw new Error(
        "Sandbox does not support spawnInteractive() — PTC is unavailable",
      );
    }

    await this.ensureRuntimeInstalled();

    const instrumented = this.instrumentCommand(command);
    const proc = await this.sandbox.spawnInteractive(instrumented);

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const stdoutChunks: string[] = [];
    const stderrClean: string[] = [];
    const pendingRequests: Promise<void>[] = [];
    const toolCallTraces: PtcToolCallTrace[] = [];
    const decoder = new TextDecoder();

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill().catch(() => {});
      }, timeoutMs);
    }

    // IPC markers are written to STDERR by the runtimes (so they aren't
    // captured by bash $(...) command substitution). We scan stderr for
    // markers and collect any non-marker lines as regular error output.
    const scanner = new StdoutScanner();
    const stderrPromise = (async () => {
      try {
        for await (const chunk of proc.stderr) {
          if (timedOut) break;
          const text = decoder.decode(chunk, { stream: true });
          const events = scanner.processChunk(text);

          for (const event of events) {
            if (event.type === "output") {
              stderrClean.push(event.text);
            } else {
              pendingRequests.push(
                this.handleRequest(
                  event.uuid,
                  event.payload,
                  proc,
                  toolCallTraces,
                ),
              );
            }
          }
        }
      } catch {
        // stderr may error on kill — ignore
      }
      const remaining = scanner.flush();
      if (remaining) stderrClean.push(remaining);
    })();

    // Stdout is passed through unchanged (no markers).
    try {
      for await (const chunk of proc.stdout) {
        if (timedOut) break;
        stdoutChunks.push(decoder.decode(chunk, { stream: true }));
      }
    } catch {
      // stdout may error on kill — ignore
    }

    // Await stderr first to ensure all markers have been parsed and
    // their handleRequest promises pushed into pendingRequests.
    await stderrPromise;
    await Promise.all(pendingRequests);

    if (timer) clearTimeout(timer);

    const { exitCode } = await proc.waitForExit();

    const combinedOutput = stdoutChunks.join("") + stderrClean.join("");
    if (timedOut) {
      return {
        output: combinedOutput + "\n[Command timed out]",
        exitCode: null,
        truncated: false,
        toolCalls: toolCallTraces,
      };
    }

    return {
      output: combinedOutput,
      exitCode,
      truncated: false,
      toolCalls: toolCallTraces,
    };
  }

  private async handleRequest(
    uuid: string,
    payload: string,
    proc: InteractiveProcess,
    traces: PtcToolCallTrace[],
  ): Promise<void> {
    const resPath = `${IPC_RES_DIR}/${uuid}`;
    const t0 = performance.now();

    try {
      const request: IpcRequest = JSON.parse(payload);
      const tool = this.tools.find((t) => t.name === request.name);

      if (!tool) {
        traces.push({
          name: request.name,
          input: request.input,
          error: `Unknown tool: ${request.name}`,
          durationMs: performance.now() - t0,
        });
        await proc.writeFile(resPath, `1\nUnknown tool: ${request.name}`);
        return;
      }

      const result = await tool.invoke(request.input);
      const resultStr =
        typeof result === "string" ? result : JSON.stringify(result);
      traces.push({
        name: request.name,
        input: request.input,
        result: resultStr,
        durationMs: performance.now() - t0,
      });
      await proc.writeFile(resPath, `0\n${resultStr}`);
    } catch (e: unknown) {
      const msg =
        // eslint-disable-next-line no-instanceof/no-instanceof
        e instanceof Error ? e.message : String(e);
      traces.push({
        name: (JSON.parse(payload) as IpcRequest).name,
        input: (JSON.parse(payload) as IpcRequest).input,
        error: msg,
        durationMs: performance.now() - t0,
      });
      await proc.writeFile(resPath, `1\n${msg}`);
    }
  }

  /**
   * Instrument a command with the PTC runtime.
   *
   * - Always sources the bash runtime (for tool_call / spawn_agent in bash)
   * - If the command invokes python3/python, prepends an auto-import of
   *   the Python PTC runtime so tool_call() and spawn_agent() are available
   * - If the command invokes node, prepends a --require for the Node runtime
   */
  private instrumentCommand(command: string): string {
    let instrumented = `${RUNTIME_SETUP_COMMAND}source /tmp/.da_runtime.sh\n`;

    // Auto-inject Python runtime: set PYTHONSTARTUP so interactive python
    // gets it, and prepend the import for script execution via -c or file
    if (/\bpython[3]?\b/.test(command)) {
      instrumented += `export PYTHONSTARTUP=/tmp/.da_runtime.py\n`;
      // Rewrite `python3 script.py` → `python3 -c "exec(open('/tmp/.da_runtime.py').read())" && python3 script.py`
      // is fragile. Instead, prepend the import to any -c argument or wrap script execution.
      // Simplest: set PYTHONPATH and have scripts import explicitly, OR
      // use a wrapper that sources the runtime then exec's the real command.
      instrumented += command.replace(
        /\b(python[3]?)\s+(?!-)/,
        `$1 -c "import sys; sys.path.insert(0,'/tmp'); exec(open('/tmp/.da_runtime.py').read()); exec(open(sys.argv[1]).read())" `,
      );
      return instrumented;
    }

    // Auto-inject Node.js runtime via --require
    if (/\bnode\b/.test(command)) {
      instrumented += command.replace(
        /\bnode\b/,
        `node --require /tmp/.da_runtime.js`,
      );
      return instrumented;
    }

    instrumented += command;
    return instrumented;
  }

  /**
   * Install runtime libraries into the sandbox via `execute()` + heredoc.
   *
   * Using `execute()` instead of `uploadFiles()` ensures the files land at
   * the correct absolute path regardless of whether the sandbox is a remote
   * container (Deno/Modal/Daytona) or a local process (Node-VFS/LocalShell).
   */
  private async ensureRuntimeInstalled(): Promise<void> {
    if (this.runtimeInstalled) return;

    const runtimes: Array<[string, string]> = [
      ["/tmp/.da_runtime.sh", BASH_RUNTIME],
      ["/tmp/.da_runtime.py", PYTHON_RUNTIME],
      ["/tmp/.da_runtime.js", NODE_RUNTIME],
    ];

    for (const [filePath, content] of runtimes) {
      await this.sandbox.execute(
        `mkdir -p "$(dirname "${filePath}")" && cat > "${filePath}" << 'DA_RUNTIME_EOF'\n${content}\nDA_RUNTIME_EOF`,
      );
    }

    this.runtimeInstalled = true;
  }
}
