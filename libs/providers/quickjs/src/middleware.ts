/**
 * Code Interpreter middleware for deepagents.
 *
 * Provides an `eval` tool that runs JavaScript in a WASM-sandboxed QuickJS
 * interpreter. Supports:
 * - Persistent state across evaluations (true REPL)
 * - Programmatic tool calling (PTC) — expose agent or custom tools inside the REPL
 */

import {
  createMiddleware,
  tool,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { z } from "zod/v4";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  SUBAGENT_SPECS_CONFIG_KEY,
  type SubagentSpecsPayload,
} from "deepagents";

import dedent from "dedent";
import type {
  CodeInterpreterMiddlewareOptions,
  SubagentBridgeOptions,
} from "./types.js";
import {
  ReplSession,
  DEFAULT_EXECUTION_TIMEOUT,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_MAX_STACK_SIZE,
  DEFAULT_SESSION_ID,
  DEFAULT_MAX_PTC_CALLS,
  DEFAULT_MAX_RESULTS_CHARS,
  DEFAULT_MAX_SUBAGENT_CONCURRENCY,
} from "./session.js";
import {
  formatReplResult,
  toCamelCase,
  toolToTypeSignature,
  safeToJsonSchema,
} from "./utils.js";
import { SubagentDispatcher } from "./subagent-dispatch.js";

/**
 * These type-only imports are required for TypeScript's type inference to work
 * correctly with the langchain/langgraph middleware system. Without them, certain
 * generic type parameters fail to resolve properly, causing runtime issues with
 * tool schemas and message types.
 */
import type * as _zodTypes from "@langchain/core/utils/types";
import type * as _zodMeta from "@langchain/langgraph/zod";
import type * as _messages from "@langchain/core/messages";
import { LangGraphRunnableConfig } from "@langchain/langgraph";

const DEFAULT_TOOL_NAME = "eval";

function renderReplSystemPrompt(opts: {
  toolName: string;
  timeout: number;
  memoryLimitMb: number;
}): string {
  return dedent`
    ### Interpreter

    An \`${opts.toolName}\` tool is available. It runs JavaScript in a persistent REPL.
    - State (variables, functions) persists across tool calls within a single turn of conversation. They DO NOT persist across multiple turns.
    - Top-level \`await\` works; Promises resolve before the call returns.
    - Runtime sandbox: no built-in filesystem, network, stdlib, or wall-clock APIs (\`fetch\`, \`require\`, \`fs\`, \`process\`, real \`Date.now()\` are unavailable or stubbed). External side effects from inside the REPL are only reachable via the \`tools.*\` namespace when it is exposed (see below); without it, the REPL is pure computation.
    - Timeout: ${opts.timeout}s per call. Memory: ${opts.memoryLimitMb} MB total.
    - \`console.log\` output is captured and returned alongside the result.
  `;
}

/**
 * Generate the system prompt section for the subagent primitive.
 *
 * @param descriptions - Available subagent names and descriptions.
 */
function renderSubagentPrompt(
  descriptions: Array<{ name: string; description: string }>,
): string {
  const descList = descriptions
    .map((d) => `- \`${d.name}\`: ${d.description}`)
    .join("\n");

  return dedent`
    ### Subagent Primitive

    A \`subagent()\` function is available as a global in the REPL for spawning subagents programmatically.

    \`\`\`typescript
    /**
     * Spawn a subagent to handle an isolated task.
     * @returns Text response, or a parsed object when responseSchema is provided.
     */
    async subagent(input: {
      /** Task description — be specific about what to do and what to return. */
      description: string;
      /** Subagent type name. */
      subagentType: string;
      /** JSON Schema for structured output. The subagent is recompiled with this as its response format. */
      responseSchema?: Record<string, unknown>;
    }): Promise<string | object>
    \`\`\`

    Available subagent types:
    ${descList}

    - Without \`responseSchema\`: returns the subagent's text response as a string.
    - With \`responseSchema\`: the subagent is compiled with structured output enforcement and returns a parsed object.
    - Use \`Promise.all\` for concurrent execution. Concurrency is managed automatically (max 16 in-flight).
    - The \`subagent\` function is independent of the \`tools\` namespace.
  `;
}

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
    const result = await tools.searchWeb({ query: "QuickJS tutorial" });
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
 * Resolves a mixed list of tool names and tool instances into a flat list of
 * StructuredToolInterface objects. Strings are looked up by name in agentTools;
 * instances are included directly without requiring agent registration. Strings
 * that don't match any agent tool are silently omitted.
 */
export function resolveToolList(
  items: (string | StructuredToolInterface)[],
  agentTools: StructuredToolInterface[],
): StructuredToolInterface[] {
  const agentByName = new Map(agentTools.map((t) => [t.name, t]));
  return items.flatMap((item) => {
    if (typeof item === "string") {
      const found = agentByName.get(item);
      return found ? [found] : [];
    }
    return [item];
  });
}

