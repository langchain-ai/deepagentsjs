/**
 * Middleware for providing filesystem tools to an agent.
 *
 * Provides ls, read_file, write_file, edit_file, glob, and grep tools with support for:
 * - Pluggable backends (StateBackend, StoreBackend, FilesystemBackend, CompositeBackend)
 * - Tool result eviction for large outputs
 */

import {
  createMiddleware,
  tool,
  ToolMessage,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { Command, isCommand, getCurrentTaskInput } from "@langchain/langgraph";
import { z } from "zod/v4";
import type {
  BackendProtocol,
  BackendFactory,
  FileData,
  StateAndStore,
} from "../backends/protocol.js";
import { isSandboxBackend } from "../backends/protocol.js";
import { StateBackend } from "../backends/state.js";
import { sanitizeToolCallId } from "../backends/utils.js";

/**
 * required for type inference
 */
import type * as _zodTypes from "@langchain/core/utils/types";
import type * as _zodMeta from "@langchain/langgraph/zod";
import type * as _messages from "@langchain/core/messages";

/**
 * Zod v3 schema for FileData (re-export from backends)
 */
const FileDataSchema = z.object({
  content: z.array(z.string()),
  created_at: z.string(),
  modified_at: z.string(),
});

export type { FileData };

/**
 * Merge file updates with support for deletions.
 */
function fileDataReducer(
  left: Record<string, FileData> | undefined,
  right: Record<string, FileData | null>,
): Record<string, FileData> {
  if (left === undefined) {
    const result: Record<string, FileData> = {};
    for (const [key, value] of Object.entries(right)) {
      if (value !== null) {
        result[key] = value;
      }
    }
    return result;
  }

  const result = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Shared filesystem state schema.
 * Defined at module level to ensure the same object identity is used across all agents,
 * preventing "Channel already exists with different type" errors when multiple agents
 * use createFilesystemMiddleware.
 */
const FilesystemStateSchema = z.object({
  files: z
    .record(z.string(), FileDataSchema)
    .default({})
    .meta({
      reducer: {
        fn: fileDataReducer,
        schema: z.record(z.string(), FileDataSchema.nullable()),
      },
    }),
});

/**
 * Resolve backend from factory or instance.
 *
 * @param backend - Backend instance or factory function
 * @param stateAndStore - State and store container for backend initialization
 */
function getBackend(
  backend: BackendProtocol | BackendFactory,
  stateAndStore: StateAndStore,
): BackendProtocol {
  if (typeof backend === "function") {
    return backend(stateAndStore);
  }
  return backend;
}

// System prompts
const FILESYSTEM_SYSTEM_PROMPT = `You have access to a virtual filesystem. All file paths must start with a /.

- ls: list files in a directory (requires absolute path)
- read_file: read a file from the filesystem
- write_file: write to a file in the filesystem
- edit_file: edit a file in the filesystem
- glob: find files matching a pattern (e.g., "**/*.py")
- grep: search for text within files`;

// Tool descriptions
export const LS_TOOL_DESCRIPTION = "List files and directories in a directory";
export const READ_FILE_TOOL_DESCRIPTION = "Read the contents of a file";
export const WRITE_FILE_TOOL_DESCRIPTION =
  "Write content to a new file. Returns an error if the file already exists";
export const EDIT_FILE_TOOL_DESCRIPTION =
  "Edit a file by replacing a specific string with a new string";
export const GLOB_TOOL_DESCRIPTION =
  "Find files matching a glob pattern (e.g., '**/*.py' for all Python files)";
export const GREP_TOOL_DESCRIPTION =
  "Search for a regex pattern in files. Returns matching files and line numbers";
export const EXECUTE_TOOL_DESCRIPTION = `Executes a given command in the sandbox environment with proper handling and security measures.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use the ls tool to verify the parent directory exists

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes
   - Commands run in an isolated sandbox environment
   - Returns combined stdout/stderr output with exit code

Usage notes:
  - The command parameter is required
  - If the output is very large, it may be truncated
  - IMPORTANT: Avoid using search commands like find and grep. Use the grep, glob tools instead.
  - Avoid read tools like cat, head, tail - use read_file instead.
  - Use '&&' to chain dependent commands, ';' for independent commands
  - Try to use absolute paths to avoid cd`;

// System prompt for execution capability
export const EXECUTION_SYSTEM_PROMPT = `## Execute Tool \`execute\`

You have access to an \`execute\` tool for running shell commands in a sandboxed environment.
Use this tool to run commands, scripts, tests, builds, and other shell operations.

- execute: run a shell command in the sandbox (returns output and exit code)`;

/**
 * Create ls tool using backend.
 */
function createLsTool(
  backend: BackendProtocol | BackendFactory,
  options: { customDescription: string | undefined },
) {
  const { customDescription } = options;
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const path = input.path || "/";
      const infos = await resolvedBackend.lsInfo(path);

      if (infos.length === 0) {
        return `No files found in ${path}`;
      }

      // Format output
      const lines: string[] = [];
      for (const info of infos) {
        if (info.is_dir) {
          lines.push(`${info.path} (directory)`);
        } else {
          const size = info.size ? ` (${info.size} bytes)` : "";
          lines.push(`${info.path}${size}`);
        }
      }
      return lines.join("\n");
    },
    {
      name: "ls",
      description: customDescription || LS_TOOL_DESCRIPTION,
      schema: z.object({
        path: z
          .string()
          .optional()
          .default("/")
          .describe("Directory path to list (default: /)"),
      }),
    },
  );
}

