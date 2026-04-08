import { z } from "zod";
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

  You have access to a \`swarm\` tool for executing many independent tasks in parallel across multiple subagents.

  ### When to use swarm

  - A single subagent can handle large files for summarization. But when precise analysis is needed over a large file — counting, extraction, searching, or anything where accuracy matters — check the file size first and use \`swarm\` to split the work for any file over 500 lines. Do NOT send large files to a single \`task\` subagent for precise analysis.
  - CRITICAL: When a task requires looping over items and applying intelligence to each one (classifying, labeling, categorizing, identifying, tagging), you MUST use \`swarm\` — regardless of file size. Do NOT classify items inline, do NOT delegate to a single \`task\` subagent, and do NOT write heuristic scripts. The only acceptable approach is \`swarm\`.

  ### When to use \`task\` instead

  - You have a small number of independent subtasks (use parallel \`task\` tool calls)
  - The next subtask depends on results from a previous one
  - You need exploratory or adaptive work (e.g., grep first, then investigate)

  ### Before distributing work

  Figure out exactly how you would do the task yourself first — only after you have that clarity should you distribute to subagents. Write out the exact instructions you will give to each worker. Be specific and leave no room for interpretation — workers will interpret ambiguity differently, and inconsistent results cannot be aggregated reliably.

  ### Task description requirements

  Each task description must be **completely self-contained**. The subagent:
  - Receives ONLY the description text as its prompt
  - Has no context about other tasks, the broader objective, or prior conversation
  - Cannot ask clarifying questions

  Be explicit about the expected output format in every task description.

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

      const result = await resolvedBackend.readRaw(tasksPath);
      if (result.error || result.data === undefined) {
        return (
          `Failed to read tasks file at "${tasksPath}": ${result.error ?? "file not found"}. ` +
          `Use write_file to create the tasks.jsonl file before calling swarm.`
        );
      }
      // FileData can be v1 (content: string[]) or v2 (content: string | Uint8Array)
      const content = Array.isArray(result.data.content)
        ? result.data.content.join("\n")
        : typeof result.data.content === "string"
          ? result.data.content
          : new TextDecoder().decode(result.data.content);

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

1. Create a tasks.jsonl file with one JSON object per line:
   \`\`\`json
   {"id": "chunk_0", "description": "Classify lines 1-500 of data.txt. Return JSON counts.", "subagentType": "general-purpose"}
   {"id": "chunk_1", "description": "Classify lines 501-1000 of data.txt. Return JSON counts.", "subagentType": "general-purpose"}
   \`\`\`
   Use \`write_file\` to create the file, or generate it with a script via \`execute\` if available.
2. Call \`swarm\` with the path to the tasks.jsonl file.
3. The tool returns a JSON summary with \`total\`, \`completed\`, \`failed\`, and \`resultsDir\`.
   Results are written to \`<resultsDir>/results.jsonl\` — each line is the original task enriched with \`status\`, \`result\`, and/or \`error\` fields.
4. Read \`<resultsDir>/results.jsonl\` (using \`read_file\`) to aggregate the results.

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
            "Path to the tasks.jsonl file (created via write_file or a generation script).",
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
