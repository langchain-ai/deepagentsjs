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

  **Trigger condition**: When asked to analyze a file, first run \`wc -c\` to check its size. If it exceeds **150,000 bytes**, you **must** use swarm — do not attempt to process the file directly with grep, read_file, or any other tool.

  Also use \`swarm\` when:
  - A task requires applying intelligence to each item in a large collection
  - Work can be decomposed into many independent, parallel subtasks

  Use \`task\` instead when:
  - You have a small number of independent subtasks
  - Each subtask depends on the result of a previous one
  - The work is exploratory or adaptive

  ### How to use swarm

  Before calling swarm, understand what you're working with. Explore the file to learn its structure, format, and content — use whatever tools make sense (\`read_file\`, \`execute\`, \`grep\`, etc.). The goal is to write task descriptions detailed enough that each subagent can execute mechanically without needing to figure anything out on its own.

  Once you understand the data:

  1. **Write tasks.** Create \`tasks.jsonl\` in the current working directory using \`write_file\` or a generation script via \`execute\`. Do not use subdirectories — write directly to \`tasks.jsonl\`. Aim for **40–50 lines per chunk** when splitting a file.
  2. **Call swarm.** Pass the path to your \`tasks.jsonl\` file.
  3. **Aggregate results.** Read \`<resultsDir>/results.jsonl\` and combine the subagent outputs.

  ### Task description quality

  Each subagent receives **only its task description** — no other context. The quality of your descriptions determines the quality of swarm results. Invest time upfront to get them right.

  Good task descriptions are **prescriptive**: they tell the subagent the data format, the classification rules or processing logic, the exact line range to read, and the output schema. The subagent should not need to explore or interpret — just execute.

  Every description should end with: **"IMPORTANT: Your entire response must be a single JSON object — no tables, no explanations, no reasoning, no text before or after. Only the JSON."**

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

      // TODO: This is very hacky but works for now - not a good prod solution though
      let content: string;
      let result: Awaited<ReturnType<typeof resolvedBackend.readRaw>> | undefined;
      try {
        result = await resolvedBackend.readRaw(tasksPath);
      } catch {
        // backend may throw on missing paths instead of returning an error
      }
      if (!result || result.error || result.data === undefined) {
        // The orchestrator may have written via execute to a path the backend
        // can't resolve. Try direct filesystem reads as a fallback.
        let found = false;
        const candidates = [
          tasksPath,
          tasksPath.startsWith("/") ? tasksPath : `/${tasksPath}`,
          `/tmp/${tasksPath.split("/").pop()}`,
        ];
        for (const candidate of candidates) {
          try {
            content = readFileSync(candidate, "utf-8");
            found = true;
            break;
          } catch {
            // try next candidate
          }
        }
        if (!found) {
          return (
            `Failed to read tasks file at "${tasksPath}": ${result.error ?? "file not found"}. ` +
            `Write the tasks file to "tasks.jsonl" (no subdirectories) and try again.`
          );
        }
      } else {
        // FileData can be v1 (content: string[]) or v2 (content: string | Uint8Array)
        content = Array.isArray(result.data.content)
          ? result.data.content.join("\n")
          : typeof result.data.content === "string"
            ? result.data.content
            : new TextDecoder().decode(result.data.content);
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
