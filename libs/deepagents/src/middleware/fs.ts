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
import {
  Command,
  isCommand,
  getCurrentTaskInput,
  StateSchema,
  ReducedValue,
} from "@langchain/langgraph";
import { z } from "zod/v4";
import type {
  BackendProtocol,
  BackendFactory,
  FileData,
  StateAndStore,
} from "../backends/protocol.js";
import { isSandboxBackend } from "../backends/protocol.js";
import { StateBackend } from "../backends/state.js";
import {
  sanitizeToolCallId,
  formatContentWithLineNumbers,
} from "../backends/utils.js";

/**
 * Tools that should be excluded from the large result eviction logic.
 *
 * This array contains tools that should NOT have their results evicted to the filesystem
 * when they exceed token limits. Tools are excluded for different reasons:
 *
 * 1. Tools with built-in truncation (ls, glob, grep):
 *    These tools truncate their own output when it becomes too large. When these tools
 *    produce truncated output due to many matches, it typically indicates the query
 *    needs refinement rather than full result preservation. In such cases, the truncated
 *    matches are potentially more like noise and the LLM should be prompted to narrow
 *    its search criteria instead.
 *
 * 2. Tools with problematic truncation behavior (read_file):
 *    read_file is tricky to handle as the failure mode here is single long lines
 *    (e.g., imagine a jsonl file with very long payloads on each line). If we try to
 *    truncate the result of read_file, the agent may then attempt to re-read the
 *    truncated file using read_file again, which won't help.
 *
 * 3. Tools that never exceed limits (edit_file, write_file):
 *    These tools return minimal confirmation messages and are never expected to produce
 *    output large enough to exceed token limits, so checking them would be unnecessary.
 */
export const TOOLS_EXCLUDED_FROM_EVICTION = [
  "ls",
  "glob",
  "grep",
  "read_file",
  "edit_file",
  "write_file",
] as const;

/**
 * Approximate number of characters per token for truncation calculations.
 * Using 4 chars per token as a conservative approximation (actual ratio varies by content)
 * This errs on the high side to avoid premature eviction of content that might fit.
 */
export const NUM_CHARS_PER_TOKEN = 4;

/**
 * Default values for read_file tool pagination (in lines).
 */
export const DEFAULT_READ_LINE_OFFSET = 0;
export const DEFAULT_READ_LINE_LIMIT = 100;

/**
 * Template for truncation message in read_file.
 * {file_path} will be filled in at runtime.
 */
const READ_FILE_TRUNCATION_MSG = `

[Output was truncated due to size limits. The file content is very large. Consider reformatting the file to make it easier to navigate. For example, if this is JSON, use execute(command='jq . {file_path}') to pretty-print it with line breaks. For other formats, you can use appropriate formatting tools to split long lines.]`;

/**
 * Message template for evicted tool results.
 */
const TOO_LARGE_TOOL_MSG = `Tool result too large, the result of this tool call {tool_call_id} was saved in the filesystem at this path: {file_path}
You can read the result from the filesystem by using the read_file tool, but make sure to only read part of the result at a time.
You can do this by specifying an offset and limit in the read_file tool call.
For example, to read the first 100 lines, you can use the read_file tool with offset=0 and limit=100.

Here is a preview showing the head and tail of the result (lines of the form
... [N lines truncated] ...
indicate omitted lines in the middle of the content):

{content_sample}`;

/**
 * Create a preview of content showing head and tail with truncation marker.
 *
 * @param contentStr - The full content string to preview.
 * @param headLines - Number of lines to show from the start (default: 5).
 * @param tailLines - Number of lines to show from the end (default: 5).
 * @returns Formatted preview string with line numbers.
 */
