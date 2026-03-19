/**
 * SecureExec REPL middleware for deepagents.
 *
 * Provides a `js_eval` tool that runs JavaScript/TypeScript in a Node.js V8
 * isolate (via secure-exec). Supports:
 * - Persistent state across evaluations (source-code accumulation strategy)
 * - VFS integration via readFile/writeFile globals
 * - Real TypeScript type checking via @secure-exec/typescript
 * - Programmatic tool calling (PTC) via HTTP bridge
 */

import {
  createMiddleware,
  tool,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { z } from "zod/v4";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  StateBackend,
  type AnyBackendProtocol,
  type BackendFactory,
  type StateAndStore,
} from "deepagents";

import dedent from "dedent";
import type { SecureExecMiddlewareOptions } from "./types.js";
import {
  SecureExecSession,
  DEFAULT_CPU_TIME_LIMIT_MS,
  DEFAULT_MEMORY_LIMIT_MB,
  DEFAULT_SESSION_ID,
} from "./session.js";
import {
  formatReplResult,
  toCamelCase,
  toolToTypeSignature,
  safeToJsonSchema,
} from "./utils.js";

import {
  getCurrentTaskInput,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";

/**
 * Backend-provided tools excluded from PTC by default.
 * These overlap with the REPL's own readFile/writeFile globals.
 */
export const DEFAULT_PTC_EXCLUDED_TOOLS = [
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "execute",
] as const;

const REPL_SYSTEM_PROMPT = dedent`
  ## TypeScript/JavaScript REPL (\`js_eval\`)

  You have access to a sandboxed TypeScript/JavaScript REPL running in an isolated Node.js V8 worker.
  TypeScript syntax is fully supported with real type checking.
  Variables and functions declared at the top level persist across calls (re-evaluated from source).

  ### Available globals

  - \`readFile(path: string): string\` — Read a file from the agent's virtual filesystem.
  - \`writeFile(path: string, content: string): void\` — Write a file to the agent's virtual filesystem.
  - \`require(module: string)\` — Node.js built-in modules are available (e.g. \`require("path")\`, \`require("crypto")\`).
  - \`console.log/warn/error\` — Output is captured and returned.

  ### Persistence model

  Top-level \`const\`, \`let\`, \`function\`, and \`class\` declarations persist across calls — they are
  re-evaluated as a preamble on each subsequent call. This means:
  - Functions you define in one call are available in the next.
  - Mutable state inside objects resets to its initial value on each call.
  - Avoid side-effectful declarations (e.g. \`const result = await fetch(...)\`) at the top level —
    they will re-execute on every subsequent call.

  ### Limitations

  - \`require()\` and Node.js standard library are available. Network and child processes are disabled by default.
  - Output is truncated beyond a fixed character limit — be selective about what you log.
  - CPU time limit: 30s per call. Memory limit: 64 MB.
`;

/**
 * Generate the PTC API Reference section for the system prompt.
 */
export async function generatePtcPrompt(
  tools: StructuredToolInterface[],
): Promise<string> {
  if (tools.length === 0) return "";

  const signatures = await Promise.all(
    tools.map((t) => {
      const jsonSchema = t.schema ? safeToJsonSchema(t.schema) : undefined;
      return toolToTypeSignature(
        toCamelCase(t.name),
        t.description,
        jsonSchema,
      );
    }),
  );

  return dedent`

    ### API Reference — \`tools\` namespace

    The following agent tools are callable as async functions inside the REPL.
    Each takes a single object argument and returns a Promise that resolves to a string.
    Use \`await\` to call them. Promise APIs like \`Promise.all\` are also available.

    **Example usage:**
    \`\`\`javascript
    // Call a tool
    const result = await tools.searchWeb({ query: "secure-exec tutorial" });
    console.log(result);

    // Concurrent calls
    const [a, b] = await Promise.all([
      tools.fetchData({ url: "https://api.example.com/a" }),
      tools.fetchData({ url: "https://api.example.com/b" }),
    ]);
    \`\`\`

    **Available functions:**
    \`\`\`typescript
    ${signatures.join("\n\n")}
    \`\`\`
  `;
}

/**
 * Resolve backend from factory or instance.
 */
function getBackend(
  backend: AnyBackendProtocol | BackendFactory,
  stateAndStore: StateAndStore,
): AnyBackendProtocol {
  if (typeof backend === "function") {
    return backend(stateAndStore);
  }
  return backend;
}

/**
 * Create the SecureExec REPL middleware.
 *
 * Returns a deepagents `AgentMiddleware` that adds a `js_eval` tool to the agent.
 * The tool schema is identical to `@langchain/quickjs` for drop-in compatibility.
 */
export function createSecureExecMiddleware(
  options: SecureExecMiddlewareOptions = {},
) {
  const {
    backend = (stateAndStore: StateAndStore) => new StateBackend(stateAndStore),
    ptc = false,
    memoryLimitMb = DEFAULT_MEMORY_LIMIT_MB,
    cpuTimeLimitMs = DEFAULT_CPU_TIME_LIMIT_MS,
    allowNodeFs = false,
    allowNetwork = false,
    systemPrompt: customSystemPrompt = null,
  } = options;

  const usePtc = ptc !== false;
  const baseSystemPrompt = customSystemPrompt ?? REPL_SYSTEM_PROMPT;

  let cachedPtcPrompt: string | null = null;
  let ptcTools: StructuredToolInterface[] = [];

  function filterToolsForPtc(
    allTools: StructuredToolInterface[],
  ): StructuredToolInterface[] {
    if (ptc === false) return [];

    const candidates = allTools.filter((t) => t.name !== "js_eval");

    if (ptc === true) {
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

  const jsEvalTool = tool(
    async (input, config: LangGraphRunnableConfig) => {
      const threadId = config.configurable?.thread_id || DEFAULT_SESSION_ID;

      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config) || {},
        store: config.store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);

      const session = SecureExecSession.getOrCreate(threadId, {
        memoryLimitMb,
        cpuTimeLimitMs,
        backend: resolvedBackend,
        tools: ptcTools,
        allowNodeFs,
        allowNetwork,
      });

      const result = await session.eval(input.code, cpuTimeLimitMs);
      await session.flushWrites(resolvedBackend);

      return formatReplResult(result);
    },
    {
      name: "js_eval",
      description: dedent`
        Evaluate TypeScript/JavaScript code in a sandboxed REPL. State persists across calls.
        Use readFile(path) and writeFile(path, content) for file access.
        Use console.log() for output. Returns the result of the last expression.
      `,
      schema: z.object({
        code: z
          .string()
          .describe(
            "TypeScript/JavaScript code to evaluate in the sandboxed REPL",
          ),
      }),
    },
  );

  return createMiddleware({
    name: "SecureExecMiddleware",
    tools: [jsEvalTool],
    wrapModelCall: async (request, handler) => {
      const agentTools = (request.tools || []) as StructuredToolInterface[];
      ptcTools = usePtc ? filterToolsForPtc(agentTools) : [];

      if (ptcTools.length > 0 && !cachedPtcPrompt) {
        cachedPtcPrompt = await generatePtcPrompt(ptcTools);
      }

      const systemMessage = request.systemMessage
        .concat(baseSystemPrompt)
        .concat(cachedPtcPrompt || "");
      return handler({ ...request, systemMessage });
    },
  });
}
