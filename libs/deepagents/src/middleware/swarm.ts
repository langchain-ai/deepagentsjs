import { z } from "zod/v4";
import { readFileSync } from "node:fs";
import { Runnable } from "@langchain/core/runnables";
import {
  type AgentMiddleware,
  context,
  createMiddleware,
  type ReactAgent,
  SystemMessage,
  tool,
  type ToolRuntime,
} from "langchain";
import {
  type AnyBackendProtocol,
  type BackendFactory,
  type ReadRawResult,
  resolveBackend,
} from "../backends/protocol.js";
import type { BackendProtocolV2 } from "../backends/v2/protocol.js";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "../swarm/types.js";
import { parseTasksJsonl } from "../swarm/parse.js";
import { resolveVirtualTableTasks } from "../swarm/virtual-table.js";
import { executeSwarm } from "../swarm/executor.js";
import { getCurrentTaskInput } from "@langchain/langgraph";

/**
 * System prompt that explains the swarm workflow to the orchestrator.
 *
 * Appended to the orchestrator's system message when swarm middleware
 * is enabled.
 */
export const SWARM_SYSTEM_PROMPT = context`
  ## \`swarm\` (parallel subagent execution)

  Use \`swarm\` to fan out many independent tasks across multiple subagents and aggregate their results.

  ### When to use swarm

  **Trigger condition**: Use swarm when the input contains too much data to process in a single pass. Indicators: the file or dataset exceeds a few hundred kilobytes, or it contains hundreds of items that each need individual analysis. When in doubt, check the size and prefer swarm over attempting to process a large input inline.

  Also use \`swarm\` when:
  - A task requires applying intelligence to each item in a large collection
  - Work can be decomposed into many independent, parallel subtasks

  Use \`task\` instead when:
  - You have a small number of independent subtasks
  - Each subtask depends on the result of a previous one
  - The work is exploratory or adaptive

  ### Two ways to invoke swarm

  Swarm accepts either of two input forms. Pick the one that matches the shape of your work.

  **Virtual-table form** (\`filePaths\`/\`glob\` + \`instruction\`): swarm generates one task per file automatically. Use this when you have a set of files and the same instruction applies to each. No generation script needed — works on all backends.

  Example: \`swarm({ glob: "feedback/*.txt", instruction: "Classify as bug|feature|praise. Return JSON: {category, confidence}." })\`

  **Script form** (\`tasksPath\`): you provide a pre-generated \`tasks.jsonl\` file with one task per line. Use this when:
  - Splitting a single large file into chunks (virtual-table form can't do this — one task covers one file, not a range within a file)
  - Task descriptions vary in ways a shared instruction can't capture
  - Dimensional fan-out (same input, multiple different analyses)

  Script form requires \`execute\` (to write tasks.jsonl via a generation script).

  ### How to use swarm

  Before calling swarm, understand what you're working with. Explore the data to learn its structure, format, and content using whatever tools are available. The goal is to write task descriptions detailed enough that each subagent can execute without needing to figure anything out on its own.

  Once you understand the data:

  **Virtual-table form:**
  1. Call \`swarm({ filePaths: [...], instruction: "..." })\` or \`swarm({ glob: "...", instruction: "..." })\`.
  2. Read \`<resultsDir>/results.jsonl\` and combine the subagent outputs into a final answer.

  **Script form:**
  1. **Generate tasks.** Write a generation script via \`execute\` that produces a \`tasks.jsonl\` file — one JSON object per line, each with \`id\`, \`description\`, and optional \`subagentType\`. Each task should be a self-contained unit of work. **Prefer many small tasks over few large ones** — all tasks run in parallel, so 50 small tasks finish in roughly the same wall-clock time as 5 large ones. When splitting a file, aim for **30–60 lines** per chunk.
  2. **Call swarm.** Pass the path to your \`tasks.jsonl\` file.
  3. **Aggregate results.** Write an aggregation script via \`execute\` that reads \`<resultsDir>/results.jsonl\` and combines the subagent outputs into a final answer.

  ### Task description quality

  Each subagent receives **only its task description** — no other context. The quality of your descriptions determines the quality of swarm results. Invest time upfront to get them right.

  Good task descriptions are **prescriptive**: they tell the subagent the data format, the processing logic, the exact range of data to work on, and the expected output format. The subagent should not need to explore or interpret — just execute.

  For the virtual-table form, each subagent receives the file contents plus the shared \`instruction\`. The instruction plays the role of the task description — make it equally prescriptive (data format, processing rules, output schema).

  When subagent results need to be aggregated (counting, classification, extraction), instruct each subagent to respond with **structured JSON only** — no explanations, no tables, just the JSON object. Include the exact output schema in the task description.

  ### Error handling

  Each task runs exactly once — there are no automatic retries. If some tasks fail, the swarm summary includes a \`failedTasks\` array with each failed task's ID and error message. Use this to decide:
  - **Retry via swarm**: generate a new tasks.jsonl (or new file set) targeting just the failures and call swarm again.
  - **Retry individually**: use \`task\` for a small number of failures.
  - **Proceed with partial results**: aggregate what completed and skip the rest.

  ### Important: one swarm call per question

  **Never re-run swarm to verify or cross-check results.** Swarm is expensive — treat the first run's per-task outputs as authoritative. If you need to validate, do it in the aggregation step (e.g., check that each chunk returned the expected number of items). Do not call swarm again for the same question.

  ### Decomposition patterns

  **Flat fan-out**: Split a dataset into equal chunks. All tasks are identical in structure.
  Good for: large files, classification, extraction. Use script form for chunks within one file, virtual-table form for one file per chunk.

  **One-per-item**: One task per discrete unit (file, document, URL).
  Good for: summarizing collections, processing independent documents. Virtual-table form is the natural fit.

  **Dimensional**: Multiple tasks examine the same input from different angles.
  Good for: code review, multi-criteria evaluation. Use script form (each task has a distinct description).
`;

