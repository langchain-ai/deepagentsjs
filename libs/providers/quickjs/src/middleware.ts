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
    ? `- **Check inputs before processing** — for any file, use \`ls\` or \`read_file\` with offset/limit to understand its size and shape. If the work involves many independent items, multiple entities, or data that exceeds a single context, use \`swarm.create\`/\`swarm.execute\` — see "Parallel fan-out" below.`
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
  ## Parallel fan-out (\`swarm.create\` + \`swarm.execute\`)

  Dispatch independent subagent calls in parallel against a JSONL table. Each subagent runs in isolation — it sees only the instruction you write for it.

  ### When to use

  Use swarm when work can be decomposed into **independent units** that don't depend on each other's output:
  - **10+ items** needing the same operation (classify, extract, summarize, transform)
  - **Multiple files/entities** each needing separate analysis
  - Input too large for a single context — split into rows, process in parallel

  Don't use swarm for fewer than ~5 items (use inline tool calls), sequential pipelines where step N depends on step N-1, or a single end-to-end analysis with no natural decomposition.

  ### Rules

  - **Never read the full input that triggers swarm.** Sample with \`read_file\` (offset/limit), \`grep\`, or \`ls\` — 2–3 tool calls max. Data reaches subagents via instruction templates, not through you.
  - **Keep total subagent calls under 100.** Use \`batchSize\` for high-volume work (see Scale below).
  - **Results are final.** Do not dispatch recheck, verify, or cross-check tasks.
  - **One retry for failures, then move on.** Fix the root cause (instruction, schema) and re-dispatch only failed rows via \`filter\`. Don't retry twice.

  ### Decomposing work

  Each table row is one unit of work. Choose the right granularity:

  | Input shape | Row granularity | Example |
  |---|---|---|
  | Collection of files | One row per file | \`{ glob: "src/**/*.ts" }\` |
  | Large file with records | One row per record | Parse file → \`tasks: records.map(...)\` |
  | Large document | One row per section/chunk | Split by heading or fixed size |
  | List of entities | One row per entity | \`tasks: entities.map(...)\` |

  Keep each row's data self-contained — the subagent sees only what's in the instruction after interpolation.

  ### Flow

  1. **Explore** — sample the input to understand its shape and size.
  2. **Create table** — call \`swarm.create\` to materialize rows from a glob, file paths, or inline tasks.
  3. **Execute** — call \`swarm.execute\` with an instruction template. Results are written as a column on each row.
  4. **Aggregate** — read the table in \`js_eval\` and combine results programmatically.

  ### API

  #### \`swarm.create(file, source)\`

  Materializes a JSONL table. Overwrites if the file exists.

  \`\`\`typescript
  await swarm.create("/table.jsonl", { glob: "src/**/*.ts" });
  await swarm.create("/table.jsonl", { filePaths: ["/a.ts", "/b.ts"] });
  await swarm.create("/table.jsonl", {
    tasks: items.map((item, i) => ({ id: \`row-\${i}\`, text: item.text }))
  });
  \`\`\`

  Glob/filePaths sources produce rows with \`{ id, file }\`. Inline tasks can have any shape but each must have \`id: string\`.

  #### \`swarm.execute(file, options)\`

  Dispatches subagents against the table. Returns a JSON-stringified summary.

  \`\`\`typescript
  const summary = JSON.parse(await swarm.execute("/table.jsonl", {
    instruction: "Review {file} for security issues.",
    column: "review",
  }));
  console.log(\`\${summary.completed} completed, \${summary.failed} failed\`);
  \`\`\`

  **Full options:**

  \`\`\`typescript
  await swarm.execute(file, {
    instruction: string,       // template with {column} placeholders (required)
    column?: string,           // column to write results into (default: "result")
    filter?: SwarmFilter,      // only dispatch matching rows
    subagentType?: string,     // subagent type (default: "general-purpose")
    responseSchema?: object,   // JSON Schema for structured output
    concurrency?: number,      // max parallel dispatches (default: ${DEFAULT_CONCURRENCY})
    batchSize?: number,        // rows per subagent call (default: 1)
  })
  \`\`\`

  ### Instruction templates

  Use \`{column}\` placeholders — they are interpolated per-row from the table. Dotted paths like \`{meta.author}\` traverse nested objects.

  \`\`\`typescript
  // Row: { id: "utils.ts", file: "src/utils.ts" }
  // "Analyze {file}" → "Analyze src/utils.ts"
  await swarm.execute("/table.jsonl", {
    instruction: "Analyze {file} for code complexity.",
    column: "complexity",
  });
  \`\`\`

  ### Structured output

  Use \`responseSchema\` when results will be aggregated programmatically. The schema must have \`type: "object"\` at the top level. Use \`enum\` to constrain string values and prevent label drift.

  \`\`\`typescript
  await swarm.execute("/table.jsonl", {
    instruction: "Classify the sentiment of this review: {text}",
    column: "sentiment",
    responseSchema: {
      type: "object",
      properties: {
        label: { type: "string", enum: ["positive", "negative", "neutral"] },
        confidence: { type: "number" },
      },
      required: ["label"],
    },
  });
  \`\`\`

  ### Filtering

  Use \`filter\` to dispatch only matching rows. Unmatched rows pass through unchanged.

  \`\`\`typescript
  // Only rows missing a result
  filter: { column: "review", exists: false }

  // Retry failed rows
  filter: { column: "review", equals: null }

  // Combine conditions
  filter: { and: [
    { column: "status", equals: "pending" },
    { column: "priority", in: ["high", "critical"] },
  ]}
  \`\`\`

  Operators: \`equals\`, \`notEquals\`, \`in\`, \`exists\` (boolean), \`and\`, \`or\`.

  ### Multi-pass enrichment

  Run multiple \`swarm.execute\` calls against the same table, each writing a different column. Later passes can reference columns from earlier passes.

  \`\`\`typescript
  await swarm.create("/docs.jsonl", { glob: "docs/**/*.md" });
  await swarm.execute("/docs.jsonl", {
    instruction: "Summarize this document.\\nFile: {file}",
    column: "summary",
  });
  await swarm.execute("/docs.jsonl", {
    instruction: "Classify this document.\\nSummary: {summary}",
    column: "category",
    responseSchema: {
      type: "object",
      properties: { category: { type: "string", enum: ["guide", "reference", "tutorial"] } },
      required: ["category"],
    },
  });
  \`\`\`

  ### Scale and batching

  | Row count | Strategy |
  |---|---|
  | < 10 | No swarm needed — use inline tool calls |
  | 10–100 | \`batchSize: 1\` (default) — one subagent per row |
  | 100–2,000 | Use \`batchSize\` (20–50) to keep subagent calls under 100 |
  | 2,000+ | Use \`batchSize: 40–50\` with \`responseSchema\` for structured results |

  \`batchSize\` groups N rows into a single subagent call. The table stays one-row-per-item — the executor batches instructions and unpacks results automatically. Use it for high-volume small items (classification, labeling, extraction). Omit it when each row needs a full subagent context (file analysis, long-form generation).

  \`\`\`typescript
  // 1,000 items → 25 subagent calls instead of 1,000
  await swarm.execute("/items.jsonl", {
    instruction: "Classify: {text}",
    column: "label",
    batchSize: 40,
    responseSchema: {
      type: "object",
      properties: { label: { type: "string", enum: ["A", "B", "C"] } },
      required: ["label"],
    },
  });
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
        Use swarm.create(file, source) and swarm.execute(file, options) for parallel fan-out.
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
