/**
 * QuickJS REPL middleware for deepagents.
 *
 * Provides a `js_eval` tool that runs JavaScript in a WASM-sandboxed QuickJS
 * interpreter. Supports:
 * - Persistent state across evaluations (true REPL)
 * - VFS integration via readFile/writeFile
 * - Programmatic tool calling (PTC)
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
  type BackendRuntime,
  resolveBackend,
  DEFAULT_CONCURRENCY,
  setSubagentGraphInjector,
} from "deepagents";

import dedent from "dedent";
import type { QuickJSMiddlewareOptions, ReplSessionOptions } from "./types.js";
import {
  ReplSession,
  DEFAULT_EXECUTION_TIMEOUT,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_MAX_STACK_SIZE,
  DEFAULT_SESSION_ID,
} from "./session.js";
import {
  formatReplResult,
  toCamelCase,
  toolToTypeSignature,
  safeToJsonSchema,
} from "./utils.js";

/**
 * These type-only imports are required for TypeScript's type inference to work
 * correctly with the langchain/langgraph middleware system. Without them, certain
 * generic type parameters fail to resolve properly, causing runtime issues with
 * tool schemas and message types.
 */
import type * as _zodTypes from "@langchain/core/utils/types";
import type * as _zodMeta from "@langchain/langgraph/zod";
import type * as _messages from "@langchain/core/messages";
import {
  getCurrentTaskInput,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";

/**
 * Backend-provided tools excluded from PTC by default.
 * These are redundant inside the REPL since VFS helpers (readFile/writeFile)
 * already cover file I/O against the agent's in-memory working set.
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

function buildReplSystemPrompt(hasSwarm: boolean): string {
  const largeFileRule = hasSwarm
    ? `- **Check file size before processing** — before working with any input file, check its size using \`read_file\` (inspect \`result.length\`) or \`ls\`. If the file exceeds ~50,000 characters, you **must** use \`swarm()\` to decompose the work — do not process it inline. See "Parallel fan-out" below.`
    : `- **Check file size before processing** — before working with any input file, check its size. If it exceeds ~50,000 characters, decompose the work into chunks and process them separately.`;

  return dedent`
  ## TypeScript/JavaScript REPL (\`js_eval\`)

  You have access to a sandboxed TypeScript/JavaScript REPL running in an isolated interpreter.
  TypeScript syntax (type annotations, interfaces, generics, \`as\` casts) is supported and stripped at evaluation time.
  Variables, functions, and closures persist across calls within the same session.

  ### Hard rules

  ${largeFileRule}
  - **No network, no imports** — do not attempt \`fetch\`, \`require\`, or \`import\` inside \`js_eval\`. Use your file tools (\`read_file\`, \`grep\`, \`ls\`, etc.) for exploration and \`readFile\`/\`writeFile\` for direct REPL file I/O.
  - **Cite your sources** — when reporting values from files, include the path and key/index so the user can verify.
  - **Use console.log()** for output — it is captured and returned. \`console.warn()\` and \`console.error()\` are also available.
  - **Reuse state from previous cells** — variables, functions, and results from earlier \`js_eval\` calls persist across calls. Reference them by name in follow-up cells instead of re-embedding data as inline JSON literals.

  ### First-time usage

  \`\`\`typescript
  // Read a file from the agent's virtual filesystem
  const raw: string = await readFile("/data.json");
  const data = JSON.parse(raw) as { n: number };
  console.log(data);

  // Write results back
  await writeFile("/output.txt", JSON.stringify({ result: data.n }));
  \`\`\`

  ### API Reference — built-in globals

  \`\`\`typescript
  /**
   * Read a file from the agent's virtual filesystem. Throws if the file does not exist.
   */
  async readFile(path: string): Promise<string>

  /**
   * Write a file to the agent's virtual filesystem.
   */
  async writeFile(path: string, content: string): Promise<void>
  \`\`\`

  ### Limitations

  - ES2023+ syntax with TypeScript support. No Node.js APIs, no \`require\`, no \`import\`.
  - Output is truncated beyond a fixed character limit — be selective about what you log.
  - Execution timeout per call (default 30 s).
`;
}