/**
 * Options for creating the swarm tool.
 */
export interface CreateSwarmToolOptions {
  /**
   * Map of subagent name -> compiled agent graph.
   */
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;

  /**
   * Backend for file I/O (reading task config, writing results).
   */
  backend: AnyBackendProtocol | BackendFactory;
}

/**
 * Options for creating swarm middleware.
 */
export interface SwarmMiddlewareOptions {
  /**
   * Map of subagent name -> compiled agent graph.
   *
   * These are the same subagent graphs used by the task tool. The swarm
   * executor dispatches tasks to these graphs by name.
   */
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;

  /**
   * Backend for file I/O (reading task config, writing results).
   */
  backend: AnyBackendProtocol | BackendFactory;
}

/**
 * Read a tasks.jsonl file, checking the backend first and falling back
 * to direct filesystem read for sandbox-generated files.
 */
async function readTasksFile(
  tasksPath: string,
  backend: BackendProtocolV2,
): Promise<string | { error: string }> {
  let backendResult: ReadRawResult | undefined;
  try {
    backendResult = await backend.readRaw(tasksPath);
  } catch {
    // backend may throw on missing paths instead of returning an error
  }

  if (
    backendResult &&
    !backendResult.error &&
    backendResult.data !== undefined
  ) {
    const { content } = backendResult.data;
    if (Array.isArray(content)) {
      return content.join("\n");
    }
    if (typeof content === "string") {
      return content;
    }
    return new TextDecoder().decode(content);
  }

  try {
    return readFileSync(tasksPath, "utf-8");
  } catch {
    return {
      error:
        `Failed to read tasks file at "${tasksPath}". ` +
        `Ensure the generation script writes the file to this exact path. ` +
        `Or use the virtual-table form: swarm({ glob: "...", instruction: "..." })`,
    };
  }
}

