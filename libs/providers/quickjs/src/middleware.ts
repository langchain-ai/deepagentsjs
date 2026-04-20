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
    ? `- **Check inputs before processing** — for any file, use \`ls\` or \`read_file\` with offset/limit to understand its size and shape. If the work involves many independent items, multiple entities, or data that exceeds a single context, use \`swarm()\` — see "Parallel fan-out" below.`
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

  Use \`swarm()\` inside \`js_eval\` to dispatch many independent subagent calls in parallel and aggregate the results. Each subagent runs in an isolated context — it sees only the description you write for it.

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

  ### Flow

  1. **Explore.** Sample — don't read in full. Use \`read_file\` with offset/limit, \`grep\`, or \`ls\` to learn the input's shape. Finish in 2–3 tool calls.
  2. **Dispatch.** In \`js_eval\`, chunk the data, build task descriptions, and call \`swarm()\`.
  3. **Aggregate.** In the same or a follow-up \`js_eval\`, combine results programmatically. For qualitative output (summaries, research, narrative), read \`resultsDir + "/results.jsonl"\` with \`read_file\` and work from there — don't pull every result string back into the orchestrator's context.

  ### Hard rules

  - **Never read the full input that triggers swarm.** If the data is too large for one context, it reaches subagents via chunked descriptions, not through you.
  - **Results are final.** Do not dispatch recheck, verify, or cross-check tasks for completed results. Re-dispatching the same data with different ids is still rechecking.
  - **One retry for failures, then move on.** Fix the root cause (schema, description) and re-dispatch only the failed ids. Don't retry twice.

  ### Dispatch example

  \`\`\`typescript
  const raw = await readFile("/data.txt");
  const lines = raw.split("\\n").filter(Boolean);
  const chunkSize = 50;

  const tasks = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, i + chunkSize).join("\\n");
    tasks.push({
      id: \`chunk_\${i}\`,
      description: \`[Complete, self-contained instructions derived from exploration]

Data:
\${chunk}\`,
    });
  }

  const summary = JSON.parse(await swarm({
    tasks,
    concurrency: Math.min(25, tasks.length),
  }));
  console.log("Completed:", summary.completed, "Failed:", summary.failed);
  \`\`\`

  ### Writing task descriptions

  Each subagent sees only its description. A good description lets the subagent work mechanically, with no judgment required. Include:

  - What the input is and how it's structured (delimiters, format, encoding)
  - What the subagent should produce (format, fields, allowed values)
  - The rules — including edge cases and examples you found during exploration
  - The actual data for this task

  Anything you discovered during exploration must be written into every description that needs it. Subagents cannot see your notes.

  ### Structured output (\`responseSchema\`)

  Use \`responseSchema\` when results will be aggregated programmatically. It enforces the schema at the model API level — stricter than asking for JSON in prose.

  \`\`\`typescript
  {
    id: "t1",
    description: "...",
    responseSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id:    { type: "string" },
              label: { type: "string", enum: ["a", "b", "c"] }
            },
            required: ["id", "label"]
          }
        }
      },
      required: ["results"]
    }
  }
  \`\`\`

  Schema tips:
  - \`enum\` on categorical fields prevents label drift across subagents.
  - \`description\` on properties — models read them during generation.
  - \`minItems\` / \`maxItems\` on arrays — ensures the expected count.
  - Top-level \`type\` must be \`"object"\`. Wrap arrays under a \`results\` field.

  Skip \`responseSchema\` for qualitative output (summaries, research findings, code reviews) — free-form text aggregates better when read from \`results.jsonl\`.

  ### Chunk sizing and concurrency

  Aim for 10–25 tasks per swarm call. Fewer, and parallelism doesn't pay for overhead. More, and a bad description or schema affects many tasks at once.

  Per-task sizing depends on item size:
  - Short items (labels, one-line entries): 30–60 per task
  - Medium items (reviews, paragraphs): 10–20 per task
  - Long items (documents, articles): 1–5 per task, or one-per-task

  For runs with >10 tasks, set \`concurrency\` explicitly. Good rule: \`Math.min(25, tasks.length)\`.

  ### Decomposition patterns

  - **One-per-item** — one task per discrete unit (file, document, entity). Use when items are naturally discrete and each needs its own analysis.
  - **Flat fan-out** — split a collection into equal chunks; all tasks have the same shape. Use when applying the same operation to many items.
  - **Dimensional** — multiple tasks examine the same input from different angles. Use for multi-criteria evaluation (code review, red-team analysis).

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