const SWARM_FANOUT_PROMPT = dedent`
  ## Parallel fan-out (\`swarm()\` in js_eval)

  Use \`swarm()\` inside \`js_eval\` to fan out independent tasks across multiple subagents in parallel and aggregate their results.

  ### When to use swarm

  **Trigger condition**: Check the size of your input files. If any input file exceeds ~50KB, **you must use swarm** — do not attempt to process it inline. Reading a large file directly and processing it yourself is always wrong when swarm is available.

  Also use swarm when:
  - A task requires applying intelligence to each item in a large collection
  - Work can be decomposed into many independent, parallel subtasks

  ### How to use swarm

  **1. Understand the data deeply before dispatching.** If the file exceeds 50,000 characters, do not attempt to process or solve the task inline — your goal is to understand the data well enough to write precise subagent instructions. Use every tool available to you: \`read_file\` to sample content and spot patterns, \`grep\` to find labels, delimiters, edge cases, and outliers, \`ls\` to orient, \`js_eval\` to parse structure or count distributions. The time you invest here directly determines subagent accuracy — a vague description produces vague results. You know enough when you can answer: What is the exact data format? What are the complete processing rules (including edge cases)? What are all possible output values?

  **2. Dispatch via \`js_eval\`.** Read the input, split it into chunks, and call \`swarm()\`:

  \`\`\`typescript
  const raw = await readFile("/data.txt");
  const lines = raw.split("\\n").filter(Boolean);
  const chunkSize = 50;

  const outputSchema = {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string", enum: ["category_a", "category_b", "category_c"] },
          },
          required: ["id", "label"]
        }
      }
    },
    required: ["results"]
  };

  const tasks = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, i + chunkSize).join("\\n");
    tasks.push({
      id: \`chunk_\${i}\`,
      description: \`Classify each line as [category_a] or [category_b].

Rules:
- [rule 1 derived from your exploration]
- [rule 2 derived from your exploration]

Data format: one item per line, fields separated by [delimiter].

Data:
\${chunk}\`,
      responseSchema: outputSchema
    });
  }

  const summary = JSON.parse(await swarm({ tasks }));
  console.log("Completed:", summary.completed, "Failed:", summary.failed);
  \`\`\`

  **3. Aggregate.** Combine results in the same \`js_eval\` call or a follow-up call:

  \`\`\`typescript
  const merged = [];
  for (const r of summary.results) {
    if (r.status === "completed") {
      try { merged.push(...JSON.parse(r.result).results); }
      catch (e) { /* skip unparseable */ }
    }
  }
  console.log(JSON.stringify(merged));
  \`\`\`

  For qualitative synthesis (summarization, narrative), read \`<resultsDir>/results.jsonl\` with \`read_file\` after \`js_eval\` and aggregate using your own judgment instead.

  **Prefer many small tasks over few large ones** — all tasks run in parallel, so 50 small tasks finish in roughly the same wall-clock time as 5 large ones. When splitting a file, aim for **30–60 lines** per chunk.

  ### API Reference — \`swarm()\`

  \`\`\`typescript
  /**
   * Dispatch tasks to subagents in parallel. Returns a JSON string — use JSON.parse() on the result.
   */
  async function swarm(input: {
    // Pre-built tasks form
    tasks?: Array<{
      id: string;           // unique task identifier
      description: string;  // complete, self-contained prompt for the subagent
      subagentType?: string; // which subagent to use (default: "general-purpose")
      responseSchema?: object; // JSON Schema for structured output (must have type: "object" at top level)
    }>;
    // Virtual-table form (alternative to tasks)
    glob?: string | string[];       // glob pattern(s) to match files
    filePaths?: string[];           // explicit file paths
    instruction?: string;           // shared instruction for each file
    subagentType?: string;          // subagent type for all tasks
    concurrency?: number;           // max concurrent subagents (default: ${DEFAULT_CONCURRENCY})
  }): Promise<string>  // JSON string of SwarmExecutionSummary

  // Parsed summary shape:
  // {
  //   total: number;
  //   completed: number;
  //   failed: number;
  //   resultsDir: string;       // VFS path — read resultsDir + "/results.jsonl" for per-task outputs
  //   results: Array<{
  //     id: string;
  //     subagentType: string;
  //     status: "completed" | "failed";
  //     result?: string;    // present when status is "completed"
  //     error?: string;     // present when status is "failed"
  //   }>;
  //   failedTasks: Array<{ id: string; error: string }>;
  // }
  //
  // Each line in results.jsonl:
  // { id: string; subagentType: string; status: "completed" | "failed"; result?: string; error?: string }
  \`\`\`

  ### Task description quality

  Each subagent receives **only its task description** — no other context, no access to the original file. The quality of your descriptions is the single biggest lever on result accuracy.

  Good task descriptions are **prescriptive and complete**: they give the subagent everything it needs to work mechanically, with no judgment calls required. Include:
  - **Data format**: how each item is structured (delimiters, fields, encoding)
  - **All possible output values**: every valid label, category, or answer — no ambiguity
  - **Classification rules**: the criteria you derived from exploration, including edge cases and examples from the actual data
  - **The data itself**: the exact chunk being processed

  The subagent has no access to your exploration findings. Everything you learned — patterns, exceptions, label definitions — must be written into the description.

  Bad: \`"Classify these news articles by topic."\`
  Good: \`"Classify each article into exactly one of: World, Sports, Business, Sci/Tech. Use World for international relations, diplomacy, wars between nations. Use Sports for any competitive athletic event or athlete news. Use Business for markets, companies, economic policy. Use Sci/Tech for science research, technology products, or space. When an article spans two categories, pick the dominant one. Format: one JSON object per article with fields 'id' (the number at the start of the line) and 'label'."\`

  ### Structured output with \`responseSchema\`

  Use \`responseSchema\` whenever results need to be aggregated programmatically. It enforces the schema at the model API level — strictly more reliable than asking for JSON in the prompt. The subagent remains fully agentic (tools, reasoning) — only its final response is constrained.

  \`\`\`typescript
  {
    id: "t1",
    description: "Classify each item...",
    responseSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The item identifier from the input" },
              label: {
                type: "string",
                enum: ["positive", "negative", "neutral"],
                description: "Sentiment category for this item"
              }
            },
            required: ["id", "label"]
          },
          minItems: 1
        }
      },
      required: ["results"]
    }
  }
  \`\`\`

  **Schema tips for better accuracy:**

  - **\`enum\`** for categorical fields — forces exact matches, prevents aggregation errors from label variations.
  - **\`description\`** on properties — the model reads these when generating output. Use them to reinforce what each field should contain.
  - **\`minItems\` / \`maxItems\`** on arrays — ensures the subagent returns the expected number of items.
  - **\`minimum\` / \`maximum\`** on numbers — constrains numeric ranges (e.g., confidence scores 0–1).

  **Schema rules** (enforced at dispatch time — violations throw before any subagent runs):

  - Top-level \`type\` must be \`"object"\`. Wrap arrays in an object with a \`results\` field.
  - \`properties\` must be defined with at least one explicit field. Open schemas (\`additionalProperties\` alone, no \`properties\`) are rejected by the structured-output runtime.
  - Declare every field you expect. If you do not know the keys ahead of time, use a \`results: { type: "array", items: {...} }\` wrapper instead of an open object.

  Without \`responseSchema\`, instruct subagents explicitly in the task description:

  \`\`\`
  Respond with ONLY a raw JSON object — no markdown fences, no explanation, no other text.
  Output schema: { ... }
  \`\`\`

  ### Error handling

  **One retry for failures, then move on.** If tasks fail due to schema or description errors, fix the root cause and call \`swarm()\` **once more** targeting just the failed ids. Do not retry a second time.

  - **Many failures** (>20%): likely a systemic issue with the schema or description — fix and retry once.
  - **Few failures** (<20%): aggregate the completed results and move on.

  **Never recheck completed results.** Do not dispatch "recheck", "verify", or "cross-check" tasks for results that already succeeded. Completed results are final — accept them as-is and aggregate. Re-dispatching the same data with different task IDs is still rechecking and is not allowed.

  ### Decomposition patterns

  **Flat fan-out**: Split a dataset into equal chunks. All tasks are identical in structure.
  Good for: large files, classification, extraction.

  **One-per-item**: One task per discrete unit (file, document, URL).
  Good for: summarizing collections, processing independent documents.

  **Dimensional**: Multiple tasks examine the same input from different angles.
  Good for: code review, multi-criteria evaluation.
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
 * Create the QuickJS REPL middleware.
 *
 * The REPL exposes `readFile`, `writeFile`, and `swarm` as built-in globals.
 * `swarm` is always available; subagent graphs are injected automatically
 * by `createDeepAgent` — no configuration needed.
 */
export function createQuickJSMiddleware(
  options: QuickJSMiddlewareOptions = {},
) {
  const {
    backend = (runtime: BackendRuntime) => new StateBackend(runtime),
    ptc = false,
    memoryLimitBytes = DEFAULT_MEMORY_LIMIT,
    maxStackSizeBytes = DEFAULT_MAX_STACK_SIZE,
    executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT,
    systemPrompt: customSystemPrompt = null,
  } = options;

  // Populated by createDeepAgent via QUICKJS_SWARM_INJECTOR before first eval.
  let subagentGraphs: ReplSessionOptions["subagentGraphs"];
  let subagentFactories: ReplSessionOptions["subagentFactories"];

  const usePtc = ptc !== false;
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

      const runtime: BackendRuntime = {
        ...config,
        state: getCurrentTaskInput(config) || {},
      } as BackendRuntime;
      const resolvedBackend = await resolveBackend(backend, runtime);
      const currentState = (getCurrentTaskInput(config) || {}) as Record<
        string,
        unknown
      >;

      const session = ReplSession.getOrCreate(threadId, {
        memoryLimitBytes,
        maxStackSizeBytes,
        backend: resolvedBackend,
        tools: ptcTools,
        subagentGraphs,
        subagentFactories,
        currentState,
      });

      const result = await session.eval(input.code, executionTimeoutMs);
      await session.flushWrites(resolvedBackend);

      return formatReplResult(result);
    },
    {
      name: "js_eval",
      description: dedent`
        Evaluate TypeScript/JavaScript code in a sandboxed REPL. State persists across calls.
        Use readFile(path) and writeFile(path, content) for file access.
        Use swarm(input) to fan out tasks to subagents in parallel.
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

  const middleware = createMiddleware({
    name: "QuickJSMiddleware",
    tools: [jsEvalTool],
    wrapModelCall: async (request, handler) => {
      const agentTools = (request.tools || []) as StructuredToolInterface[];

      ptcTools = usePtc ? filterToolsForPtc(agentTools) : [];
      if (ptcTools.length > 0 && !cachedPtcPrompt) {
        cachedPtcPrompt = await generatePtcPrompt(ptcTools);
      }

      const hasSwarm = !!subagentGraphs;
      const replPrompt = customSystemPrompt || buildReplSystemPrompt(hasSwarm);
      const swarmPrompt = hasSwarm ? SWARM_FANOUT_PROMPT : "";
      const systemMessage = request.systemMessage
        .concat(replPrompt)
        .concat(swarmPrompt)
        .concat(cachedPtcPrompt || "");

      return handler({ ...request, systemMessage });
    },
  });

  setSubagentGraphInjector(middleware, (graphs, factories) => {
    subagentGraphs = graphs;
    subagentFactories = factories;
  });

  return middleware;
}
