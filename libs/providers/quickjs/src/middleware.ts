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
import { unwrapToolEnvelope } from "./coerce.js";

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
    JavaScript REPL. Your job here is to DISTRIBUTE work, not to do it yourself:
    write JavaScript that fans work out to subagents and assembles their results.
    You handle the orchestration - fan-out, filtering, deduplication, multi-stage
    flow, and synthesis - in plain JavaScript.

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
    it complete: the goal, the constraints, what to inspect, and the exact shape
    or level of detail you expect back. Give context as locators — file paths and
    symbol names — not as pasted file contents. If you already read a file while
    exploring, still pass its path and let the subagent read it; do not paste back
    what you read. Each dispatch is stateless from the caller's perspective; you
    cannot send follow-up messages to the same subagent run.

    \`responseSchema\` is optional, but set it on any dispatch whose result feeds
    later code. A deterministic, typed shape is what lets you compose the next
    stage reliably — index it, sort it, compare fields, branch on it, merge it —
    instead of parsing free-form text. This is what makes a whole workflow
    composable as one script. When provided, the resolved value is already a typed
    JavaScript value matching the schema; do not call \`JSON.parse\` unless the
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

    You can run the whole workflow in one \`${toolName}\` call or split it across
    several — both are fine. A single end-to-end script (generate, compare, pick a
    winner; or review every item, then synthesize) is clean when you can write it
    in one go; splitting is also fine when you want to inspect results between
    stages. Either way, don't redo work across calls — reuse what is already in
    scope (see "Reuse what earlier evals left in scope" below).

    #### Fan out with bounded concurrency

    Dispatch independent work in parallel with \`Promise.all\`, but in explicit
    batches around 10 so you do not launch hundreds of subagents at once. The bridge
    enforces a hard per-REPL cap of 32 concurrent subagent calls.

    \`\`\`javascript
    const files = ["/src/a.ts", "/src/b.ts", "/src/c.ts"]; // found while exploring
    const batchSize = 10;
    const reviewed = [];
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      reviewed.push(...(await Promise.all(batch.map(async (file) => {
        const result = await task({
          description: "Read " + file + " and review it for SQL injection. " +
            "Cite line numbers.",
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
        return { file, ...result };
      }))));
    }
    \`\`\`

    #### Explore with your own tools first, then distribute

    You already have your normal tools for reading, listing, globbing, and
    grepping files. Use them to explore and understand the task BEFORE you write
    the orchestration script. These are ordinary tool calls, separate from the
    \`${toolName}\` tool: read the data file, list or glob the directory, grep for
    what matters, then decide how to split the work.

    Never write \`${toolName}\` code that spawns a subagent just to read or parse a
    file or list a directory. That is a deterministic step you do yourself with a
    direct tool call; spending a whole agent loop on it is wasteful.

    Once you understand the shape of the work, you have creative freedom in how
    you split it:

    - One dispatch per file or per record, when the items are already separate.
    - Chunk a large input yourself — read it, split it, optionally write a small
      input file per chunk — and dispatch one subagent per chunk.
    - A cheap classification pass first, then deeper dispatches only for the items
      that warrant them.

    Then write JavaScript in the \`${toolName}\` tool that distributes the heavy,
    agentic work to subagents with \`task()\`: analyzing file contents, exploring a
    codebase, making judgment calls, rewriting code, or synthesizing a report.

    Hand each subagent a locator, not a payload. Subagents have their own file
    tools, so for anything that lives in a file — a file to review, rewrite, or
    audit — pass the path and let the subagent read it. Do NOT read a whole file
    just to paste its contents into the description; that bloats every dispatch
    and duplicates the file across them. Reserve inline content for small or
    derived data that has no path of its own: a single parsed record, or a chunk
    you split out of a larger input (write the chunk to its own file and pass that
    path if it is large). Assemble the results in JS.

    #### Compose multiple stages

    Filter the array in JS between passes. For example: first ask subagents for a
    cheap classification, filter to the risky items, then dispatch deeper reviews
    only for those items.

    \`\`\`javascript
    const tagged = await Promise.all(files.map((file) =>
      task({
        description: "Read " + file + " and classify it as handler, util, " +
          "test, or config.",
        subagentType: "reviewer",
        responseSchema: {
          type: "object",
          properties: { kind: { type: "string" }, risky: { type: "boolean" } },
          required: ["kind", "risky"],
        },
      }).then((tag) => ({ file, ...tag }))
    ));

    const riskyHandlers = tagged.filter((it) => it.kind === "handler" && it.risky);
    const deepReviews = await Promise.all(riskyHandlers.map((it) =>
      task({
        description: "Deep security review of " + it.file + ". Cite line numbers.",
        subagentType: "reviewer",
      }).then((review) => ({ ...it, review }))
    ));
    \`\`\`

    #### Return results via the last expression, not \`console.log\`

    The value of the last expression in an \`${toolName}\` call (or a resolved
    top-level \`await\`) is returned to you as the result. Make that final
    expression the variable holding your result and read it from there.
    \`console.log\` is only for incidental debugging: its output is capped and
    truncated, while the returned value is not, so never \`console.log\` your
    actual results.

    Keep large intermediate sets in JS variables and return only a compact
    summary or a small slice, not the entire dataset. To persist full output,
    have a subagent write it, or write it with your own file tool outside the
    \`${toolName}\` call.

    #### Reuse what earlier evals left in scope

    The REPL is persistent within a turn: every top-level variable, function, and
    class you declare is kept and is available in your next \`${toolName}\` call
    (each is hoisted to global scope). So if a later step needs something an
    earlier eval produced or bound, **reference that variable by name** — do not
    write a new literal that re-types data a previous eval already returned or
    computed.

    If you catch yourself pasting a big array or object of values you produced in
    an earlier call, that is the tell: the variable is still in scope, so use it.
    Re-typing prior results as a fresh literal wastes tokens and drifts from what
    actually ran.

    \`\`\`javascript
    // An earlier eval bound this:
    //   const auditResults = await Promise.all(files.map(/* ...audit... */));

    // A later eval — reference it; do NOT paste the findings back in as a literal:
    const findings = auditResults.flatMap((r) =>
      r.findings.map((f) => ({ ...f, file: r.file }))
    );
    const verified = await Promise.all(findings.map((f) =>
      task({ description: "Verify this finding: " + f.evidence, subagentType: "verifier" })
        .then((v) => ({ ...f, ...v }))
    ));
    \`\`\`

    #### When the user asks for a "workflow"

    If the user's request mentions running a "workflow" (or otherwise uses the
    word "workflow"), fan the work out to subagents rather than doing it all
    yourself. Explore with your own tools first as needed, then write JavaScript
    in the \`${toolName}\` tool that dispatches subagents with \`task()\` and
    assembles their results. The point is to distribute the heavy work in
    parallel, not to grind through it one tool call at a time.
  `;
}