export function createContentPreview(
  contentStr: string,
  headLines: number = 5,
  tailLines: number = 5,
): string {
  const lines = contentStr.split("\n");

  if (lines.length <= headLines + tailLines) {
    // If file is small enough, show all lines
    const previewLines = lines.map((line) => line.substring(0, 1000));
    return formatContentWithLineNumbers(previewLines, 1);
  }

  // Show head and tail with truncation marker
  const head = lines.slice(0, headLines).map((line) => line.substring(0, 1000));
  const tail = lines.slice(-tailLines).map((line) => line.substring(0, 1000));

  const headSample = formatContentWithLineNumbers(head, 1);
  const truncationNotice = `\n... [${lines.length - headLines - tailLines} lines truncated] ...\n`;
  const tailSample = formatContentWithLineNumbers(
    tail,
    lines.length - tailLines + 1,
  );

  return headSample + truncationNotice + tailSample;
}

/**
 * required for type inference
 */
import type * as _zodTypes from "@langchain/core/utils/types";
import type * as _zodMeta from "@langchain/langgraph/zod";
import type * as _messages from "@langchain/core/messages";

/**
 * Zod v3 schema for FileData (re-export from backends)
 */
export const FileDataSchema = z.object({
  content: z.array(z.string()),
  created_at: z.string(),
  modified_at: z.string(),
});

/**
 * Type for the files state record.
 */
export type FilesRecord = Record<string, FileData>;

/**
 * Type for file updates, where null indicates deletion.
 */
export type FilesRecordUpdate = Record<string, FileData | null>;

/**
 * Reducer for files state that merges file updates with support for deletions.
 * When a file value is null, the file is deleted from state.
 * When a file value is non-null, it is added or updated in state.
 *
 * This reducer enables concurrent updates from parallel subagents by properly
 * merging their file changes instead of requiring LastValue semantics.
 *
 * @param current - The current files record (from state)
 * @param update - The new files record (from a subagent update), with null values for deletions
 * @returns Merged files record with deletions applied
 */
