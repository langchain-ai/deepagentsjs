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
import { SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY } from "deepagents";

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
import { validateResponseSchema } from "./subagent-dispatch.js";

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

/**
 * Render the subagent dispatch prompt section for the system message.
 * Ported from the Python `_SUBAGENT_SYSTEM_PROMPT_TEMPLATE`.
 */
function renderSubagentPrompt(toolName: string): string {
  return dedent`

    ### Dispatching Subagents with \`task\`

    \`task\` is your primitive for running configured subagents from inside the
    JavaScript REPL. You orchestrate everything else - fan-out, filtering,
    deduplication, multi-stage flow, and synthesis - in plain JavaScript.

    #### The primitive

    \`\`\`javascript
    await task({
      description,      // full autonomous task prompt
      subagentType,     // configured subagent name
      responseSchema,   // optional JSON Schema for structured output
    }); // -> Promise<unknown>
    \`\`\`

    \`task\` runs a full agentic loop for the selected configured subagent. The
    subagent can use whatever tools it was configured with, iterate, inspect
    context, and return one final result. \`subagentType\` is required; use one of
    the configured subagent names.

    \`description\` is the only prompt the subagent receives for this dispatch. Make
    it complete: include the goal, constraints, relevant context, what to inspect,
    and the exact shape or level of detail you expect back. Each dispatch is
    stateless from the caller's perspective; you cannot send follow-up messages to
    the same subagent run.

    \`responseSchema\` is optional. When provided, the resolved value is already a
    typed JavaScript value matching the schema. Do not call \`JSON.parse\` unless the
    subagent intentionally returned a JSON string. Dynamic schemas work for
    declarative subagents; runnable-backed subagents reject dynamic schemas because
    their runnable is already compiled.

    #### Approval model

    \`task\` dispatches from inside the already-running \`${toolName}\` call. It
    does not route through the parent agent's \`ToolNode\`-managed \`task\` tool and
    does not trigger parent-level \`interrupt_on\` / HITL approval for each dispatch.
    Declarative subagents still honor approval middleware configured inside their
    own spec. If you need approval before launching a subagent from the parent, use
    the normal \`task\` tool outside JavaScript or ensure the \`${toolName}\` call
    itself is approval-gated.

    #### Mental model

    Hold your work in JS: an array of items in, an array of results out. Merge each
    dispatch result back onto its item. Multi-stage analysis means: run a pass,
    filter or regroup the array in JS, then run another pass over the survivors.

    Prefer one \`${toolName}\` call that performs the whole workflow. Splitting the
    workflow across multiple \`${toolName}\` calls costs model turns and forces you to
    re-establish state.

    #### Fan out with bounded concurrency

    Dispatch independent work in parallel with \`Promise.all\`, but in explicit
    batches around 10 so you do not launch hundreds of subagents at once. The bridge
    enforces a hard per-REPL cap of 32 concurrent subagent calls.

    \`\`\`javascript
    const batchSize = 10;
    const reviewed = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      reviewed.push(...(await Promise.all(batch.map(async (it) => {
        const result = await task({
          description: "Review " + it.file + " for SQL injection. Cite line numbers.",
          subagentType: "reviewer",
          responseSchema: {
            type: "object",
            properties: {
              vulnerabilities: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    line: { type: "number" },
                    evidence: { type: "string" },
                  },
                  required: ["type", "line", "evidence"],
                },
              },
            },
            required: ["vulnerabilities"],
          },
        });
        return { ...it, ...result };
      }))));
    }
    \`\`\`

    #### Use parent JS for cheap work; use subagents for agentic work

    Use JavaScript in the parent REPL for deterministic orchestration: joining
    arrays, deduping, sorting, filtering, grouping, batching, and merging results.
    If the \`tools.*\` namespace is exposed, also use it to pre-read files or collect
    shared data once, then pass only the relevant content to each subagent in
    \`description\`.

    Use \`task\` for work that benefits from an autonomous agentic loop: reading
    or searching with the subagent's own tools, inspecting multiple files, following
    leads, making judgment calls, or producing a final synthesized report.

    #### Pre-read shared context in the parent when useful

    If many subagents need the same source list or file content and \`tools.*\` is
    available, gather that context once in the parent REPL before dispatching:

    \`\`\`javascript
    const files = (await tools.glob({ pattern: "src/**/*.ts" }))
      .split("\\n")
      .filter(Boolean);

    const items = await Promise.all(files.map(async (file) => {
      const content = await tools.readFile({ file_path: file });
      return { file, content };
    }));

    const batchSize = 10;
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      results.push(...(await Promise.all(batch.map(async (it) => {
        const finding = await task({
          description:
            "Review this file for auth bypasses. Return concrete findings only.\\n\\n" +
            "File: " + it.file + "\\n\\n" +
            it.content,
          subagentType: "reviewer",
          responseSchema: {
            type: "object",
            properties: {
              findings: { type: "array", items: { type: "object" } },
            },
            required: ["findings"],
          },
        });
        return { ...it, ...finding };
      }))));
    }
    \`\`\`

    #### Compose multiple stages

    Filter the array in JS between passes. For example: first ask subagents for a
    cheap classification, filter to the risky items, then dispatch deeper reviews
    only for those items.

    \`\`\`javascript
    const tagged = [];
    for (let i = 0; i < items.length; i += 10) {
      const batch = items.slice(i, i + 10);
      tagged.push(...(await Promise.all(batch.map(async (it) => {
        const tag = await task({
          description: "Classify " + it.file + " as handler, util, test, or config.",
          subagentType: "reviewer",
          responseSchema: {
            type: "object",
            properties: { kind: { type: "string" }, risky: { type: "boolean" } },
            required: ["kind", "risky"],
          },
        });
        return { ...it, ...tag };
      }))));
    }

    const riskyHandlers = tagged.filter((it) => it.kind === "handler" && it.risky);
    const deepReviews = [];
    for (let i = 0; i < riskyHandlers.length; i += 10) {
      const batch = riskyHandlers.slice(i, i + 10);
      deepReviews.push(...(await Promise.all(batch.map(async (it) => {
        const review = await task({
          description: "Deep security review of " + it.file + ". Cite line numbers.",
          subagentType: "reviewer",
        });
        return { ...it, review };
      }))));
    }
    \`\`\`

    #### Get results out without flooding your context

    Keep large result sets in JS variables. Do not \`console.log\` the full result set.
    If \`tools.writeFile\` is exposed, persist structured output from inside the eval:

    \`\`\`javascript
    await tools.writeFile({
      file_path: "/results/subagent-output.json",
      content: JSON.stringify(deepReviews),
    });
    \`\`\`

    Otherwise return a compact summary or a small slice of the results, not the
    entire intermediate dataset.

    #### Across evals

    Variables persist according to the interpreter persistence mode above, but
    re-establish what you need in each eval. Doing the whole workflow in one
    \`${toolName}\` call is usually simplest.
  `;
}

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
  let taskTool: StructuredToolInterface | null = null;

  function filterToolsForPtc(
    allTools: StructuredToolInterface[],
  ): StructuredToolInterface[] {
    if (!ptc) return [];

    const candidates = allTools.filter((t) => t.name !== toolName);

    return resolveToolList(ptc, candidates);
  }

  function findTaskTool(
    tools: StructuredToolInterface[],
  ): StructuredToolInterface | null {
    return tools.find((t) => t.name === "task") ?? null;
  }

  function createBridgeDispatch(
    subagentTaskTool: StructuredToolInterface,
    config: LangGraphRunnableConfig,
  ): SubagentBridgeOptions["dispatch"] {
    return async (input) => {
      const hasSchema = input.responseSchema != null;
      if (hasSchema) {
        validateResponseSchema(input.responseSchema!);
      }

      const toolConfig = {
        ...config,
        configurable: {
          ...config.configurable,
          ...(hasSchema && {
            [SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY]: input.responseSchema,
          }),
        },
      };

      const result = await subagentTaskTool.invoke(
        {
          description: input.description,
          subagent_type: input.subagentType,
        },
        toolConfig,
      );

      if (hasSchema && typeof result === "string") {
        try {
          return JSON.parse(result);
        } catch {
          return result;
        }
      }
      return result;
    };
  }

  const evalTool = tool(
    async (input, config: LangGraphRunnableConfig) => {
      const threadId = config.configurable?.thread_id || DEFAULT_SESSION_ID;
      const sessionKey = `${threadId}:${middlewareId}`;

      const session = ReplSession.getOrCreate(sessionKey, {
        memoryLimitBytes,
        maxStackSizeBytes,
        maxPtcCalls,
        tools: ptcTools,
        maxResultChars,
        captureConsole,
        sessionId: threadId,
        subagentBridge:
          taskTool && maxSubagentConcurrency > 0
            ? {
                dispatch: createBridgeDispatch(taskTool, config),
                maxConcurrency: maxSubagentConcurrency,
              }
            : undefined,
      });

      if (taskTool && maxSubagentConcurrency > 0) {
        session.updateBridgeDispatch(createBridgeDispatch(taskTool, config));
      }

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

      if (!taskTool && maxSubagentConcurrency > 0) {
        taskTool = findTaskTool(agentTools);
      }

      if (ptcTools.length > 0 && !cachedPtcPrompt) {
        cachedPtcPrompt = await generatePtcPrompt(ptcTools);
      }

      const subagentPrompt =
        taskTool && maxSubagentConcurrency > 0
          ? renderSubagentPrompt(toolName)
          : "";

      const systemMessage = request.systemMessage
        .concat(baseSystemPrompt)
        .concat(subagentPrompt)
        .concat(cachedPtcPrompt || "");
      return handler({ ...request, systemMessage });
    },
    afterAgent: async (_state, runtime) => {
      const threadId = runtime.configurable?.thread_id ?? DEFAULT_SESSION_ID;
      const sessionKey = `${threadId}:${middlewareId}`;
      ReplSession.deleteSession(sessionKey);
    },
  });
}