/**
 * Execute the script form: read a pre-generated tasks.jsonl, parse it,
 * and run the swarm.
 */
async function executeScriptForm(options: {
  tasksPath: string;
  backend: BackendProtocolV2;
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;
  concurrency: number;
  currentState: Record<string, unknown>;
}): Promise<string> {
  const content = await readTasksFile(options.tasksPath, options.backend);
  if (typeof content !== "string") {
    return content.error;
  }

  let tasks;
  try {
    tasks = parseTasksJsonl(content);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  try {
    const summary = await executeSwarm({
      tasks,
      subagentGraphs: options.subagentGraphs,
      backend: options.backend,
      concurrency: options.concurrency,
      currentState: options.currentState,
    });
    return JSON.stringify(summary);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Execute the virtual-table form: resolve files from paths/globs,
 * synthesize tasks, and run the swarm.
 */
async function executeVirtualTableForm(options: {
  filePaths?: string[];
  glob?: string | string[];
  instruction: string;
  subagentType?: string;
  backend: BackendProtocolV2;
  subagentGraphs: Record<string, ReactAgent<any> | Runnable>;
  concurrency: number;
  currentState: Record<string, unknown>;
}): Promise<string> {
  const resolveResult = await resolveVirtualTableTasks(
    {
      filePaths: options.filePaths,
      glob: options.glob,
      instruction: options.instruction,
      subagentType: options.subagentType,
    },
    options.backend,
  );

  if ("error" in resolveResult) {
    return resolveResult.error;
  }

  try {
    const summary = await executeSwarm({
      tasks: resolveResult.tasks,
      subagentGraphs: options.subagentGraphs,
      backend: options.backend,
      concurrency: options.concurrency,
      synthesizedTasksJsonl: resolveResult.tasksJsonl,
      currentState: options.currentState,
    });
    return JSON.stringify(summary);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Create the `swarm` tool for parallel subagent execution.
 *
 * Supports two input forms:
 * - **Script form** (`tasksPath`): reads a pre-generated tasks.jsonl file
 * - **Virtual-table form** (`filePaths`/`glob` + `instruction`): synthesizes
 *   one task per file with a shared instruction
 *
 * @param options - Subagent graphs and backend
 * @returns A StructuredTool that can be added to middleware
 */
export function createSwarmTool(options: CreateSwarmToolOptions) {
  const { subagentGraphs, backend } = options;

  return tool(
    async (input, runtime: ToolRuntime) => {
      const {
        tasksPath,
        filePaths,
        glob,
        instruction,
        subagentType,
        concurrency = DEFAULT_CONCURRENCY,
      } = input;

      const resolvedBackend = await resolveBackend(backend, runtime);
      const parentState = getCurrentTaskInput<Record<string, unknown>>();

      // Input validation
      const hasScriptForm = tasksPath != null;
      const hasVirtualTableForm = filePaths != null || glob != null;

      if (hasScriptForm && hasVirtualTableForm) {
        return "Cannot mix script form (tasksPath) with virtual-table form (filePaths/glob + instruction). Use one or the other.";
      }

      if (!hasScriptForm && !hasVirtualTableForm) {
        return "Provide either tasksPath (script form) or filePaths/glob + instruction (virtual-table form).";
      }

      if (hasVirtualTableForm && !instruction) {
        return "instruction is required when using filePaths or glob.";
      }

      if (hasScriptForm) {
        return executeScriptForm({
          tasksPath,
          backend: resolvedBackend,
          subagentGraphs,
          concurrency,
          currentState: parentState,
        });
      }

      return executeVirtualTableForm({
        filePaths,
        glob,
        instruction: instruction ?? "",
        subagentType,
        backend: resolvedBackend,
        subagentGraphs,
        concurrency,
        currentState: parentState,
      });
    },
    {
      name: "swarm",
      description: `Execute a batch of independent tasks in parallel across multiple subagents.

## Two input forms

### Virtual-table form (filePaths/glob + instruction)
Pass a set of files and a shared instruction. Swarm synthesizes one task per file automatically — no generation script needed.

Examples:
- \`swarm({ glob: "feedback/*.txt", instruction: "Classify as bug|feature|praise. Return JSON: {category, confidence}." })\`
- \`swarm({ filePaths: ["a.txt", "b.txt"], instruction: "Summarize in 50 words. Return JSON: {summary}." })\`

Works on all backends. Use this when the same instruction applies cleanly to every file.

### Script form (tasksPath)
Write a tasks.jsonl file with one task per line, then pass its path.

1. Write a generation script via \`execute\` that produces a tasks.jsonl file with one JSON object per line:
   \`\`\`json
   {"id": "chunk_0", "description": "Read lines 1-100 of data.txt. Process each item. Return JSON results.", "subagentType": "general-purpose"}
   {"id": "chunk_1", "description": "Read lines 101-200 of data.txt. Process each item. Return JSON results.", "subagentType": "general-purpose"}
   \`\`\`
2. Call \`swarm({ tasksPath: "path/to/tasks.jsonl" })\`.
3. Write an aggregation script via \`execute\` that reads \`<resultsDir>/results.jsonl\` and combines the outputs.

Requires \`execute\`. Use this for chunking a single file, varying descriptions, or dimensional fan-out.

## tasks.jsonl fields (script form)

- "id" (string, required): unique task identifier
- "description" (string, required): complete, self-contained prompt — the subagent receives NOTHING else
- "subagentType" (string, optional): which subagent to use (default: "general-purpose")

## After execution

The tool returns a JSON summary:
\`\`\`json
{"total": 20, "completed": 19, "failed": 1, "resultsDir": "swarm_runs/<uuid>", "failedTasks": [{"id": "chunk_5", "error": "timed out after 300s"}]}
\`\`\`

Results are written to \`<resultsDir>/results.jsonl\` — each line has \`id\`, \`subagentType\`, \`status\`, and \`result\` or \`error\`.

Each task runs exactly once — there are no automatic retries. Use the \`failedTasks\` array to decide how to handle failures.

Available subagent types: ${Object.keys(subagentGraphs).join(", ")}`,
      schema: z.object({
        tasksPath: z
          .string()
          .optional()
          .describe(
            "Path to a tasks.jsonl file. Mutually exclusive with filePaths/glob.",
          ),
        filePaths: z
          .array(z.string())
          .optional()
          .describe(
            "Explicit file paths to process. Each file becomes one task.",
          ),
        glob: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            "Glob pattern(s) to match files. Each matched file becomes one task.",
          ),
        instruction: z
          .string()
          .optional()
          .describe(
            "Shared instruction applied to each file. Required when using filePaths/glob.",
          ),
        subagentType: z
          .string()
          .optional()
          .describe(
            "Subagent type for all tasks. Defaults to general-purpose.",
          ),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(MAX_CONCURRENCY)
          .optional()
          .describe(
            `Max parallel tasks. Default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY}.`,
          ),
      }),
    },
  );
}

/**
 * Create swarm middleware that adds parallel subagent execution to an agent.
 *
 * Adds the `swarm` tool and injects the swarm system prompt into the
 * orchestrator's system message.
 *
 * @param options - Subagent graphs and backend
 * @returns AgentMiddleware to include in the agent's middleware stack
 */
export function createSwarmMiddleware(
  options: SwarmMiddlewareOptions,
): AgentMiddleware {
  const { subagentGraphs, backend } = options;

  const swarmTool = createSwarmTool({ subagentGraphs, backend });

  return createMiddleware({
    name: "swarmMiddleware",
    tools: [swarmTool],
    wrapModelCall: async (request, handler) => {
      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(
          new SystemMessage({ content: SWARM_SYSTEM_PROMPT }),
        ),
      });
    },
  });
}
