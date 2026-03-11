/**
 * Worker-based JavaScript REPL for PTC.
 *
 * Evaluates JS code in an isolated Worker (Web Worker or Node.js Worker
 * Thread) with `toolCall()` and `spawnAgent()` available as globals.
 * Tool invocations are routed to the host via postMessage IPC.
 *
 * This enables PTC without any sandbox infrastructure — the agent writes
 * JS code via a `js_eval` tool and tools/subagents are called in-process.
 */

import type { ToolRuntime } from "langchain";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PtcToolCallTrace, PtcExecuteResult } from "./types.js";
import { wrapUserCode } from "./worker-runtime.js";

interface NodeProcess {
  getBuiltinModule?: (id: string) => Record<string, unknown> | undefined;
}

interface WorkerThreadsModule {
  Worker: new (code: string, opts: { eval: true }) => NodeWorkerThread;
}

interface NodeWorkerThread {
  on(event: "message", cb: (msg: unknown) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number) => void): void;
  postMessage(msg: unknown): void;
  terminate(): Promise<number>;
}

type WorkerImpl = "web" | "node";

function detectWorkerImpl(): WorkerImpl | null {
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as Record<string, unknown>).Worker === "function"
  ) {
    return "web";
  }

  try {
    const mod = (
      globalThis as unknown as { process?: NodeProcess }
    ).process?.getBuiltinModule?.("node:worker_threads");
    if (mod && "Worker" in mod) return "node";
  } catch {
    // not available
  }

  return null;
}

function getNodeWorkerThreads(): WorkerThreadsModule {
  const mod = (
    globalThis as unknown as { process?: NodeProcess }
  ).process?.getBuiltinModule?.("node:worker_threads") as
    | WorkerThreadsModule
    | undefined;
  if (!mod) throw new Error("node:worker_threads is not available");
  return mod;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Evaluate JavaScript code in an isolated Worker with PTC globals.
 */
export class WorkerRepl {
  private impl: WorkerImpl;
  tools: StructuredToolInterface[];

  constructor(
    tools: StructuredToolInterface[],
    private options: { timeoutMs?: number } = {},
  ) {
    this.tools = tools;
    const detected = detectWorkerImpl();
    if (!detected) {
      throw new Error(
        "No Worker implementation available. " +
          "Requires Web Workers (browser) or Node.js >= 20.16.0 with worker_threads.",
      );
    }
    this.impl = detected;
  }

  async eval(code: string, config?: ToolRuntime): Promise<PtcExecuteResult> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const wrappedCode = wrapUserCode(code, this.impl);
    const toolCallTraces: PtcToolCallTrace[] = [];
    const logs: string[] = [];

    return new Promise<PtcExecuteResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let terminateFn: () => void = () => {};

      const finish = (ok: boolean, value?: string, error?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);

        const output = logs.length > 0 ? logs.join("\n") + "\n" : "";
        const resultLine =
          ok && value !== undefined
            ? `→ ${value}\n`
            : !ok && error
              ? `Error: ${error}\n`
              : "";

        resolve({
          output: output + resultLine,
          exitCode: ok ? 0 : 1,
          truncated: false,
          toolCalls: toolCallTraces,
        });
      };

      const handleMessage = async (msg: Record<string, unknown>) => {
        if (msg.type === "tool_call") {
          const t0 = performance.now();
          const uuid = msg.uuid as string;
          const name = msg.name as string;
          const input = (msg.input as Record<string, unknown>) || {};

          const tool = this.tools.find((t) => t.name === name);
          if (!tool) {
            toolCallTraces.push({
              name,
              input,
              error: `Unknown tool: ${name}`,
              durationMs: performance.now() - t0,
            });
            postToWorker({
              type: "tool_result",
              uuid,
              ok: false,
              error: `Unknown tool: ${name}`,
            });
            return;
          }

          try {
            const result = await tool.invoke(input, config);
            const resultStr =
              typeof result === "string" ? result : JSON.stringify(result);
            toolCallTraces.push({
              name,
              input,
              result: resultStr,
              durationMs: performance.now() - t0,
            });
            postToWorker({
              type: "tool_result",
              uuid,
              ok: true,
              result: resultStr,
            });
          } catch (e: unknown) {
            const errMsg =
              // eslint-disable-next-line no-instanceof/no-instanceof
              e instanceof Error ? e.message : String(e);
            toolCallTraces.push({
              name,
              input,
              error: errMsg,
              durationMs: performance.now() - t0,
            });
            postToWorker({
              type: "tool_result",
              uuid,
              ok: false,
              error: errMsg,
            });
          }
        } else if (msg.type === "log") {
          logs.push(msg.text as string);
        } else if (msg.type === "result") {
          finish(
            msg.ok as boolean,
            msg.value as string | undefined,
            msg.error as string | undefined,
          );
        }
      };

      let postToWorker: (msg: unknown) => void;

      if (this.impl === "node") {
        const { Worker } = getNodeWorkerThreads();
        const worker = new Worker(wrappedCode, { eval: true });

        postToWorker = (msg) => worker.postMessage(msg);
        terminateFn = () => {
          worker.terminate().catch(() => {});
        };

        worker.on("message", (msg: unknown) => {
          handleMessage(msg as Record<string, unknown>);
        });
        worker.on("error", (err: Error) => {
          finish(false, undefined, err.message);
        });
        worker.on("exit", () => {
          finish(true);
        });
      } else {
        const blob = new Blob([wrappedCode], {
          type: "application/javascript",
        });
        const url = URL.createObjectURL(blob);
        const worker = new (
          globalThis as unknown as { Worker: typeof Worker }
        ).Worker(url);

        postToWorker = (msg) => worker.postMessage(msg);
        terminateFn = () => {
          worker.terminate();
          URL.revokeObjectURL(url);
        };

        worker.onmessage = (e: MessageEvent) => {
          handleMessage(e.data as Record<string, unknown>);
        };
        worker.onerror = (e: ErrorEvent) => {
          finish(false, undefined, e.message || "Worker error");
        };
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          terminateFn();
          finish(false, undefined, "Execution timed out");
        }, timeoutMs);
      }
    });
  }

  dispose(): void {
    // No persistent state to clean up — each eval() creates a fresh Worker
  }
}