/**
 * Create read_file tool using backend.
 */
function createReadFileTool(
  backend: BackendProtocol | BackendFactory,
  options: { customDescription: string | undefined },
) {
  const { customDescription } = options;
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const { file_path, offset = 0, limit = 2000 } = input;
      return await resolvedBackend.read(file_path, offset, limit);
    },
    {
      name: "read_file",
      description: customDescription || READ_FILE_TOOL_DESCRIPTION,
      schema: z.object({
        file_path: z.string().describe("Absolute path to the file to read"),
        offset: z.coerce
          .number()
          .optional()
          .default(0)
          .describe("Line offset to start reading from (0-indexed)"),
        limit: z.coerce
          .number()
          .optional()
          .default(2000)
          .describe("Maximum number of lines to read"),
      }),
    },
  );
}

/**
 * Create write_file tool using backend.
 */
function createWriteFileTool(
  backend: BackendProtocol | BackendFactory,
  options: { customDescription: string | undefined },
) {
  const { customDescription } = options;
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const { file_path, content } = input;
      const result = await resolvedBackend.write(file_path, content);

      if (result.error) {
        return result.error;
      }

      // If filesUpdate is present, return Command to update state
      const message = new ToolMessage({
        content: `Successfully wrote to '${file_path}'`,
        tool_call_id: config.toolCall?.id as string,
        name: "write_file",
        metadata: result.metadata,
      });

      if (result.filesUpdate) {
        return new Command({
          update: { files: result.filesUpdate, messages: [message] },
        });
      }

      return message;
    },
    {
      name: "write_file",
      description: customDescription || WRITE_FILE_TOOL_DESCRIPTION,
      schema: z.object({
        file_path: z.string().describe("Absolute path to the file to write"),
        content: z.string().describe("Content to write to the file"),
      }),
    },
  );
}

/**
 * Create edit_file tool using backend.
 */
function createEditFileTool(
  backend: BackendProtocol | BackendFactory,
  options: { customDescription: string | undefined },
) {
  const { customDescription } = options;
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const { file_path, old_string, new_string, replace_all = false } = input;
      const result = await resolvedBackend.edit(
        file_path,
        old_string,
        new_string,
        replace_all,
      );

      if (result.error) {
        return result.error;
      }

      const message = new ToolMessage({
        content: `Successfully replaced ${result.occurrences} occurrence(s) in '${file_path}'`,
        tool_call_id: config.toolCall?.id as string,
        name: "edit_file",
        metadata: result.metadata,
      });

      // If filesUpdate is present, return Command to update state
      if (result.filesUpdate) {
        return new Command({
          update: { files: result.filesUpdate, messages: [message] },
        });
      }

      // External storage (filesUpdate is null)
      return message;
    },
    {
      name: "edit_file",
      description: customDescription || EDIT_FILE_TOOL_DESCRIPTION,
      schema: z.object({
        file_path: z.string().describe("Absolute path to the file to edit"),
        old_string: z
          .string()
          .describe("String to be replaced (must match exactly)"),
        new_string: z.string().describe("String to replace with"),
        replace_all: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether to replace all occurrences"),
      }),
    },
  );
}

