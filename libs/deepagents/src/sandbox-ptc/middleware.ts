/**
 * Sandbox PTC Middleware — enables programmatic tool calling from scripts.
 *
 * Three modes based on the backend:
 *
 * 1. **Sandbox mode** — backend with `spawnInteractive()` (Deno, Modal, etc.):
 *    intercepts `execute` tool calls, instruments bash/python/node scripts
 *    with PTC runtime, routes IPC through the PtcExecutionEngine.
 *
 * 2. **Backend + Worker REPL** — backend without `spawnInteractive()`
 *    (FilesystemBackend, StateBackend, etc.): the backend handles file
 *    storage via the standard filesystem tools, and a `js_eval` tool is
 *    added for running JS code with `toolCall()` / `spawnAgent()` in an
 *    isolated Worker.
 *
 * 3. **Standalone Worker REPL** — no backend at all: same as (2) but
 *    without filesystem tools.
 */

import {
  createMiddleware,
  tool,
  type AgentMiddleware as _AgentMiddleware,
  type ToolRuntime,
} from "langchain";
import { z } from "zod/v4";
import { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

import type * as _zodTypes from "@langchain/core/utils/types";
import type * as _zodMeta from "@langchain/langgraph/zod";
import type * as _messages from "@langchain/core/messages";

import {
  isSandboxBackend,
  type BackendProtocol,
  type BackendFactory,
  type StateAndStore,
} from "../backends/protocol.js";

import { PtcExecutionEngine } from "./engine.js";
import {
  generateSandboxPtcPrompt,
  generateWorkerReplPrompt,
} from "./prompt.js";
import { WorkerRepl } from "./worker-repl.js";
import { policyFetch } from "./network-policy.js";
import type {
  SandboxPtcMiddlewareOptions,
  PtcExecuteResult,
  NetworkPolicy,
} from "./types.js";
import { DEFAULT_PTC_EXCLUDED_TOOLS } from "./types.js";

function getBackend(
  backend: BackendProtocol | BackendFactory,
  stateAndStore: StateAndStore,
): BackendProtocol {
  if (typeof backend === "function") {
    return backend(stateAndStore);
  }
  return backend;
}

function filterToolsForPtc(
  allTools: StructuredToolInterface[],
  ptc: SandboxPtcMiddlewareOptions["ptc"],
): StructuredToolInterface[] {
  if (ptc === false) return [];

  const candidates = allTools.filter(
    (t) => t.name !== "execute" && t.name !== "js_eval",
  );

  if (ptc === true || ptc === undefined) {
    const excluded = new Set<string>(DEFAULT_PTC_EXCLUDED_TOOLS);
    return candidates.filter((t) => !excluded.has(t.name));
  }

  if (Array.isArray(ptc)) {
    const included = new Set(ptc);
    return candidates.filter((t) => included.has(t.name));
  }

  if ("include" in ptc) {
    const included = new Set(ptc.include);
    return candidates.filter((t) => included.has(t.name));
  }

  if ("exclude" in ptc) {
    const excluded = new Set([...DEFAULT_PTC_EXCLUDED_TOOLS, ...ptc.exclude]);
    return candidates.filter((t) => !excluded.has(t.name));
  }

  return [];
}

function formatPtcTrace(result: PtcExecuteResult): string {
  if (result.toolCalls.length === 0) return "";

  const succeeded = result.toolCalls.filter((tc) => !tc.error).length;
  const failed = result.toolCalls.length - succeeded;
  const totalMs = result.toolCalls.reduce((s, tc) => s + tc.durationMs, 0);

  const counts = new Map<string, number>();
  for (const tc of result.toolCalls) {
    counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");

  return `\n[PTC: ${result.toolCalls.length} tool calls (${breakdown}), ${succeeded} succeeded, ${failed} failed, ${totalMs.toFixed(0)}ms total]`;
}

/**
 * Determine whether the backend supports sandbox-style execution
 * (i.e. has `spawnInteractive()` for bash/python/node scripts).
 */
function isSandboxWithInteractive(
  backend: BackendProtocol | BackendFactory | undefined,
  stateAndStore: StateAndStore,
): boolean {
  if (!backend) return false;
  const resolved =
    typeof backend === "function" ? backend(stateAndStore) : backend;
  return (
    isSandboxBackend(resolved) &&
    typeof resolved.spawnInteractive === "function"
  );
}

/**
 * Create a synthetic __http_fetch tool for sandbox PTC runtimes.
 * The tool enforces the network policy and delegates to real fetch.
 */
function createHttpFetchTool(network: NetworkPolicy) {
  return tool(
    async (input: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
      const result = await policyFetch(
        input.url,
        {
          method: input.method || "GET",
          headers: input.headers,
          body: input.body,
        },
        network,
      );
      return JSON.stringify({ ok: result.ok, status: result.status, body: result.body });
    },
    {
      name: "__http_fetch",
      description: "Policy-enforced HTTP fetch (internal, used by PTC runtimes)",
      schema: z.object({
        url: z.string(),
        method: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
      }),
    },
  );
}

/**
 * Create a middleware that enables Programmatic Tool Calling (PTC).
 *
 * - **Sandbox backend** (has `spawnInteractive`): intercepts `execute` and
 *   instruments bash/python/node scripts with PTC runtime.
 * - **Non-sandbox backend** (FilesystemBackend, etc.) or **no backend**:
 *   adds a `js_eval` tool backed by a Worker REPL with `toolCall()` and
 *   `spawnAgent()` as async globals. The backend is still used for
 *   filesystem operations if provided.
 */
export function createSandboxPtcMiddleware(
  options: SandboxPtcMiddlewareOptions = {},
) {
  const { backend, ptc = true, timeoutMs = 300_000, network } = options;

  let ptcTools: StructuredToolInterface[] = [];
  let cachedSandboxPrompt: string | null = null;
  let cachedReplPrompt: string | null = null;
  let repl: WorkerRepl | null = null;
  let detectedSandbox: boolean | null = null;

  const httpFetchTool = network ? createHttpFetchTool(network) : null;

  const jsEvalTool = tool(
    async (input: { code: string }, runnableConfig: ToolRuntime) => {
      if (!repl) {
        repl = new WorkerRepl(ptcTools, { timeoutMs, network });
      }
      repl.tools = ptcTools;

      const result = await repl.eval(input.code, runnableConfig);

      const parts = [result.output];
      const trace = formatPtcTrace(result);
      if (trace) parts.push(trace);

      return parts.join("").trim() || "(no output)";
    },
    {
      name: "js_eval",
      description:
        "Evaluate JavaScript code in a sandboxed REPL. " +
        "Use toolCall(name, input) and spawnAgent(description, type) for tool calls and subagents. " +
        "Use console.log() for output. Returns the result of the last expression.",
      schema: z.object({
        code: z
          .string()
          .describe("JavaScript code to evaluate in the sandboxed REPL"),
      }),
    },
  );

  return createMiddleware({
    name: "SandboxPtcMiddleware",
    tools: [jsEvalTool],

    wrapModelCall: async (request, handler) => {
      const agentTools = (request.tools || []) as StructuredToolInterface[];
      ptcTools = filterToolsForPtc(agentTools, ptc);
      if (httpFetchTool && !ptcTools.some((t) => t.name === "__http_fetch")) {
        ptcTools.push(httpFetchTool);
      }

      // Detect sandbox support lazily (once)
      if (detectedSandbox === null) {
        const stateAndStore: StateAndStore = {
          state: request.state || {},
          // @ts-expect-error - request.config may have store
          store: request.config?.store,
        };
        detectedSandbox = isSandboxWithInteractive(backend, stateAndStore);
      }

      if (detectedSandbox) {
        // Sandbox mode: inject bash/python/node PTC prompt, hide js_eval
        if (ptcTools.length > 0 && !cachedSandboxPrompt) {
          cachedSandboxPrompt = generateSandboxPtcPrompt(ptcTools, network);
        }
        const tools = (request.tools as { name: string }[]).filter(
          (t) => t.name !== "js_eval",
        );
        const systemMessage = cachedSandboxPrompt
          ? request.systemMessage.concat(cachedSandboxPrompt)
          : request.systemMessage;
        return handler({ ...request, tools, systemMessage });
      }

      // Worker REPL mode: inject JS REPL prompt, hide PTC tools from the
      // model so it must use toolCall()/spawnAgent() inside js_eval
      if (ptcTools.length > 0 && !cachedReplPrompt) {
        cachedReplPrompt = generateWorkerReplPrompt(ptcTools, network);
      }
      const ptcToolNames = new Set(ptcTools.map((t) => t.name));
      const visibleTools = (request.tools as { name: string }[]).filter(
        (t) => !ptcToolNames.has(t.name),
      );
      const systemMessage = cachedReplPrompt
        ? request.systemMessage.concat(cachedReplPrompt)
        : request.systemMessage;
      return handler({ ...request, tools: visibleTools, systemMessage });
    },

    wrapToolCall: async (request, handler) => {
      // Only intercept `execute` in sandbox mode
      if (
        request.toolCall?.name !== "execute" ||
        ptcTools.length === 0 ||
        !detectedSandbox ||
        !backend
      ) {
        return handler(request);
      }

      const stateAndStore: StateAndStore = {
        state: request.state || {},
        // @ts-expect-error - request.config may have store
        store: request.config?.store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);

      if (
        !isSandboxBackend(resolvedBackend) ||
        !resolvedBackend.spawnInteractive
      ) {
        return handler(request);
      }

      const args =
        typeof request.toolCall.args === "string"
          ? JSON.parse(request.toolCall.args)
          : request.toolCall.args;
      const command = args.command as string;

      if (!command) {
        return handler(request);
      }

      const engine = new PtcExecutionEngine(resolvedBackend, ptcTools, {
        timeoutMs,
      });
      const result = await engine.execute(command);

      const parts = [result.output];
      if (result.exitCode !== null) {
        const status = result.exitCode === 0 ? "succeeded" : "failed";
        parts.push(`\n[Command ${status} with exit code ${result.exitCode}]`);
      }
      if (result.truncated) {
        parts.push("\n[Output was truncated due to size limits]");
      }

      const trace = formatPtcTrace(result);
      if (trace) parts.push(trace);

      return new ToolMessage({
        content: parts.join(""),
        tool_call_id: request.toolCall.id ?? "",
        name: "execute",
      });
    },
  });
}
