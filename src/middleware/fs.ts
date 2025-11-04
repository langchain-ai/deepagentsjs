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
  ToolCallRequest,
  ToolCallHandler,
} from "langchain";
import { Command, isCommand, getCurrentTaskInput } from "@langchain/langgraph";
import { z as z3 } from "zod/v3";
import { withLangGraph } from "@langchain/langgraph/zod";
import type {
  BackendProtocol,
  BackendFactory,
  FileData,
  StateAndStore,
} from "../backends/protocol.js";
import { StateBackend } from "../backends/state.js";
import { sanitizeToolCallId } from "../backends/utils.js";

/**
 * Zod v3 schema for FileData (re-export from backends)
 */
const FileDataSchema = z3.object({
  content: z3.array(z3.string()),
  created_at: z3.string(),
  modified_at: z3.string(),
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
 * Resolve backend from factory or instance.
 *
 * @param backend - Backend instance or factory function
 * @param stateAndStore - State and store container for backend initialization
 */
<<<<<<< HEAD
function getBackend(
  backend: BackendProtocol | BackendFactory,
  stateAndStore: StateAndStore
): BackendProtocol {
  if (typeof backend === "function") {
    return backend(stateAndStore);
  }
  return backend;
=======
function validatePath(
  path: string,
  options?: { allowedPrefixes?: string[] },
): string {
  if (path.includes("..") || path.startsWith("~")) {
    throw new Error(`Path traversal not allowed: ${path}`);
  }

  let normalized = path
    .replace(/\/+/g, "/")
    .replace(/\/\./g, "/")
    .replace(/\\/g, "/");

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  if (options?.allowedPrefixes) {
    const hasAllowedPrefix = options.allowedPrefixes.some((prefix) =>
      normalized.startsWith(prefix),
    );
    if (!hasAllowedPrefix) {
      throw new Error(
        `Path must start with one of ${options.allowedPrefixes.join(", ")}: ${path}`,
      );
    }
  }

  return normalized;
>>>>>>> origin/nh/v1
}

/**
 * Helper to await if Promise, otherwise return value directly.
 */
<<<<<<< HEAD
async function awaitIfPromise<T>(value: T | Promise<T>): Promise<T> {
  return value;
}

// System prompts
const FILESYSTEM_SYSTEM_PROMPT = `You have access to a virtual filesystem. All file paths must start with a /.

- ls: list files in a directory (requires absolute path)
=======
function formatContentWithLineNumbers(
  content: string | string[],
  options: {
    formatStyle?: "pipe" | "tab";
    startLine?: number;
  } = {},
): string {
  const { formatStyle = "pipe", startLine = 1 } = options;

  let lines: string[];
  if (typeof content === "string") {
    lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
  } else {
    lines = content;
  }

  if (formatStyle === "pipe") {
    return lines.map((line, i) => `${i + startLine}|${line}`).join("\n");
  }

  return lines
    .map(
      (line, i) =>
        `${(i + startLine).toString().padStart(LINE_NUMBER_WIDTH)}\t${line.slice(0, MAX_LINE_LENGTH)}`,
    )
    .join("\n");
}

/**
 * Create a FileData object with automatic timestamp generation.
 */
function createFileData(
  content: string | string[],
  options?: { createdAt?: string },
): FileData {
  const lines = typeof content === "string" ? content.split("\n") : content;
  const now = new Date().toISOString();

  return {
    content: lines,
    created_at: options?.createdAt || now,
    modified_at: now,
  };
}

/**
 * Update FileData with new content while preserving creation timestamp.
 */
function updateFileData(
  fileData: FileData,
  content: string | string[],
): FileData {
  const lines = typeof content === "string" ? content.split("\n") : content;
  const now = new Date().toISOString();

  return {
    content: lines,
    created_at: fileData.created_at,
    modified_at: now,
  };
}

/**
 * Convert FileData to plain string content.
 */
function fileDataToString(fileData: FileData): string {
  return fileData.content.join("\n");
}

/**
 * Check if file content is empty and return a warning message.
 */
function checkEmptyContent(content: string): string | null {
  if (!content || content.trim() === "") {
    return EMPTY_CONTENT_WARNING;
  }
  return null;
}

/**
 * Check if a file path is in the longterm memory filesystem.
 */
function hasMemoriesPrefix(filePath: string): boolean {
  return filePath.startsWith(MEMORIES_PREFIX);
}

/**
 * Add the longterm memory prefix to a file path.
 */
function appendMemoriesPrefix(filePath: string): string {
  return `/memories${filePath}`;
}

/**
 * Remove the longterm memory prefix from a file path.
 */
function stripMemoriesPrefix(filePath: string): string {
  if (filePath.startsWith(MEMORIES_PREFIX)) {
    return filePath.slice(MEMORIES_PREFIX.length - 1); // Keep the leading slash
  }
  return filePath;
}

/**
 * Get the namespace for longterm filesystem storage.
 *
 * Returns a tuple for organizing files in the store. If an assistant_id is available
 * in the config metadata, returns a 2-tuple of (assistant_id, "filesystem") to provide
 * per-assistant isolation. Otherwise, returns a 1-tuple of ("filesystem",) for shared storage.
 *
 * @returns Namespace tuple for store operations, either [assistant_id, "filesystem"] or ["filesystem"]
 */
function getNamespace(): [string] | [string, string] {
  const namespace = "filesystem";
  try {
    const config = getConfig();
    if (!config) {
      return [namespace];
    }
    const assistantId = config.metadata?.assistant_id as string | undefined;
    if (!assistantId) {
      return [namespace];
    }
    return [assistantId, namespace];
  } catch {
    return [namespace];
  }
}

/**
 * Convert a store Item to FileData format.
 */
function convertStoreItemToFileData(storeItem: Item): FileData {
  const value = storeItem.value as Record<string, unknown>;

  if (!Array.isArray(value.content)) {
    throw new Error(
      `Store item does not contain valid content field. Got: ${Object.keys(value).join(", ")}`,
    );
  }
  if (typeof value.created_at !== "string") {
    throw new Error(
      `Store item does not contain valid created_at field. Got: ${Object.keys(value).join(", ")}`,
    );
  }
  if (typeof value.modified_at !== "string") {
    throw new Error(
      `Store item does not contain valid modified_at field. Got: ${Object.keys(value).join(", ")}`,
    );
  }

  return {
    content: value.content as string[],
    created_at: value.created_at,
    modified_at: value.modified_at,
  };
}

/**
 * Convert FileData to a dict suitable for store.put().
 */
function convertFileDataToStoreItem(
  fileData: FileData,
): Record<string, unknown> {
  return {
    content: fileData.content,
    created_at: fileData.created_at,
    modified_at: fileData.modified_at,
  };
}

const stateSchema = z3.object({
  files: withLangGraph(
    z3.record(z3.string(), FileDataSchema).default(() => ({})),
    {
      reducer: {
        fn: fileDataReducer,
        schema: z3.record(z3.string(), FileDataSchema.nullable()),
      },
    },
  ),
});

export type FsMiddlewareState = z3.infer<typeof stateSchema>;

const LIST_FILES_TOOL_DESCRIPTION = `Lists all files in the filesystem, optionally filtering by directory.

Usage:
- The ls tool will return a list of all files in the filesystem.
- You can optionally provide a path parameter to list files in a specific directory.
- This is very useful for exploring the file system and finding the right file to read or edit.
- You should almost ALWAYS use this tool before using the read_file or edit_file tools.`;

const LIST_FILES_TOOL_DESCRIPTION_LONGTERM_SUPPLEMENT = `\n- Files from the longterm filesystem will be prefixed with the ${MEMORIES_PREFIX} path.`;

const READ_FILE_TOOL_DESCRIPTION = `Reads a file from the filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Any lines longer than 2000 characters will be truncated
- Results are returned using cat -n format, with line numbers starting at 1
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
- You should ALWAYS make sure a file has been read before editing it.`;

const READ_FILE_TOOL_DESCRIPTION_LONGTERM_SUPPLEMENT = `\n- file_paths prefixed with the ${MEMORIES_PREFIX} path will be read from the longterm filesystem.`;

const EDIT_FILE_TOOL_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use your read_file tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from read_file tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`;

const EDIT_FILE_TOOL_DESCRIPTION_LONGTERM_SUPPLEMENT = `\n- You can edit files in the longterm filesystem by prefixing the filename with the ${MEMORIES_PREFIX} path.`;

const WRITE_FILE_TOOL_DESCRIPTION = `Writes to a new file in the filesystem.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- The content parameter must be a string
- The write_file tool will create a new file.
- Prefer to edit existing files over creating new ones when possible.`;

const WRITE_FILE_TOOL_DESCRIPTION_LONGTERM_SUPPLEMENT = `\n- file_paths prefixed with the ${MEMORIES_PREFIX} path will be written to the longterm filesystem.`;

const FILESYSTEM_SYSTEM_PROMPT = `## Filesystem Tools \`ls\`, \`read_file\`, \`write_file\`, \`edit_file\`

You have access to a filesystem which you can interact with using these tools.
All file paths must start with a /.

- ls: list all files in the filesystem
>>>>>>> origin/nh/v1
- read_file: read a file from the filesystem
- write_file: write to a file in the filesystem
- edit_file: edit a file in the filesystem
- glob: find files matching a pattern (e.g., "**/*.py")
- grep: search for text within files`;

<<<<<<< HEAD
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
=======
const FILESYSTEM_SYSTEM_PROMPT_LONGTERM_SUPPLEMENT = `

You also have access to a longterm filesystem in which you can store files that you want to keep around for longer than the current conversation.
In order to interact with the longterm filesystem, you can use those same tools, but filenames must be prefixed with the ${MEMORIES_PREFIX} path.
Remember, to interact with the longterm filesystem, you must prefix the filename with the ${MEMORIES_PREFIX} path.`;

const TOO_LARGE_TOOL_MSG = `Tool result too large, the result of this tool call {tool_call_id} was saved in the filesystem at this path: {file_path}
You can read the result from the filesystem by using the read_file tool, but make sure to only read part of the result at a time.
You can do this by specifying an offset and limit in the read_file tool call.
For example, to read the first 100 lines, you can use the read_file tool with offset=0 and limit=100.

Here are the first 10 lines of the result:
{content_sample}
`;

function assertStore(
  config: RunnableConfig,
): asserts config is RunnableConfig & {
  store: Exclude<Runtime["store"], undefined>;
} {
  if (!("store" in config) || config.store == null) {
    throw new Error("Missing store when long term memory is enabled");
  }
}
>>>>>>> origin/nh/v1

/**
 * Create ls tool using backend.
 */
function createLsTool(
<<<<<<< HEAD
  backend: BackendProtocol | BackendFactory,
  customDescription: string | null
=======
  customDescription: string | null,
  longTermMemory: boolean,
>>>>>>> origin/nh/v1
) {
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const path = input.path || "/";
      const infos = await awaitIfPromise(resolvedBackend.lsInfo(path));

<<<<<<< HEAD
      if (infos.length === 0) {
        return `No files found in ${path}`;
=======
      if (longTermMemory) {
        assertStore(config);

        const namespace = getNamespace();
        const longtermFiles = await config.store.search(namespace);
        const longtermFilesPrefixed = longtermFiles.map((f) =>
          appendMemoriesPrefix(f.key),
        );
        files = files.concat(longtermFilesPrefixed);
>>>>>>> origin/nh/v1
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
      schema: z3.object({
        path: z3
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
<<<<<<< HEAD
  backend: BackendProtocol | BackendFactory,
  customDescription: string | null
) {
=======
  customDescription: string | null,
  longTermMemory: boolean,
) {
  let toolDescription = READ_FILE_TOOL_DESCRIPTION;
  if (customDescription) {
    toolDescription = customDescription;
  } else if (longTermMemory) {
    toolDescription += READ_FILE_TOOL_DESCRIPTION_LONGTERM_SUPPLEMENT;
  }

  function readFileDataContent(
    fileData: FileData,
    offset: number,
    limit: number,
  ): string {
    const content = fileDataToString(fileData);
    const emptyMsg = checkEmptyContent(content);
    if (emptyMsg) {
      return emptyMsg;
    }

    const lines = content.split("\n");
    const startIdx = offset;
    const endIdx = Math.min(startIdx + limit, lines.length);

    if (startIdx >= lines.length) {
      return `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`;
    }

    const selectedLines = lines.slice(startIdx, endIdx);
    return formatContentWithLineNumbers(selectedLines, {
      formatStyle: "tab",
      startLine: startIdx + 1,
    });
  }

>>>>>>> origin/nh/v1
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const { file_path, offset = 0, limit = 2000 } = input;
      return await awaitIfPromise(
        resolvedBackend.read(file_path, offset, limit)
      );
    },
    {
      name: "read_file",
      description: customDescription || READ_FILE_TOOL_DESCRIPTION,
      schema: z3.object({
        file_path: z3.string().describe("Absolute path to the file to read"),
        offset: z3
          .number()
          .optional()
          .default(0)
          .describe("Line offset to start reading from (0-indexed)"),
        limit: z3
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
<<<<<<< HEAD
  backend: BackendProtocol | BackendFactory,
  customDescription: string | null
=======
  customDescription: string | null,
  longTermMemory: boolean,
>>>>>>> origin/nh/v1
) {
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const { file_path, content } = input;
      const result = await awaitIfPromise(
        resolvedBackend.write(file_path, content)
      );

<<<<<<< HEAD
      if (result.error) {
        return result.error;
=======
      if (longTermMemory) {
        assertStore(config);

        if (hasMemoriesPrefix(filePath)) {
          const strippedFilePath = stripMemoriesPrefix(filePath);
          const namespace = getNamespace();
          const existing = await config.store.get(namespace, strippedFilePath);
          if (existing) {
            return `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.`;
          }
          const newFileData = createFileData(input.content);
          await config.store.put(
            namespace,
            strippedFilePath,
            convertFileDataToStoreItem(newFileData),
          );
          return `Updated longterm memories file ${filePath}`;
        }
>>>>>>> origin/nh/v1
      }

      // If filesUpdate is present, return Command to update state
      if (result.filesUpdate) {
        return new Command({
          update: {
            files: result.filesUpdate,
            messages: [
              new ToolMessage({
                content: `Successfully wrote to '${file_path}'`,
                tool_call_id: config.toolCall?.id as string,
                name: "write_file",
              }),
            ],
          },
        });
      }

      // External storage (filesUpdate is null)
      return `Successfully wrote to '${file_path}'`;
    },
    {
      name: "write_file",
      description: customDescription || WRITE_FILE_TOOL_DESCRIPTION,
      schema: z3.object({
        file_path: z3.string().describe("Absolute path to the file to write"),
        content: z3.string().describe("Content to write to the file"),
      }),
    },
  );
}

/**
 * Create edit_file tool using backend.
 */
function createEditFileTool(
<<<<<<< HEAD
  backend: BackendProtocol | BackendFactory,
  customDescription: string | null
) {
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const { file_path, old_string, new_string, replace_all = false } = input;
      const result = await awaitIfPromise(
        resolvedBackend.edit(file_path, old_string, new_string, replace_all)
=======
  customDescription: string | null,
  longTermMemory: boolean,
) {
  let toolDescription = EDIT_FILE_TOOL_DESCRIPTION;
  if (customDescription) {
    toolDescription = customDescription;
  } else if (longTermMemory) {
    toolDescription += EDIT_FILE_TOOL_DESCRIPTION_LONGTERM_SUPPLEMENT;
  }

  function performFileEdit(
    fileData: FileData,
    oldString: string,
    newString: string,
    replaceAll: boolean,
  ): { fileData: FileData; message: string } | string {
    const content = fileDataToString(fileData);
    const occurrences = (
      content.match(
        new RegExp(oldString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      ) || []
    ).length;

    if (occurrences === 0) {
      return `Error: String not found in file: '${oldString}'`;
    }

    if (occurrences > 1 && !replaceAll) {
      return `Error: String '${oldString}' appears ${occurrences} times in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.`;
    }

    const newContent = content.replace(
      new RegExp(
        oldString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        replaceAll ? "g" : "",
      ),
      newString,
    );
    const newFileData = updateFileData(fileData, newContent);
    const resultMsg = `Successfully replaced ${occurrences} instance(s) of the string`;

    return { fileData: newFileData, message: resultMsg };
  }

  return tool(
    async (input, config) => {
      const filePath = validatePath(input.file_path);
      const replaceAll = input.replace_all ?? false;

      const fileData: FileData | string = await (async () => {
        if (longTermMemory) {
          assertStore(config);

          if (hasMemoriesPrefix(filePath)) {
            const strippedFilePath = stripMemoriesPrefix(filePath);
            const namespace = getNamespace();
            const item = await config.store.get(namespace, strippedFilePath);
            if (!item) return `Error: File '${filePath}' not found`;
            return convertStoreItemToFileData(item);
          }
        }

        const state = getCurrentTaskInput<FsMiddlewareState>(config);
        const mockFilesystem = state.files || {};
        if (!(filePath in mockFilesystem))
          return `Error: File '${filePath}' not found`;
        return mockFilesystem[filePath] as FileData;
      })();

      if (typeof fileData === "string") return fileData; // Error message

      // Perform the edit
      const result = performFileEdit(
        fileData,
        input.old_string,
        input.new_string,
        replaceAll,
>>>>>>> origin/nh/v1
      );

      if (result.error) {
        return result.error;
      }

      const message = `Successfully replaced ${result.occurrences} occurrence(s) in '${file_path}'`;

<<<<<<< HEAD
      // If filesUpdate is present, return Command to update state
      if (result.filesUpdate) {
        return new Command({
          update: {
            files: result.filesUpdate,
            messages: [
              new ToolMessage({
                content: message,
                tool_call_id: config.toolCall?.id as string,
                name: "edit_file",
              }),
            ],
          },
        });
=======
      if (longTermMemory) {
        assertStore(config);

        if (hasMemoriesPrefix(filePath)) {
          const strippedFilePath = stripMemoriesPrefix(filePath);
          const namespace = getNamespace();
          await config.store.put(
            namespace,
            strippedFilePath,
            convertFileDataToStoreItem(newFileData),
          );
          return fullMsg;
        }
>>>>>>> origin/nh/v1
      }

      // External storage (filesUpdate is null)
      return message;
    },
    {
      name: "edit_file",
      description: customDescription || EDIT_FILE_TOOL_DESCRIPTION,
      schema: z3.object({
        file_path: z3.string().describe("Absolute path to the file to edit"),
        old_string: z3
          .string()
          .describe("String to be replaced (must match exactly)"),
        new_string: z3.string().describe("String to replace with"),
        replace_all: z3
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
  customDescription: string | null
) {
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const { pattern, path = "/" } = input;
      const infos = await awaitIfPromise(
        resolvedBackend.globInfo(pattern, path)
      );

      if (infos.length === 0) {
        return `No files found matching pattern '${pattern}'`;
      }

      return infos.map((info) => info.path).join("\n");
    },
    {
      name: "glob",
      description: customDescription || GLOB_TOOL_DESCRIPTION,
      schema: z3.object({
        pattern: z3.string().describe("Glob pattern (e.g., '*.py', '**/*.ts')"),
        path: z3
          .string()
          .optional()
          .default("/")
          .describe("Base path to search from (default: /)"),
      }),
    }
  );
}

/**
 * Create grep tool using backend.
 */
function createGrepTool(
  backend: BackendProtocol | BackendFactory,
  customDescription: string | null
) {
  return tool(
    async (input, config) => {
      const stateAndStore: StateAndStore = {
        state: getCurrentTaskInput(config),
        store: (config as any).store,
      };
      const resolvedBackend = getBackend(backend, stateAndStore);
      const { pattern, path = "/", glob = null } = input;
      const result = await awaitIfPromise(
        resolvedBackend.grepRaw(pattern, path, glob)
      );

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
      schema: z3.object({
        pattern: z3.string().describe("Regex pattern to search for"),
        path: z3
          .string()
          .optional()
          .default("/")
          .describe("Base path to search from (default: /)"),
        glob: z3
          .string()
          .optional()
          .nullable()
          .describe("Optional glob pattern to filter files (e.g., '*.py')"),
      }),
    }
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

  const systemPrompt = customSystemPrompt || FILESYSTEM_SYSTEM_PROMPT;

  const tools = [
<<<<<<< HEAD
    createLsTool(backend, customToolDescriptions?.ls ?? null),
    createReadFileTool(backend, customToolDescriptions?.read_file ?? null),
    createWriteFileTool(backend, customToolDescriptions?.write_file ?? null),
    createEditFileTool(backend, customToolDescriptions?.edit_file ?? null),
    createGlobTool(backend, customToolDescriptions?.glob ?? null),
    createGrepTool(backend, customToolDescriptions?.grep ?? null),
=======
    createLsTool(customToolDescriptions?.ls ?? null, longTermMemory),
    createReadFileTool(
      customToolDescriptions?.read_file ?? null,
      longTermMemory,
    ),
    createWriteFileTool(
      customToolDescriptions?.write_file ?? null,
      longTermMemory,
    ),
    createEditFileTool(
      customToolDescriptions?.edit_file ?? null,
      longTermMemory,
    ),
>>>>>>> origin/nh/v1
  ];

  const FilesystemStateSchema = z3.object({
    files: withLangGraph(z3.record(z3.string(), FileDataSchema).default({}), {
      reducer: {
        fn: fileDataReducer,
        schema: z3.record(z3.string(), FileDataSchema.nullable()),
      },
    }),
  });

  return createMiddleware({
    name: "FilesystemMiddleware",
    stateSchema: FilesystemStateSchema as any,
    tools,
<<<<<<< HEAD
    wrapModelCall: systemPrompt
      ? async (request, handler: any) => {
          const currentSystemPrompt = request.systemPrompt || "";
          const newSystemPrompt = currentSystemPrompt
            ? `${currentSystemPrompt}\n\n${systemPrompt}`
            : systemPrompt;
          return handler({ ...request, systemPrompt: newSystemPrompt });
=======
    // Add filesystem system prompt to model calls
    wrapModelCall: async (request, handler) => {
      const currentSystemPrompt = request.systemPrompt || "";
      const newSystemPrompt = currentSystemPrompt
        ? `${currentSystemPrompt}\n\n${systemPrompt}`
        : systemPrompt;

      return handler({
        ...request,
        systemPrompt: newSystemPrompt,
      });
    },
    // Intercept tool calls to evict large results to filesystem
    wrapToolCall: async (request, handler) => {
      const filesystemToolNames = [
        "ls",
        "read_file",
        "write_file",
        "edit_file",
      ];
      if (
        !toolTokenLimitBeforeEvict ||
        filesystemToolNames.includes(request.tool.name as string)
      ) {
        return handler(request);
      }

      const result = await handler(request);

      // Check if result is too large and evict to filesystem
      if (
        ToolMessage.isInstance(result) &&
        typeof result.content === "string"
      ) {
        const contentLength = result.content.length;
        // Approximate: 4 chars per token
        if (contentLength > 4 * toolTokenLimitBeforeEvict) {
          const filePath = `/large_tool_results/${request.toolCall.id}`;
          const fileData = createFileData(result.content);

          // Format first 10 lines as sample
          const firstTenLines = fileData.content.slice(0, 10);
          const contentSample = formatContentWithLineNumbers(firstTenLines, {
            formatStyle: "tab",
            startLine: 1,
          });

          const evictedMessage = TOO_LARGE_TOOL_MSG.replace(
            "{tool_call_id}",
            request.toolCall.id || "",
          )
            .replace("{file_path}", filePath)
            .replace("{content_sample}", contentSample);

          return new Command({
            update: {
              messages: [
                new ToolMessage({
                  content: evictedMessage,
                  tool_call_id: request.toolCall.id || "",
                  name: request.tool.name as string,
                }),
              ],
              files: { [filePath]: fileData },
            },
          });
>>>>>>> origin/nh/v1
        }
      : undefined,
    wrapToolCall: toolTokenLimitBeforeEvict
      ? ((async (request: any, handler: any) => {
          const result = await handler(request);

          async function processToolMessage(msg: ToolMessage) {
            if (
              typeof msg.content === "string" &&
              msg.content.length > toolTokenLimitBeforeEvict! * 4
            ) {
              // Build StateAndStore from request
              const stateAndStore: StateAndStore = {
                state: request.state || {},
                store: request.config?.store,
              };
              const resolvedBackend = getBackend(backend, stateAndStore);
              const sanitizedId = sanitizeToolCallId(
                request.toolCall?.id || msg.tool_call_id
              );
              const evictPath = `/large_tool_results/${sanitizedId}`;

<<<<<<< HEAD
              const writeResult = await awaitIfPromise(
                resolvedBackend.write(evictPath, msg.content)
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
=======
              const firstTenLines = fileData.content.slice(0, 10);
              const contentSample = formatContentWithLineNumbers(
                firstTenLines,
                {
                  formatStyle: "tab",
                  startLine: 1,
                },
              );

              const evictedMessage = TOO_LARGE_TOOL_MSG.replace(
                "{tool_call_id}",
                message.tool_call_id || "",
              )
                .replace("{file_path}", filePath)
                .replace("{content_sample}", contentSample);

              editedMessageUpdates.push(
                new ToolMessage({
                  content: evictedMessage,
                  tool_call_id: message.tool_call_id || "",
                  name: message.name || "",
                }),
              );
              fileUpdates[filePath] = fileData;
              continue;
>>>>>>> origin/nh/v1
            }
          }

          return result;
        }) as any)
      : undefined,
  });
}
