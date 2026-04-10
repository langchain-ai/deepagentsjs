import { z } from "zod";
import { readFileSync } from "node:fs";
import { Runnable } from "@langchain/core/runnables";
import {
  AgentMiddleware,
  context,
  createMiddleware,
  ReactAgent,
  SystemMessage,
  tool,
  type ToolRuntime,
} from "langchain";
import {
  type AnyBackendProtocol,
  type BackendFactory,
  resolveBackend,
} from "../backends/protocol.js";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  MAX_CONCURRENCY,
} from "../swarm/types.js";
import { parseTasksJsonl } from "../swarm/parse.js";
import { getCurrentTaskInput } from "@langchain/langgraph";
import { executeSwarm } from "../swarm/executor.js";

/**
 * System prompt section that explains the swarm workflow to the orchestrator.
 *
 * Appended to the orchestrator's system message when swarm middleware is
 * enabled. Explains when to use swarm vs. task, the 5-step workflow,
 * decomposition patterns, and task description requirements.
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

  ### How to use swarm

  Before calling swarm, understand what you're working with. Explore the data to learn its structure, format, and content using whatever tools are available. The goal is to write task descriptions detailed enough that each subagent can execute without needing to figure anything out on its own.

  Once you understand the data:

  1. **Generate tasks.** Write a generation script via \`execute\` that produces a \`tasks.jsonl\` file — one JSON object per line, each with \`id\`, \`description\`, and optional \`subagentType\`. Each task should be a self-contained unit of work. **Prefer many small tasks over few large ones** — all tasks run in parallel, so 50 small tasks finish in roughly the same wall-clock time as 5 large ones. When splitting a file, aim for **30–60 lines** per chunk.
  2. **Call swarm.** Pass the path to your \`tasks.jsonl\` file.
  3. **Aggregate results.** Write an aggregation script via \`execute\` that reads \`<resultsDir>/results.jsonl\` and combines the subagent outputs into a final answer.

  ### Task description quality

  Each subagent receives **only its task description** — no other context. The quality of your descriptions determines the quality of swarm results. Invest time upfront to get them right.

  Good task descriptions are **prescriptive**: they tell the subagent the data format, the processing logic, the exact range of data to work on, and the expected output format. The subagent should not need to explore or interpret — just execute.

  When subagent results need to be aggregated (counting, classification, extraction), instruct each subagent to respond with **structured JSON only** — no explanations, no tables, just the JSON object. Include the exact output schema in the task description.

  ### Important: one swarm call per question

  **Never re-run swarm to verify or cross-check results.** Swarm is expensive — treat the first run's per-task outputs as authoritative. If you need to validate, do it in the aggregation script (e.g., check that each chunk returned the expected number of items). Do not generate a second tasks.jsonl or call swarm again for the same question.

  ### Decomposition patterns

  **Flat fan-out**: Split a dataset into equal chunks. All tasks are identical in structure.
  Good for: large files, classification, extraction.

  **One-per-item**: One task per discrete unit (file, document, URL).
  Good for: summarizing collections, processing independent documents.

  **Dimensional**: Multiple tasks examine the same input from different angles.
  Good for: code review, multi-criteria evaluation.
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
 * Create the `swarm` tool for parallel subagent execution.
 *
 * The tool:
 * 1. Reads the tasks.jsonl file from the backend
 * 2. Parses and validates the task list
 * 3. Runs the executor with concurrency control and retries
 * 4. Returns a structured summary to the orchestrator
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
        concurrency = DEFAULT_CONCURRENCY,
        maxRetries = DEFAULT_MAX_RETRIES,
      } = input;

      const resolvedBackend = await resolveBackend(backend, runtime);

      // Read tasks file: try backend first, then direct filesystem read.
      // The generation script typically writes via execute (real filesystem),
      // but write_file stores in backend state — so we check both.
      let content: string;
      let backendResult:
        | Awaited<ReturnType<typeof resolvedBackend.readRaw>>
        | undefined;
      try {
        backendResult = await resolvedBackend.readRaw(tasksPath);
      } catch {
        // backend may throw on missing paths instead of returning an error
      }

      if (
        backendResult &&
        !backendResult.error &&
        backendResult.data !== undefined
      ) {
        // File found in backend state (written via write_file)
        content = Array.isArray(backendResult.data.content)
          ? backendResult.data.content.join("\n")
          : typeof backendResult.data.content === "string"
            ? backendResult.data.content
            : new TextDecoder().decode(backendResult.data.content);
      } else {
        // File written via execute — read from filesystem directly
        try {
          content = readFileSync(tasksPath, "utf-8");
        } catch {
          return (
            `Failed to read tasks file at "${tasksPath}". ` +
            `Ensure the generation script writes the file to this exact path and try again.`
          );
        }
      }

      const tasks = parseTasksJsonl(content);
      const parentState = getCurrentTaskInput<Record<string, unknown>>();

      const summary = await executeSwarm(tasks, {
        subagentGraphs,
        backend: resolvedBackend,
        parentState,
        config: runtime,
        concurrency,
        maxRetries,
      });

      return JSON.stringify(summary);
    },
    {
      name: "swarm",
      description: `Execute a batch of independent tasks in parallel across multiple subagents.

## Workflow

1. Write a generation script via \`execute\` that produces a tasks.jsonl file with one JSON object per line:
   \`\`\`json
   {"id": "chunk_0", "description": "Read lines 1-100 of data.txt. Process each item. Return JSON results.", "subagentType": "general-purpose"}
   {"id": "chunk_1", "description": "Read lines 101-200 of data.txt. Process each item. Return JSON results.", "subagentType": "general-purpose"}
   \`\`\`
2. Call \`swarm\` with the path to the tasks.jsonl file.
3. The tool returns a JSON summary with \`total\`, \`completed\`, \`failed\`, and \`resultsDir\`.
   Results are written to \`<resultsDir>/results.jsonl\` — each line is the original task enriched with \`status\`, \`result\`, and/or \`error\` fields.
4. Write an aggregation script via \`execute\` that reads \`<resultsDir>/results.jsonl\` and combines the outputs.

## tasks.jsonl fields

- "id" (string, required): unique task identifier
- "description" (string, required): complete, self-contained prompt — the subagent receives NOTHING else
- "subagentType" (string, optional): which subagent to use (default: "general-purpose")

## After execution

The tool returns:
\`\`\`json
{"total": 20, "completed": 19, "failed": 1, "resultsDir": "swarm_runs/<uuid>"}
\`\`\`

Available subagent types: ${Object.keys(subagentGraphs).join(", ")}`,
      schema: z.object({
        tasksPath: z
          .string()
          .describe(
            "Path to the tasks.jsonl file produced by the generation script.",
          ),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(MAX_CONCURRENCY)
          .optional()
          .describe(
            `Maximum number of subagents running simultaneously. Default: ${DEFAULT_CONCURRENCY}, max: ${MAX_CONCURRENCY}.`,
          ),
        maxRetries: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            `Maximum attempts per task (including initial). Default: ${DEFAULT_MAX_RETRIES}.`,
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