/**
 * Create the Code Interpreter middleware.
 */
export function createCodeInterpreterMiddleware(
  options: CodeInterpreterMiddlewareOptions = {},
) {
  const {
    ptc,
    memoryLimitBytes = DEFAULT_MEMORY_LIMIT,
    maxStackSizeBytes = DEFAULT_MAX_STACK_SIZE,
    executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT,
    systemPrompt: customSystemPrompt = null,
    maxPtcCalls = DEFAULT_MAX_PTC_CALLS,
    maxResultChars = DEFAULT_MAX_RESULTS_CHARS,
    toolName = DEFAULT_TOOL_NAME,
    captureConsole = true,
    maxSubagentConcurrency = DEFAULT_MAX_SUBAGENT_CONCURRENCY,
  } = options;

  if (maxPtcCalls !== null && maxPtcCalls !== undefined && maxPtcCalls < 1) {
    throw new Error("`maxPtcCalls` must be >= 1 or null");
  }

  const baseSystemPrompt =
    customSystemPrompt ||
    renderReplSystemPrompt({
      toolName,
      timeout: executionTimeoutMs / 1000,
      memoryLimitMb: Math.floor(memoryLimitBytes / (1024 * 1024)),
    });

  const middlewareId = crypto.randomUUID();

  let cachedPtcPrompt: string | null = null;
  let ptcTools: StructuredToolInterface[] = [];
  let dispatcher: SubagentDispatcher | null = null;
  let subagentPrompt: string | null = null;

  function filterToolsForPtc(
    allTools: StructuredToolInterface[],
  ): StructuredToolInterface[] {
    if (!ptc) return [];

    const candidates = allTools.filter((t) => t.name !== toolName);

    return resolveToolList(ptc, candidates);
  }

  function createBridgeDispatch(
    dispatcher: SubagentDispatcher,
  ): SubagentBridgeOptions["dispatch"] {
    return async (input) => {
      return dispatcher.invoke(
        input.description,
        input.subagentType,
        input.responseSchema,
      );
    };
  }

  const evalTool = tool(
    async (input, config: LangGraphRunnableConfig) => {
      const threadId = config.configurable?.thread_id || DEFAULT_SESSION_ID;
      const sessionKey = `${threadId}:${middlewareId}`;

      // Build the dispatcher from specs on first eval (specs arrive via configurable)
      if (!dispatcher && maxSubagentConcurrency > 0) {
        const payload = config.configurable?.[SUBAGENT_SPECS_CONFIG_KEY] as
          | SubagentSpecsPayload
          | undefined;
        if (payload) {
          dispatcher = new SubagentDispatcher(payload);
        }
      }

      const session = ReplSession.getOrCreate(sessionKey, {
        memoryLimitBytes,
        maxStackSizeBytes,
        maxPtcCalls,
        tools: ptcTools,
        maxResultChars,
        captureConsole,
        sessionId: threadId,
        subagentBridge: dispatcher
          ? {
              dispatch: createBridgeDispatch(dispatcher),
              maxConcurrency: maxSubagentConcurrency,
            }
          : undefined,
      });

      const result = await session.eval(input.code, executionTimeoutMs);
      return formatReplResult(result);
    },
    {
      name: toolName,
      description: dedent`
        Evaluate TypeScript/JavaScript code in a sandboxed REPL. State persists across calls.
        Use console.log() for output. Returns the result of the last expression.
        If file or other tools are available, call them via the tools namespace: await tools.readFile({ path }).
      `,
      metadata: { ls_code_input_language: "javascript" },
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
    name: "CodeInterpreterMiddleware",
    tools: [evalTool],
    wrapModelCall: async (request, handler) => {
      const agentTools = (request.tools || []) as StructuredToolInterface[];
      ptcTools = filterToolsForPtc(agentTools);

      if (ptcTools.length > 0 && !cachedPtcPrompt) {
        cachedPtcPrompt = await generatePtcPrompt(ptcTools);
      }

      if (!subagentPrompt && maxSubagentConcurrency > 0) {
        const configurable = (request as any).runtime?.configurable as
          | Record<string, unknown>
          | undefined;
        const payload = configurable?.[SUBAGENT_SPECS_CONFIG_KEY] as
          | SubagentSpecsPayload
          | undefined;
        if (payload) {
          subagentPrompt = renderSubagentPrompt(
            payload.subagents.map((s) => ({
              name: s.name,
              description: s.description,
            })),
          );
        }
      }

      const systemMessage = request.systemMessage
        .concat(baseSystemPrompt)
        .concat(cachedPtcPrompt || "")
        .concat(subagentPrompt || "");
      return handler({ ...request, systemMessage });
    },
    afterAgent: async (_state, runtime) => {
      const threadId = runtime.configurable?.thread_id ?? DEFAULT_SESSION_ID;
      const sessionKey = `${threadId}:${middlewareId}`;
      ReplSession.deleteSession(sessionKey);
    },
  });
}
