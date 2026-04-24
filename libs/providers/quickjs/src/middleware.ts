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
    ? `- **Check inputs before processing** — for any file, use \`ls\` or \`read_file\` with offset/limit to understand its size and shape. If the work involves many independent items, multiple entities, or data
      that exceeds a single context, use \`swarm.create\` + \`swarm.execute\` — see "Parallel fan-out" below.`
    : `- **Check file size before processing** — before working with any input file, check its size. If it exceeds ~50,000 characters, decompose the work into chunks and process them separately.`;

  return dedent`
  ## TypeScript/JavaScript REPL (\`js_eval\`)

  You have access to a sandboxed TypeScript/JavaScript REPL running in an isolated interpreter.
  TypeScript syntax (type annotations, interfaces, generics, \`as\` casts) is supported and stripped at evaluation time.
  Variables, functions, and closures persist across calls within the same session.

  ### Hard rules

  ${largeFileRule}
  - **No network, no imports** — do not attempt \`fetch\`, \`require\`, or \`import\` inside \`js_eval\`. Use your file tools (\`read_file\`, \`grep\`, \`ls\`, etc.) for exploration and \`readFile\`/\`writeFile\`
    for direct REPL file I/O.
  - **Cite your sources** — when reporting values from files, include the path and key/index so the user can verify.
  - **Use console.log()** for output — it is captured and returned. \`console.warn()\` and \`console.error()\` are also available.
  - **Reuse state from previous cells** — variables, functions, and results from earlier \`js_eval\` calls persist across calls. Reference them by name in follow-up cells instead of re-embedding data as inline
    JSON literals.

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
  ## Parallel fan-out (\`swarm.create\` + \`swarm.execute\`)

  Process many independent items in parallel. \`swarm.create\` builds an in-memory table handle;
  \`swarm.execute\` fans work out across rows and returns an enriched table. One row = one unit of work.

  ### When to use

  Use swarm when: many items need the same operation, input is too large for one context, or items
  each need independent analysis. Don't use when items depend on each other's output.

  ### Flow

  1. **Explore.** Sample the input using any tool — \`read_file\` with offset/limit, \`grep\`, \`ls\`, or \`js_eval\`.
     Learn shape, conventions, edge cases. This informs the \`context\` and \`instruction\` you write.
  2. **Create.** \`swarm.create\` builds a table from a source spec. Returns a table handle.
  3. **Execute.** \`swarm.execute\` with an \`instruction\` template and optional \`context\`. Returns the updated table.
  4. **Aggregate.** Inspect \`table.rows\` or chain another \`swarm.execute\` pass.

  ### Choosing a swarm.create source

  **\`glob\` / \`filePaths\`** — one file = one row. Use when each file is an independent unit of work
  (e.g. code review across a repo, summarising a folder of documents). Each row gets \`{ id, file }\`;
  the subagent reads the file itself via the \`{file}\` placeholder.

  **\`tasks\`** — pass pre-built records directly. Use when the data to process lives inside a file
  (e.g. a JSONL dataset, a CSV, a JSON array). Read and parse the file first, then pass the records:

  \`\`\`typescript
  const lines = readFile("/data.jsonl").trim().split("\\n");
  const rows = lines.map(l => JSON.parse(l));
  let table = await swarm.create({ tasks: rows });
  \`\`\`

  Passing \`filePaths: ["/data.jsonl"]\` would produce a table with **one row** pointing at the file —
  not one row per record inside it.

  ### Rules

  - **Get it right in one pass.** Explore thoroughly before dispatching. A wasted swarm pass is expensive.
  - **Never read the full input.** Sample only. Data reaches subagents via the table.
  - **Everything the subagent needs must be in \`instruction\` + \`context\`.** Subagents can't see your notes.
  - **Results are final.** Don't dispatch recheck/verify tasks. Fix the instruction and re-dispatch failed rows via \`filter\`.
  - **One retry for failures, then move on.**

  ### Instruction + context

  \`instruction\` is a per-item template with \`{column}\` placeholders (interpolated from each row).

  \`context\` is free-form prose prepended to every subagent prompt. Put dataset-wide information here:
  what the data is, domain terms, classification rules, edge cases, examples.

  \`\`\`typescript
  let table = await swarm.create({ glob: "src/**/*.ts" });
  table = await swarm.execute(table, {
    instruction: "Review {file} for security issues. List findings or write 'no issues'.",
    context: "This is a TypeScript backend using Express. Focus on injection, auth bypass, path traversal.",
    column: "review",
  });
  console.log(table.rows);
  \`\`\`

  ### Structured output

  Use \`responseSchema\` for programmatic aggregation. Schema properties become top-level columns on each row.

  \`\`\`typescript
  table = await swarm.execute(table, {
    instruction: "Classify: {text}",
    responseSchema: {
      type: "object",
      properties: {
        label: { type: "string", enum: ["positive", "negative", "neutral"] },
      },
      required: ["label"],
    },
  });
  // Row after: { id: "r1", text: "...", label: "positive" }
  \`\`\`

  ### Batching

  Set \`batchSize\` with \`responseSchema\` to group N rows per subagent call.

  \`\`\`typescript
  table = await swarm.execute(table, {
    instruction: "Classify: {text}",
    batchSize: 50,
    responseSchema: {
      type: "object",
      properties: { label: { type: "string", enum: ["positive", "negative", "neutral"] } },
      required: ["label"],
    },
  });
  \`\`\`

  Sizing: short items 40–80, medium items 20–40, complex items leave at 1.

  ### Chaining passes

  \`swarm.execute\` returns the updated table — reassign to accumulate columns across passes.

  \`\`\`typescript
  let table = await swarm.create({ tasks: interviews });
  table = await swarm.execute(table, { instruction: "Classify sentiment of {file}", column: "sentiment" });
  table = await swarm.execute(table, {
    filter: { column: "sentiment", equals: "negative" },
    instruction: "Summarize why {file} had negative sentiment.",
    column: "summary",
  });
  \`\`\`

  ### Filtering

  \`filter: { column: "result", exists: false }\` — re-dispatch unprocessed rows.
  Operators: \`equals\`, \`notEquals\`, \`in\`, \`exists\`, \`and\`, \`or\`.

  ### API Reference

  \`\`\`typescript
  const swarm: {
    /**
     * Build an in-memory table from a source spec. Returns a table handle { rows: Row[] }.
     * No file is written.
     */
    create(source: {
      glob?: string | string[];       // one row per matched file: { id, file }
      filePaths?: string[];           // one row per path: { id, file }
      tasks?: Array<Record<string, unknown>>;  // pre-built rows; each must have id: string
    }): Promise<{ rows: Row[] }>;

    /**
     * Fan work out across table rows. Returns a new table handle with results
     * merged in as new columns. Reassign to accumulate columns across passes:
     *   table = await swarm.execute(table, options)
     */
    execute(table: { rows: Row[] }, options: {
      instruction: string;       // template with {column} placeholders
      context?: string;          // prose prepended to every subagent prompt
      column?: string;           // result column name (default: "result")
      filter?: SwarmFilter;      // only dispatch matching rows
      subagentType?: string;     // default: "general-purpose"
      responseSchema?: object;   // JSON Schema (type: "object"); properties become columns
      concurrency?: number;      // default: ${DEFAULT_CONCURRENCY}
      batchSize?: number;        // rows per subagent call; requires responseSchema
    }): Promise<{ rows: Row[] }>;
  };
  \`\`\`
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

  const usePtc = ptc !== false;

  let cachedPtcPrompt: string | null = null;
  let ptcTools: StructuredToolInterface[] = [];
  let subagentGraphs: ReplSessionOptions["subagentGraphs"];
  let subagentFactories: ReplSessionOptions["subagentFactories"];
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
        Use swarm.create(source) and swarm.execute(table, options) for parallel fan-out.
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