/**
 * Create glob tool using backend.
 */
function createGlobTool(
  backend: BackendProtocol | BackendFactory,
  options: { customDescription: string | undefined },
) {
  const { customDescription } = options;
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const { pattern, path = "/" } = input;
      const infos = await resolvedBackend.globInfo(pattern, path);

      if (infos.length === 0) {
        return `No files found matching pattern '${pattern}'`;
      }

      return infos.map((info) => info.path).join("\n");
    },
    {
      name: "glob",
      description: customDescription || GLOB_TOOL_DESCRIPTION,
      schema: z.object({
        pattern: z.string().describe("Glob pattern (e.g., '*.py', '**/*.ts')"),
        path: z
          .string()
          .optional()
          .default("/")
          .describe("Base path to search from (default: /)"),
      }),
    },
  );
}

/**
 * Create grep tool using backend.
 */
function createGrepTool(
  backend: BackendProtocol | BackendFactory,
  options: { customDescription: string | undefined },
) {
  const { customDescription } = options;
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const { pattern, path = "/", glob = null } = input;
      const result = await resolvedBackend.grepRaw(pattern, path, glob);

      // If string, it's an error
      if (typeof result === "string") {
        return result;
      }

      if (result.length === 0) {
        return `No matches found for pattern '${pattern}'`;
      }

      // Format output: group by file
      const lines: string[] = [];
      let currentFile: string | null = null;
      for (const match of result) {
        if (match.path !== currentFile) {
          currentFile = match.path;
          lines.push(`\n${currentFile}:`);
        }
        lines.push(`  ${match.line}: ${match.text}`);
      }

      return lines.join("\n");
    },
    {
      name: "grep",
      description: customDescription || GREP_TOOL_DESCRIPTION,
      schema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z
          .string()
          .optional()
          .default("/")
          .describe("Base path to search from (default: /)"),
        glob: z
          .string()
          .optional()
          .nullable()
          .describe("Optional glob pattern to filter files (e.g., '*.py')"),
      }),
    },
  );
}

/**
 * Create execute tool using backend.
 */
function createExecuteTool(
  backend: BackendProtocol | BackendFactory,
  options: { customDescription: string | undefined },
) {
  const { customDescription } = options;
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);

      // Runtime check - fail gracefully if not supported
      if (!isSandboxBackend(resolvedBackend)) {
        return (
          "Error: Execution not available. This agent's backend " +
          "does not support command execution (SandboxBackendProtocol). " +
          "To use the execute tool, provide a backend that implements SandboxBackendProtocol."
        );
      }

      const result = await resolvedBackend.execute(input.command);

      // Format output for LLM consumption
      const parts = [result.output];

      if (result.exitCode !== null) {
        const status = result.exitCode === 0 ? "succeeded" : "failed";
        parts.push(`\n[Command ${status} with exit code ${result.exitCode}]`);
      }

      if (result.truncated) {
        parts.push("\n[Output was truncated due to size limits]");
      }

      return parts.join("");
    },
    {
      name: "execute",
      description: customDescription || EXECUTE_TOOL_DESCRIPTION,
      schema: z.object({
        command: z.string().describe("The shell command to execute"),
      }),
    },
  );
}

/**
 * Options for creating filesystem middleware.
 */
export interface FilesystemMiddlewareOptions {
  /** Backend instance or factory (default: StateBackend) */
  backend?: BackendProtocol | BackendFactory;
  /** Optional custom system prompt override */
  systemPrompt?: string | null;
  /** Optional custom tool descriptions override */
  customToolDescriptions?: Record<string, string> | null;
  /** Optional token limit before evicting a tool result to the filesystem (default: 20000 tokens, ~80KB) */
  toolTokenLimitBeforeEvict?: number | null;
}

/**
 * Create filesystem middleware with all tools and features.
 */