function renderReplSystemPrompt(opts: {
  toolName: string;
  timeout: number;
  memoryLimitMb: number;
  hasPtc: boolean;
}): string {
  const sideEffects = opts.hasPtc
    ? " External side effects from inside the REPL are reachable only via the `tools.*` namespace documented below."
    : " The REPL is pure computation; do any filesystem or other I/O with your normal tools, outside this tool.";
  return dedent`
    ### Interpreter

    An \`${opts.toolName}\` tool is available. It runs JavaScript in a persistent REPL.
    - State (variables, functions) persists across tool calls within a single turn of conversation. They DO NOT persist across multiple turns.
    - Top-level \`await\` works; Promises resolve before the call returns.
    - Runtime sandbox: no built-in filesystem, network, stdlib, or wall-clock APIs (\`fetch\`, \`require\`, \`fs\`, \`process\`, real \`Date.now()\` are unavailable or stubbed).${sideEffects}
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
 *
 * Throws if the subagent `task` tool is requested (by name or instance): it is
 * reserved for the `task()` global and cannot be a `tools.*` PTC member.
 */
export function resolveToolList(
  items: (string | StructuredToolInterface)[],
  agentTools: StructuredToolInterface[],
): StructuredToolInterface[] {
  const agentByName = new Map(agentTools.map((t) => [t.name, t]));
  return items.flatMap((item) => {
    const name = typeof item === "string" ? item : item.name;
    if (name === "task") {
      throw new Error(
        "The subagent `task` tool cannot be exposed via `ptc`. It is always " +
          "available as the top-level `task()` global inside the REPL (with " +
          "`subagentType` and `responseSchema` support); exposing it through the " +
          "`tools.*` namespace would create a second, conflicting dispatch path " +
          'that drops `responseSchema`. Remove "task" from `ptc`.',
      );
    }
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
    subagents = true,
  } = options;

  const maxSubagentConcurrency = subagents
    ? DEFAULT_MAX_SUBAGENT_CONCURRENCY
    : 0;

  if (maxPtcCalls !== null && maxPtcCalls !== undefined && maxPtcCalls < 1) {
    throw new Error("`maxPtcCalls` must be >= 1 or null");
  }

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

      // The task tool resolves to a Command envelope; unwrap it to the
      // subagent's actual output before handing it back to the REPL.
      const content = unwrapToolEnvelope(result);

      if (hasSchema && typeof content === "string") {
        try {
          return JSON.parse(content);
        } catch {
          return content;
        }
      }
      return content;
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

      const baseSystemPrompt =
        customSystemPrompt ||
        renderReplSystemPrompt({
          toolName,
          timeout: executionTimeoutMs / 1000,
          memoryLimitMb: Math.floor(memoryLimitBytes / (1024 * 1024)),
          hasPtc: ptcTools.length > 0,
        });

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