export function fileDataReducer(
  current: FilesRecord | undefined,
  update: FilesRecordUpdate | undefined,
): FilesRecord {
  // If no update, return current (or empty object)
  if (update === undefined) {
    return current || {};
  }

  // If no current, filter out null values from update
  if (current === undefined) {
    const result: FilesRecord = {};
    for (const [key, value] of Object.entries(update)) {
      if (value !== null) {
        result[key] = value;
      }
    }
    return result;
  }

  // Merge: apply updates and deletions
  const result = { ...current };
  for (const [key, value] of Object.entries(update)) {
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
 *
 * Uses ReducedValue for files to allow concurrent updates from parallel subagents.
 */
const FilesystemStateSchema = new StateSchema({
  files: new ReducedValue(
    z.record(z.string(), FileDataSchema).default(() => ({})),
    {
      inputSchema: z.record(z.string(), FileDataSchema.nullable()).optional(),
      reducer: fileDataReducer,
    },
  ),
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
const FILESYSTEM_SYSTEM_PROMPT = `## Filesystem Tools \`ls\`, \`read_file\`, \`write_file\`, \`edit_file\`, \`glob\`, \`grep\`

You have access to a filesystem which you can interact with using these tools.
All file paths must start with a /.

- ls: list files in a directory (requires absolute path)
- read_file: read a file from the filesystem
- write_file: write to a file in the filesystem
- edit_file: edit a file in the filesystem
- glob: find files matching a pattern (e.g., "**/*.py")
- grep: search for text within files`;

// Tool descriptions - ported from Python for comprehensive LLM guidance
export const LS_TOOL_DESCRIPTION = `Lists all files in a directory.

This is useful for exploring the filesystem and finding the right file to read or edit.
You should almost ALWAYS use this tool before using the read_file or edit_file tools.`;

export const READ_FILE_TOOL_DESCRIPTION = `Reads a file from the filesystem.

Assume this tool is able to read all files. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- By default, it reads up to 100 lines starting from the beginning of the file
- **IMPORTANT for large files and codebase exploration**: Use pagination with offset and limit parameters to avoid context overflow
  - First scan: read_file(path, limit=100) to see file structure
  - Read more sections: read_file(path, offset=100, limit=200) for next 200 lines
  - Only omit limit (read full file) when necessary for editing
- Specify offset and limit: read_file(path, offset=0, limit=100) reads first 100 lines
- Results are returned using cat -n format, with line numbers starting at 1
- Lines longer than 10,000 characters will be split into multiple lines with continuation markers (e.g., 5.1, 5.2, etc.). When you specify a limit, these continuation lines count towards the limit.
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
- You should ALWAYS make sure a file has been read before editing it.`;

export const WRITE_FILE_TOOL_DESCRIPTION = `Writes to a new file in the filesystem.

Usage:
- The write_file tool will create a new file.
- Prefer to edit existing files (with the edit_file tool) over creating new ones when possible.`;

export const EDIT_FILE_TOOL_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must read the file before editing. This tool will error if you attempt an edit without reading the file first.
- When editing, preserve the exact indentation (tabs/spaces) from the read output. Never include line number prefixes in old_string or new_string.
- ALWAYS prefer editing existing files over creating new ones.
- Only use emojis if the user explicitly requests it.`;

export const GLOB_TOOL_DESCRIPTION = `Find files matching a glob pattern.

Supports standard glob patterns: \`*\` (any characters), \`**\` (any directories), \`?\` (single character).
Returns a list of absolute file paths that match the pattern.

Examples:
- \`**/*.py\` - Find all Python files
- \`*.txt\` - Find all text files in root
- \`/subdir/**/*.md\` - Find all markdown files under /subdir`;

export const GREP_TOOL_DESCRIPTION = `Search for a text pattern across files.

Searches for literal text (not regex) and returns matching files or content based on output_mode.
Special characters like parentheses, brackets, pipes, etc. are treated as literal characters, not regex operators.

Examples:
- Search all files: \`grep(pattern="TODO")\`
- Search Python files only: \`grep(pattern="import", glob="*.py")\`
- Show matching lines: \`grep(pattern="error", output_mode="content")\`
- Search for code with special chars: \`grep(pattern="def __init__(self):")\``;
export const EXECUTE_TOOL_DESCRIPTION = `Executes a shell command in an isolated sandbox environment.

Usage:
Executes a given command in the sandbox environment with proper handling and security measures.
Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use the ls tool to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use ls to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")
   - Examples of proper quoting:
     - cd "/Users/name/My Documents" (correct)
     - cd /Users/name/My Documents (incorrect - will fail)
     - python "/path/with spaces/script.py" (correct)
     - python /path/with spaces/script.py (incorrect - will fail)
   - After ensuring proper quoting, execute the command
   - Capture the output of the command

Usage notes:
  - Commands run in an isolated sandbox environment
  - Returns combined stdout/stderr output with exit code
  - If the output is very large, it may be truncated
  - VERY IMPORTANT: You MUST avoid using search commands like find and grep. Instead use the grep, glob tools to search. You MUST avoid read tools like cat, head, tail, and use read_file to read files.
  - When issuing multiple commands, use the ';' or '&&' operator to separate them. DO NOT use newlines (newlines are ok in quoted strings)
    - Use '&&' when commands depend on each other (e.g., "mkdir dir && cd dir")
    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail
  - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of cd

Examples:
  Good examples:
    - execute(command="pytest /foo/bar/tests")
    - execute(command="python /path/to/script.py")
    - execute(command="npm install && npm test")

  Bad examples (avoid these):
    - execute(command="cd /foo/bar && pytest tests")  # Use absolute path instead
    - execute(command="cat file.txt")  # Use read_file tool instead
    - execute(command="find . -name '*.py'")  # Use glob tool instead
    - execute(command="grep -r 'pattern' .")  # Use grep tool instead

Note: This tool is only available if the backend supports execution (SandboxBackendProtocol).
If execution is not supported, the tool will return an error message.`;

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
  options: {
    customDescription: string | undefined;
    toolTokenLimitBeforeEvict: number | null;
  },
) {
  const { customDescription, toolTokenLimitBeforeEvict } = options;
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const {
        file_path,
        offset = DEFAULT_READ_LINE_OFFSET,
        limit = DEFAULT_READ_LINE_LIMIT,
      } = input;
      let result = await resolvedBackend.read(file_path, offset, limit);

      // Enforce line limit on result (in case backend returns more)
      const lines = result.split("\n");
      if (lines.length > limit) {
        result = lines.slice(0, limit).join("\n");
      }

      // Check if result exceeds token threshold and truncate if necessary
      if (
        toolTokenLimitBeforeEvict &&
        result.length >= NUM_CHARS_PER_TOKEN * toolTokenLimitBeforeEvict
      ) {
        // Calculate truncation message length to ensure final result stays under threshold
        const truncationMsg = READ_FILE_TRUNCATION_MSG.replace(
          "{file_path}",
          file_path,
        );
        const maxContentLength =
          NUM_CHARS_PER_TOKEN * toolTokenLimitBeforeEvict -
          truncationMsg.length;
        result = result.substring(0, maxContentLength) + truncationMsg;
      }

      return result;
    },
    {
      name: "read_file",
      description: customDescription || READ_FILE_TOOL_DESCRIPTION,
      schema: z.object({
        file_path: z.string().describe("Absolute path to the file to read"),
        offset: z.coerce
          .number()
          .optional()
          .default(DEFAULT_READ_LINE_OFFSET)
          .describe("Line offset to start reading from (0-indexed)"),
        limit: z.coerce
          .number()
          .optional()
          .default(DEFAULT_READ_LINE_LIMIT)
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
        content: z
          .string()
          .default("")
          .describe("Content to write to the file"),
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
      toolTokenLimitBeforeEvict,
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
      let filesystemPrompt = baseSystemPrompt;
      if (supportsExecution) {
        filesystemPrompt = `${filesystemPrompt}\n\n${EXECUTION_SYSTEM_PROMPT}`;
      }

      // Combine with existing system message
      const newSystemMessage = request.systemMessage.concat(filesystemPrompt);

      return handler({ ...request, tools, systemMessage: newSystemMessage });
    },
    wrapToolCall: async (request, handler) => {
      // Return early if eviction is disabled
      if (!toolTokenLimitBeforeEvict) {
        return handler(request);
      }

      // Check if this tool is excluded from eviction
      const toolName = request.toolCall?.name;
      if (
        toolName &&
        TOOLS_EXCLUDED_FROM_EVICTION.includes(
          toolName as (typeof TOOLS_EXCLUDED_FROM_EVICTION)[number],
        )
      ) {
        return handler(request);
      }

      const result = await handler(request);

      async function processToolMessage(
        msg: ToolMessage,
        toolTokenLimitBeforeEvict: number,
      ) {
        if (
          typeof msg.content === "string" &&
          msg.content.length > toolTokenLimitBeforeEvict * NUM_CHARS_PER_TOKEN
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

          // Create preview showing head and tail of the result
          const contentSample = createContentPreview(msg.content);
          const replacementText = TOO_LARGE_TOOL_MSG.replace(
            "{tool_call_id}",
            msg.tool_call_id,
          )
            .replace("{file_path}", evictPath)
            .replace("{content_sample}", contentSample);

          const truncatedMessage = new ToolMessage({
            content: replacementText,
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

      if (ToolMessage.isInstance(result)) {
        const processed = await processToolMessage(
          result,
          toolTokenLimitBeforeEvict,
        );

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
        const accumulatedFiles: Record<string, FileData> = update.files
          ? { ...update.files }
          : {};
        const processedMessages: ToolMessage[] = [];

        for (const msg of update.messages) {
          if (ToolMessage.isInstance(msg)) {
            const processed = await processToolMessage(
              msg,
              toolTokenLimitBeforeEvict,
            );
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
    },
  });
}
