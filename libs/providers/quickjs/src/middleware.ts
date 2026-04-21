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
  ## Parallel fan-out (\`swarm.create\` + \`swarm.execute\` in js_eval)

  Use \`swarm.create\` and \`swarm.execute\` inside \`js_eval\` to dispatch many independent subagent calls in parallel against a JSONL table. Each subagent runs in an isolated context — it sees only the interpolated instruction you write for it.

  ### When to use swarm

  Reach for swarm when any of these apply:
  - A dataset has many items needing the same operation (classification, extraction, transformation)
  - A collection of entities each needs its own analysis (per-document, per-PR, per-entity)
  - The same input benefits from multiple independent perspectives
  - The work exceeds what a single subagent's context can hold

  Don't use swarm when:
  - Fewer than ~5 independent units — use inline tool calls or the \`task\` tool
  - Tasks depend on each other's output
  - One end-to-end analysis with no natural decomposition

  ### Batching

  Subagents have large context windows — use them. When individual items are small (short texts, single lines, brief records), **batch 20–50 items per row** rather than one row per item. Each row's instruction template can embed a block of items; the subagent processes the whole batch and returns aggregated or per-item results. One row per item is almost never right for small items.

  ### Flow

  1. **Explore.** Sample — don't read in full. Use \`read_file\` with offset/limit, \`grep\`, or \`ls\` to learn the input's shape. Finish in 2–3 tool calls.
  2. **Create a table.** In \`js_eval\`, call \`swarm.create\` to materialize the table JSONL from a glob, file paths, or inline task rows.
  3. **Execute against the table.** Call \`swarm.execute\` with an instruction template. Results stream back as a new column on each row.
  4. **Aggregate.** In the same or a follow-up \`js_eval\`, read the table via \`readFile\` and combine results programmatically. For qualitative output (summaries, research, narrative), work from the table — don't pull every result string back into the orchestrator's context.

  ### Hard rules

  - **Never read the full input that triggers swarm.** If the data is too large for one context, it reaches subagents via interpolated instruction templates, not through you.
  - **Results are final.** Do not dispatch recheck, verify, or cross-check tasks for completed results. Re-dispatching the same data with different ids is still rechecking.
  - **One retry for failures, then move on.** Fix the root cause (instruction, schema) and re-dispatch only the failed rows using a filter. Don't retry twice.

  ### Two-function API

  #### \`swarm.create(file, source)\`

  Materializes a JSONL table. If the file already exists, it is overwritten.

  \`\`\`typescript
  // From a glob pattern
  await swarm.create("/analysis.jsonl", { glob: "src/**/*.ts" });

  // From explicit file paths
  await swarm.create("/analysis.jsonl", { filePaths: ["a.ts", "b.ts"] });

  // From inline task rows (each must have id: string)
  await swarm.create("/analysis.jsonl", {
    tasks: lines.map((line, i) => ({ id: \`row-\${i}\`, text: line, source: "input.txt" }))
  });
  \`\`\`

  Glob and filePaths sources produce rows with \`{ id, file }\`. Inline tasks can have any shape.

  #### \`swarm.execute(file, options)\`

  Dispatches subagents against an existing table. Returns a JSON string — use \`JSON.parse()\` on the result.

  \`\`\`typescript
  const summary = JSON.parse(await swarm.execute("/analysis.jsonl", {
    instruction: "Review this file for security issues.\\n\\nFile: {file}",
    column: "review",              // column name for results (default: "result")
    subagentType: "general-purpose",
    concurrency: 25,
  }));
  console.log("Completed:", summary.completed, "Failed:", summary.failed);
  \`\`\`

  ### Instruction templates

  Use \`{column}\` placeholders in the instruction — they are interpolated per-row from the table data. Dotted paths like \`{metadata.author}\` traverse nested objects.

  \`\`\`typescript
  // Row: { id: "utils.ts", file: "src/utils.ts" }
  // Instruction: "Analyze {file} for complexity" → "Analyze src/utils.ts for complexity"

  await swarm.execute("/analysis.jsonl", {
    instruction: "Analyze {file} for code complexity. Focus on cyclomatic complexity.",
    column: "complexity",
  });
  \`\`\`

  ### Filtering rows

  Use \`filter\` to dispatch only matching rows. Others pass through unchanged.

  \`\`\`typescript
  // Only rows where "review" column doesn't exist yet
  await swarm.execute("/analysis.jsonl", {
    instruction: "...",
    filter: { column: "review", exists: false },
  });

  // Retry failed rows
  await swarm.execute("/analysis.jsonl", {
    instruction: "...",
    filter: { column: "review", equals: null },
  });

  // Combine conditions
  await swarm.execute("/analysis.jsonl", {
    instruction: "...",
    filter: { and: [
      { column: "status", equals: "pending" },
      { column: "priority", in: ["high", "critical"] },
    ]},
  });
  \`\`\`

  Filter operators: \`equals\`, \`notEquals\`, \`in\`, \`exists\` (boolean), \`and\`, \`or\`.

  ### Multi-pass enrichment

  Run multiple \`swarm.execute\` calls against the same table, each writing a different column. Later passes can reference columns written by earlier passes in their instruction templates.

  \`\`\`typescript
  await swarm.create("/docs.jsonl", { glob: "docs/**/*.md" });

  // Pass 1: extract summary
  await swarm.execute("/docs.jsonl", {
    instruction: "Summarize this document in 2-3 sentences.\\n\\nFile: {file}",
    column: "summary",
  });

  // Pass 2: classify based on summary
  await swarm.execute("/docs.jsonl", {
    instruction: "Classify this document based on its summary.\\n\\nFile: {file}\\nSummary: {summary}",
    column: "category",
    responseSchema: {
      type: "object",
      properties: { category: { type: "string", enum: ["guide", "reference", "tutorial", "changelog"] } },
      required: ["category"],
    },
  });
  \`\`\`

  ### Structured output (\`responseSchema\`)

  Use \`responseSchema\` when results will be aggregated programmatically.

  \`\`\`typescript
  await swarm.execute("/analysis.jsonl", {
    instruction: "Classify the complexity of {file}.",
    column: "metrics",
    responseSchema: {
      type: "object",
      properties: {
        complexity: { type: "string", enum: ["low", "medium", "high"] },
        reason: { type: "string" },
        lineCount: { type: "number" },
      },
      required: ["complexity", "reason"],
    },
  });
  \`\`\`

  Schema tips: \`enum\` prevents label drift; top-level \`type\` must be \`"object"\`; wrap arrays under a named field.

  ### API Reference

  \`\`\`typescript
  async function swarm.create(file: string, source: {
    glob?: string | string[];
    filePaths?: string[];
    tasks?: Array<Record<string, any>>;
  }): Promise<void>

  async function swarm.execute(file: string, options: {
    instruction: string;
    column?: string;
    filter?: SwarmFilter;
    subagentType?: string;
    responseSchema?: object;
    concurrency?: number;  // default: ${DEFAULT_CONCURRENCY}
  }): Promise<string>  // JSON string of SwarmSummary
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
