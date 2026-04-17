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
  const largeFileDirective = hasSwarm
    ? `**Large file processing**: Before doing anything else, check the size of your input files. If any input file exceeds ~50KB, you must decompose the work — use \`js_eval\` with \`swarm()\` to split the data and dispatch parallel tasks. Do not attempt to process large files inline. See "Parallel fan-out" below.`
    : `**Large file processing**: Before doing anything else, check the size of your input files. If any input file exceeds ~50KB, you must decompose the work — use \`js_eval\` to explore the data, split it into chunks, and dispatch parallel tasks. Do not attempt to process large files inline.`;

  return dedent`
  ## TypeScript/JavaScript REPL (\`js_eval\`)

  You have access to a sandboxed TypeScript/JavaScript REPL running in an isolated interpreter.
  TypeScript syntax (type annotations, interfaces, generics, \`as\` casts) is supported and stripped at evaluation time.
  Variables, functions, and closures persist across calls within the same session.

  ${largeFileDirective}

  ### Hard rules

  - **No network, no filesystem** — only the helpers below. Do not attempt \`fetch\`, \`require\`, or \`import\`.
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

  Use \`js_eval\` with \`swarm()\` to fan out many independent tasks across multiple subagents and aggregate their results.

  ### When to use swarm

  **Trigger condition**: Before doing anything else, check the size of your input files. If any input file exceeds ~50KB, **you must use swarm** — do not attempt to process it inline. Reading a large file directly and summarizing it yourself is always wrong when swarm is available. Default to swarm; only skip it when the input is demonstrably small.

  Also use swarm when:
  - A task requires applying intelligence to each item in a large collection
  - Work can be decomposed into many independent, parallel subtasks

  ### How to use swarm

  Before calling swarm, understand what you're working with. Explore the data to learn its structure, format, and content using whatever tools are available. The goal is to write task descriptions detailed enough that each subagent can execute without needing to figure anything out on its own.

  Once you understand the data, use \`js_eval\` to read the input, split it into chunks, call \`swarm()\` to dispatch tasks in parallel, then read \`results.jsonl\` to aggregate:

  \`\`\`typescript
  const raw = await readFile("/data.txt");
  const lines = raw.split("\\n").filter(Boolean);
  const chunkSize = 50;

  const tasks = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, i + chunkSize).join("\\n");
    tasks.push({
      id: \`chunk_\${i}\`,
      description: \`Process each line.\\n\\nData:\\n\${chunk}\\n\\nRespond with ONLY a raw JSON object — no markdown fences, no explanation, no other text.\\nOutput schema: { "label": count }\`
    });
  }

  const summary = JSON.parse(await swarm({ tasks }));
  console.log("Completed:", summary.completed, "Failed:", summary.failed);

  // Read per-task results from resultsDir
  const resultsRaw = await readFile(summary.resultsDir + "/results.jsonl");
  const results = resultsRaw.trim().split("\\n").map(line => JSON.parse(line));

  // Robust parsing helper — strips markdown fences if present
  function parseResult(raw) {
    const cleaned = raw.replace(/^\\\`\\\`\\\`(?:json)?\\n?/m, "").replace(/\\n?\\\`\\\`\\\`$/m, "").trim();
    return JSON.parse(cleaned);
  }

  // Aggregate results in-script (skip failures, don't retry)
  const merged = {};
  for (const r of results) {
    if (r.status === "completed") {
      try {
        Object.assign(merged, parseResult(r.result));
      } catch (e) { /* skip unparseable results */ }
    }
  }
  console.log(JSON.stringify(merged));
  \`\`\`

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
  //   failedTasks: Array<{ id: string; error: string }>;
  // }
  //
  // Each line in results.jsonl:
  // { id: string; subagentType: string; status: "completed" | "failed"; result?: string; error?: string }
  \`\`\`

  ### Task description quality

  Each subagent receives **only its task description** — no other context. The quality of your descriptions determines the quality of results. Invest time upfront to get them right.

  Good task descriptions are **prescriptive**: they tell the subagent the data format, the processing logic, the exact range of data to work on, and the expected output format. The subagent should not need to explore or interpret — just execute.

  When subagent results need to be aggregated, **every task description must end with**:

  \`\`\`
  Respond with ONLY a raw JSON object — no markdown fences, no explanation, no other text.
  Output schema: { ... }
  \`\`\`

  This prevents subagents from wrapping results in \\\`\\\`\\\`json\\\`\\\`\\\` fences or adding commentary, which breaks mechanical aggregation.

  ### Aggregation

  There are two ways to aggregate results:

  1. **In-script aggregation**: Read \`resultsDir + "/results.jsonl"\` in the same \`js_eval\` call, parse each line, and combine them programmatically. Best for mechanical aggregation (counting, merging, deduplication).

  2. **LLM-based aggregation**: After \`js_eval\` completes, use \`read_file\` to read \`<resultsDir>/results.jsonl\` and synthesize the outputs using your own judgment. Best for summarization or qualitative analysis.

  ### Error handling

  If some tasks fail, use discretion:
  - **Many failures** (e.g., 30/50): call \`swarm()\` again targeting just the failures.
  - **Few failures** (e.g., 3/50): handle them individually outside the REPL — swarm is overkill for a handful of tasks.

  **Completed results are authoritative.** Never verify, cross-check, re-classify, or re-dispatch completed tasks. Do not compare result counts against expected counts. Aggregate what you have and move on.

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

  setSubagentGraphInjector(middleware, (graphs) => {
    subagentGraphs = graphs;
  });

  return middleware;
}
