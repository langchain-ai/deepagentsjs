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
export const SWARM_SYSTEM_PROMPT = context``;

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

### Script form (tasksPath)
1. Write a generation script via \`execute\` that produces a tasks.jsonl file.
2. Call \`swarm({ tasksPath: "path/to/tasks.jsonl" })\`.
3. Write an aggregation script that reads \`<resultsDir>/results.jsonl\`.

### Virtual-table form (filePaths/glob + instruction)
1. Call \`swarm({ glob: "feedback/*.txt", instruction: "Classify as bug|feature|praise." })\`.
2. Read \`<resultsDir>/results.jsonl\` and reason over the results.

## tasks.jsonl fields
- "id" (string, required): unique task identifier
- "description" (string, required): complete, self-contained prompt
- "subagentType" (string, optional): which subagent to use (default: "general-purpose")

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