export function createFilesystemMiddleware(
  options: FilesystemMiddlewareOptions = {},
) {
  const {
    backend = (stateAndStore: StateAndStore) => new StateBackend(stateAndStore),
    systemPrompt: customSystemPrompt = null,
    customToolDescriptions = null,
    toolTokenLimitBeforeEvict = 20000,
  } = options;

  const baseSystemPrompt = customSystemPrompt || FILESYSTEM_SYSTEM_PROMPT;

  // All tools including execute (execute will be filtered at runtime if backend doesn't support it)
  const allTools = [
    createLsTool(backend, {
      customDescription: customToolDescriptions?.ls,
    }),
    createReadFileTool(backend, {
      customDescription: customToolDescriptions?.read_file,
    }),
    createWriteFileTool(backend, {
      customDescription: customToolDescriptions?.write_file,
    }),
    createEditFileTool(backend, {
      customDescription: customToolDescriptions?.edit_file,
    }),
    createGlobTool(backend, {
      customDescription: customToolDescriptions?.glob,
    }),
    createGrepTool(backend, {
      customDescription: customToolDescriptions?.grep,
    }),
    createExecuteTool(backend, {
      customDescription: customToolDescriptions?.execute,
    }),
  ];

  return createMiddleware({
    name: "FilesystemMiddleware",
    stateSchema: FilesystemStateSchema,
    tools: allTools,
    wrapModelCall: async (request, handler) => {
      // Check if backend supports execution
      const stateAndStore: StateAndStore = {
        state: request.state || {},
        // @ts-expect-error - request.config is incorrect typed
        store: request.config?.store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const supportsExecution = isSandboxBackend(resolvedBackend);

      // Filter tools based on backend capabilities
      let tools = request.tools;
      if (!supportsExecution) {
        tools = tools.filter((t: { name: string }) => t.name !== "execute");
      }

      // Build system prompt - add execution instructions if available
      let systemPrompt = baseSystemPrompt;
      if (supportsExecution) {
        systemPrompt = `${systemPrompt}\n\n${EXECUTION_SYSTEM_PROMPT}`;
      }

      // Combine with existing system prompt
      const currentSystemPrompt = request.systemPrompt || "";
      const newSystemPrompt = currentSystemPrompt
        ? `${currentSystemPrompt}\n\n${systemPrompt}`
        : systemPrompt;

      return handler({ ...request, tools, systemPrompt: newSystemPrompt });
    },
    wrapToolCall: toolTokenLimitBeforeEvict
      ? async (request, handler) => {
          const result = await handler(request);

          async function processToolMessage(msg: ToolMessage) {
            if (
              typeof msg.content === "string" &&
              msg.content.length > toolTokenLimitBeforeEvict! * 4
            ) {
              // Build StateAndStore from request
              const stateAndStore: StateAndStore = {
                state: request.state || {},
                // @ts-expect-error - request.config is incorrect typed
                store: request.config?.store,
              };
              const resolvedBackend = getBackend(backend, stateAndStore);
              const sanitizedId = sanitizeToolCallId(
                request.toolCall?.id || msg.tool_call_id,
              );
              const evictPath = `/large_tool_results/${sanitizedId}`;

              const writeResult = await resolvedBackend.write(
                evictPath,
                msg.content,
              );

              if (writeResult.error) {
                return { message: msg, filesUpdate: null };
              }

              const truncatedMessage = new ToolMessage({
                content: `Tool result too large (${Math.round(msg.content.length / 4)} tokens). Content saved to ${evictPath}`,
                tool_call_id: msg.tool_call_id,
                name: msg.name,
              });

              return {
                message: truncatedMessage,
                filesUpdate: writeResult.filesUpdate,
              };
            }
            return { message: msg, filesUpdate: null };
          }

          if (result instanceof ToolMessage) {
            const processed = await processToolMessage(result);

            if (processed.filesUpdate) {
              return new Command({
                update: {
                  files: processed.filesUpdate,
                  messages: [processed.message],
                },
              });
            }

            return processed.message;
          }

          if (isCommand(result)) {
            const update = result.update as any;
            if (!update?.messages) {
              return result;
            }

            let hasLargeResults = false;
            const accumulatedFiles: Record<string, FileData> = {
              ...(update.files || {}),
            };
            const processedMessages: ToolMessage[] = [];

            for (const msg of update.messages) {
              if (msg instanceof ToolMessage) {
                const processed = await processToolMessage(msg);
                processedMessages.push(processed.message);

                if (processed.filesUpdate) {
                  hasLargeResults = true;
                  Object.assign(accumulatedFiles, processed.filesUpdate);
                }
              } else {
                processedMessages.push(msg);
              }
            }

            if (hasLargeResults) {
              return new Command({
                update: {
                  ...update,
                  messages: processedMessages,
                  files: accumulatedFiles,
                },
              });
            }
          }

          return result;
        }
      : undefined,
  });
}
