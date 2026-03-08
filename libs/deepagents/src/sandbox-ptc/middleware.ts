/**
 * Sandbox PTC Middleware — enables programmatic tool calling from
 * within any sandbox that implements `spawnInteractive()`.
 *
 * Intercepts `execute` tool calls, instruments the command with the
 * PTC runtime library, and runs it through the PtcExecutionEngine
 * which handles IPC between the sandbox script and host tools.
 */

import {
  createMiddleware,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * These type-only imports are required for TypeScript's type inference to work
 * correctly with the langchain/langgraph middleware system.
 */
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
import { generateSandboxPtcPrompt } from "./prompt.js";
import type { SandboxPtcMiddlewareOptions } from "./types.js";
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

  const candidates = allTools.filter((t) => t.name !== "execute");

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
    const excluded = new Set([
      ...DEFAULT_PTC_EXCLUDED_TOOLS,
      ...ptc.exclude,
    ]);
    return candidates.filter((t) => !excluded.has(t.name));
  }

  return [];
}

/**
 * Create a middleware that enables Programmatic Tool Calling (PTC)
 * from within sandbox `execute` commands.
 *
 * When the agent runs a shell command via `execute`, this middleware:
 * 1. Instruments the command with PTC runtime functions
 * 2. Monitors stdout for IPC request markers
 * 3. Dispatches tool calls / subagent spawns on the host
 * 4. Writes responses back into the sandbox filesystem
 *
 * Requires the backend to implement `spawnInteractive()`.
 * Falls back to normal execution if not supported.
 */
export function createSandboxPtcMiddleware(
  options: SandboxPtcMiddlewareOptions,
) {
  const {
    backend,
    ptc = true,
    timeoutMs = 300_000,
  } = options;

  let ptcTools: StructuredToolInterface[] = [];
  let cachedPrompt: string | null = null;

  return createMiddleware({
    name: "SandboxPtcMiddleware",

    wrapModelCall: async (request, handler) => {
      const agentTools = (request.tools || []) as StructuredToolInterface[];
      ptcTools = filterToolsForPtc(agentTools, ptc);

      if (ptcTools.length > 0 && !cachedPrompt) {
        cachedPrompt = generateSandboxPtcPrompt(ptcTools);
      }

      const systemMessage = cachedPrompt
        ? request.systemMessage.concat(cachedPrompt)
        : request.systemMessage;

      return handler({ ...request, systemMessage });
    },

    wrapToolCall: async (request, handler) => {
      if (
        request.toolCall?.name !== "execute" ||
        ptcTools.length === 0
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

      return new ToolMessage({
        content: parts.join(""),
        tool_call_id: request.toolCall.id ?? "",
        name: "execute",
      });
    },
  });
}
