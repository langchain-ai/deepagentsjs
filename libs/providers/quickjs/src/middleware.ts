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

  Use \`swarm\` inside \`js_eval\` to process many independent units of work in parallel against a JSONL table. Each row in the table is one unit of work; results are written back as new columns on the same row. Each subagent runs in an isolated context — it sees only the per-row interpolated instruction.

  ### When to use swarm

  You MUST use swarm when any of these apply:
  - A collection of files, documents, or entities each needs its own analysis
  - A dataset has many items needing the same operation (classification, extraction, transformation, summarization)
  - The input is too large for a single context — split into rows and dispatch in parallel
  - The same input benefits from multiple independent perspectives (multi-criteria review, dimensional analysis)

  Do NOT use swarm when:
  - Items depend on each other's output — use sequential calls
  - The work is one end-to-end analysis with no natural decomposition
  - A single tool call already does the job

  ### Flow

  1. **Explore.** Sample the input — don't read it in full. Use \`ls\`, \`read_file\` with offset/limit, or \`grep\`. Finish in 2–3 tool calls.
  2. **Create the table.** Call \`swarm.create\` to materialize one row per unit of work — from a glob, explicit file paths, or inline records.
  3. **Execute.** Call \`swarm.execute\` with an instruction template that references row columns. Results land as new columns on each row.
  4. **Aggregate.** \`swarm.execute\` returns a summary with inline per-row results — aggregate directly from \`summary.results\` in the same \`js_eval\` block. For large tables where you only need a subset, read the table back with \`readFile\` instead.

  ### Hard rules

  - **Never read the full input that triggers swarm.** Sample only. Data reaches subagents through the table, not through you.
  - **Anything you learned during exploration must be written into the instruction template.** Subagents cannot see your notes — only their interpolated instruction.
  - **Results are final.** Do not dispatch recheck, verify, or cross-check tasks for completed rows. If results look wrong, fix the instruction or schema and re-dispatch the affected rows via \`filter\`.
  - **One retry for failures, then move on.** Re-dispatch only failed rows with \`filter: { column: "<your column>", exists: false }\`. Don't retry twice.

  ### Dispatch example

  \`\`\`typescript
  // One row per file
  await swarm.create("/reviews.jsonl", { glob: "src/**/*.ts" });

  // Each row gets its own subagent; {file} is interpolated from the row
  const summary = JSON.parse(await swarm.execute("/reviews.jsonl", {
    instruction: "Review {file} for security issues. List findings or write 'no issues'.",
    column: "review",
  }));
  console.log("Completed:", summary.completed, "Failed:", summary.failed);

  // Aggregate directly from the summary
  const flagged = summary.results.filter(r => r.status === "completed" && r.result && !r.result.includes("no issues"));
  \`\`\`

  ### Writing instruction templates

  Templates use \`{column}\` placeholders interpolated from each row. Dotted paths like \`{meta.author}\` traverse nested objects. String values are inserted bare; objects/arrays are JSON-serialized.

  A good template lets the subagent work mechanically, with no judgment required. Include:
  - What the input is and how it's structured (delimiters, format, conventions)
  - What to produce (format, fields, allowed values, edge-case handling)
  - The rules — including anything you discovered during exploration
  - The placeholders that carry the actual data for this row

  \`\`\`typescript
  await swarm.execute("/items.jsonl", {
    instruction: \`Extract named entities from the text below.
  Return a list of {name, type} where type is one of: person, place, organization.
  Skip pronouns and generic references. Skip duplicates.

  Text:
  {text}\`,
    column: "entities",
  });
  \`\`\`

  ### Structured output

  Use \`responseSchema\` when results will be aggregated programmatically. The schema is enforced at the model API level — stricter than asking for JSON in prose.

  Each property in the schema becomes a top-level column on the row. A schema with \`{label, confidence}\` produces rows like \`{id: "r1", text: "...", label: "positive", confidence: 0.95}\`. Read the columns directly — no unwrapping needed.

  \`\`\`typescript
  await swarm.execute("/items.jsonl", {
    instruction: "Classify the sentiment: {text}",
    responseSchema: {
      type: "object",
      properties: {
        label:      { type: "string", enum: ["positive", "negative", "neutral"] },
        confidence: { type: "number" },
      },
      required: ["label"],
    },
  });
  \`\`\`

  Schema tips:
  - \`enum\` on categorical fields prevents drift across subagents.
  - \`description\` on properties — models read them during generation.
  - Top-level \`type\` must be \`"object"\`. Wrap arrays under a named field if needed.
  - Skip \`responseSchema\` for qualitative output (summaries, code reviews, narrative analysis) — free-form text aggregates better when read from the table.

  ### Multi-pass enrichment

  Run multiple \`swarm.execute\` calls against the same table, each writing a different column. Later passes can reference earlier columns through the template.

  \`\`\`typescript
  await swarm.create("/docs.jsonl", { glob: "docs/**/*.md" });

  // Pass 1: summarize
  await swarm.execute("/docs.jsonl", {
    instruction: "Summarize the document at {file}.",
    column: "summary",
  });

  // Pass 2: classify using the summary from pass 1
  await swarm.execute("/docs.jsonl", {
    instruction: "Classify this document based on its summary: {summary}",
    responseSchema: {
      type: "object",
      properties: { category: { type: "string", enum: ["guide", "reference", "tutorial"] } },
      required: ["category"],
    },
  });
  \`\`\`

  ### Filtering

  Use \`filter\` to dispatch only matching rows. Unmatched rows pass through unchanged.

  \`\`\`typescript
  // Re-dispatch only rows that haven't been processed yet
  filter: { column: "summary", exists: false }

  // Combine conditions
  filter: { and: [
    { column: "status", equals: "pending" },
    { column: "priority", in: ["high", "critical"] },
  ]}
  \`\`\`

  Operators: \`equals\`, \`notEquals\`, \`in\`, \`exists\` (boolean), \`and\`, \`or\`.

  ### Batching for high-volume same-shape work

  For classification, labeling, or extraction across many rows of similar shape, set \`batchSize\` together with \`responseSchema\`. The executor groups N rows into a single subagent call and unpacks results back to individual rows by id.

  \`\`\`typescript
  await swarm.execute("/items.jsonl", {
    instruction: "Classify: {text}",
    batchSize: 20,
    responseSchema: {
      type: "object",
      properties: { label: { type: "string", enum: ["A", "B", "C"] } },
      required: ["label"],
    },
  });
  \`\`\`

  Choose \`batchSize\` based on item complexity:
  - Short items (one-line text, labels): 20–50 per batch
  - Medium items (paragraphs, reviews): 10–20 per batch
  - Complex items (multi-step reasoning, tool use): leave as default (\`batchSize: 1\`)

  If accuracy drops with batching, lower \`batchSize\`. Single-row dispatch is the right choice for any task that needs full subagent reasoning, tool use, or per-item judgment.

  ### Decomposition patterns

  - **One row per item** — files, documents, entities. Use when each unit is naturally discrete and needs its own analysis.
  - **Chunked rows** — split a large input into equal pieces, one row per chunk. Use when the input is too large for one context and items are interchangeable.
  - **Dimensional** — same input, multiple rows examining different angles (different criteria, different reviewers). Use for multi-criteria evaluation.

  ### Concurrency

  Default is \`${DEFAULT_CONCURRENCY}\`. Raise it for I/O-bound work over many rows; lower it if you're hitting rate limits. Concurrency bounds parallel subagent calls (or batches, when batching).

  ### API Reference

  \`\`\`typescript
  const swarm: {
    /**
     * Materialize a JSONL table at \`file\`. Overwrites if it exists.
     */
    create(file: string, source: {
      glob?: string | string[];                 // glob pattern(s) → one row per file with { id, file }
      filePaths?: string[];                     // explicit paths   → one row per file with { id, file }
      tasks?: Array<Record<string, unknown>>;   // pre-built rows; each must have id: string
    }): Promise<void>;

    /**
     * Dispatch subagents against the table. Returns a JSON-stringified summary.
     */
    execute(file: string, options: {
      instruction: string;       // template with {column} placeholders (required)
      column?: string;           // column to write results into (default: "result")
      filter?: SwarmFilter;      // only dispatch matching rows
      subagentType?: string;     // subagent type (default: "general-purpose")
      responseSchema?: object;   // JSON Schema for structured output (must have type: "object")
      concurrency?: number;      // max parallel dispatches (default: ${DEFAULT_CONCURRENCY})
      batchSize?: number;        // rows per subagent call; requires responseSchema (default: 1)
    }): Promise<string>;         // JSON string of SwarmSummary
  };

  // Parsed summary shape:
  // {
  //   total: number;        // rows dispatched after filtering
  //   completed: number;
  //   failed: number;
  //   skipped: number;      // rows excluded by filter
  //   file: string;
  //   column: string;
  //   results: Array<{ id, subagentType, status, result?, error? }>;
  //   failedTasks: Array<{ id, error }>;
  // }
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
