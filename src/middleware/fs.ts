/**
 * Middleware for providing filesystem tools to an agent.
 *
 * Provides ls, read_file, write_file, and edit_file tools with support for:
 * - Short-term memory (ephemeral state)
 * - Long-term memory (persistent store)
 * - Tool result eviction for large outputs
 */

import { createMiddleware, tool, ToolMessage } from "langchain";
import {
  Command,
  getCurrentTaskInput,
  getConfig,
  isCommand,
} from "@langchain/langgraph";
import type { Item, Runtime } from "@langchain/langgraph";
import { z as z3 } from "zod/v3";
import { withLangGraph } from "@langchain/langgraph/zod";
import { RunnableConfig } from "@langchain/core/runnables";

const MEMORIES_PREFIX = "/memories/";
const EMPTY_CONTENT_WARNING =
  "System reminder: File exists but has empty contents";
const MAX_LINE_LENGTH = 2000;
const LINE_NUMBER_WIDTH = 6;
const DEFAULT_READ_OFFSET = 0;
const DEFAULT_READ_LIMIT = 2000;

/**
 * Zod v3 schema for FileData
 */
const FileDataSchema = z3.object({
  content: z3.array(z3.string()),
  created_at: z3.string(),
  modified_at: z3.string(),
});

export type FileData = z3.infer<typeof FileDataSchema>;

/**
 * Merge file updates with support for deletions.
 *
 * This reducer enables file deletion by treating `null` values in the right
 * dictionary as deletion markers. It's designed to work with LangGraph's
 * state management where annotated reducers control how state updates merge.
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
 * Validate and normalize file path for security.
 *
 * Ensures paths are safe to use by preventing directory traversal attacks
 * and enforcing consistent formatting. All paths are normalized to use
 * forward slashes and start with a leading slash.
 */
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
}

/**
 * Format file content with line numbers for display.
 *
 * Converts file content to a numbered format similar to `cat -n` output,
 * with support for two different formatting styles.
 */
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
- read_file: read a file from the filesystem
- write_file: write to a file in the filesystem
- edit_file: edit a file in the filesystem`;

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

/**
 * Generate the ls (list files) tool.
 */
function createLsTool(
  customDescription: string | null,
  longTermMemory: boolean,
) {
  let toolDescription = LIST_FILES_TOOL_DESCRIPTION;
  if (customDescription) {
    toolDescription = customDescription;
  } else if (longTermMemory) {
    toolDescription += LIST_FILES_TOOL_DESCRIPTION_LONGTERM_SUPPLEMENT;
  }

  return tool(
    async (input: { path?: string }, config) => {
      const state = getCurrentTaskInput<FsMiddlewareState>(config);
      const filesDict = state.files || {};
      let files = Object.keys(filesDict);

      if (longTermMemory) {
        assertStore(config);

        const namespace = getNamespace();
        const longtermFiles = await config.store.search(namespace);
        const longtermFilesPrefixed = longtermFiles.map((f) =>
          appendMemoriesPrefix(f.key),
        );
        files = files.concat(longtermFilesPrefixed);
      }

      // Filter by path if specified
      if (input.path) {
        const normalizedPath = validatePath(input.path);
        files = files.filter((f) => f.startsWith(normalizedPath));
      }

      return files;
    },
    {
      name: "ls",
      description: toolDescription,
      schema: z3.object({
        path: z3.string().optional().describe("Optional path to filter by"),
      }),
    },
  );
}

/**
 * Generate the read_file tool.
 */
function createReadFileTool(
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

  return tool(
    async (input, config) => {
      const filePath = validatePath(input.file_path);
      const offset = input.offset ?? DEFAULT_READ_OFFSET;
      const limit = input.limit ?? DEFAULT_READ_LIMIT;

      if (longTermMemory) {
        assertStore(config);

        if (hasMemoriesPrefix(filePath)) {
          const strippedFilePath = stripMemoriesPrefix(filePath);
          const namespace = getNamespace();
          const item = await config.store?.get(namespace, strippedFilePath);
          if (!item) return `Error: File '${filePath}' not found`;

          const fileData = convertStoreItemToFileData(item);
          return readFileDataContent(fileData, offset, limit);
        }
      }

      const state = getCurrentTaskInput<FsMiddlewareState>(config);
      const mockFilesystem = state.files || {};
      if (!(filePath in mockFilesystem)) {
        return `Error: File '${filePath}' not found`;
      }

      const fileData = mockFilesystem[filePath];
      return readFileDataContent(fileData, offset, limit);
    },
    {
      name: "read_file",
      description: toolDescription,
      schema: z3.object({
        file_path: z3.string().describe("Absolute path to the file to read"),
        offset: z3
          .number()
          .optional()
          .default(DEFAULT_READ_OFFSET)
          .describe("Line offset to start reading from"),
        limit: z3
          .number()
          .optional()
          .default(DEFAULT_READ_LIMIT)
          .describe("Maximum number of lines to read"),
      }),
    },
  );
}

/**
 * Generate the write_file tool.
 */
function createWriteFileTool(
  customDescription: string | null,
  longTermMemory: boolean,
) {
  let toolDescription = WRITE_FILE_TOOL_DESCRIPTION;
  if (customDescription) {
    toolDescription = customDescription;
  } else if (longTermMemory) {
    toolDescription += WRITE_FILE_TOOL_DESCRIPTION_LONGTERM_SUPPLEMENT;
  }

  return tool(
    async (input, config) => {
      const filePath = validatePath(input.file_path);

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
      }

      const state = getCurrentTaskInput<FsMiddlewareState>(config);
      const mockFilesystem = state.files || {};

      if (filePath in mockFilesystem) {
        return `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.`;
      }

      const newFileData = createFileData(input.content);
      return new Command({
        update: {
          files: { [filePath]: newFileData },
          messages: [
            new ToolMessage({
              content: `Updated file ${filePath}`,
              tool_call_id: config.toolCall?.id as string,
              name: "write_file",
            }),
          ],
        },
      });
    },
    {
      name: "write_file",
      description: toolDescription,
      schema: z3.object({
        file_path: z3.string().describe("Absolute path to the file to write"),
        content: z3.string().describe("Content to write to the file"),
      }),
    },
  );
}

/**
 * Generate the edit_file tool.
 */
function createEditFileTool(
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
      );

      if (typeof result === "string") {
        return result; // Error message
      }

      const { fileData: newFileData, message: resultMsg } = result;
      const fullMsg = `${resultMsg} in '${filePath}'`;

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
      }

      return new Command({
        update: {
          files: { [filePath]: newFileData },
          messages: [
            new ToolMessage({
              content: fullMsg,
              tool_call_id: config.toolCall?.id as string,
              name: "edit_file",
            }),
          ],
        },
      });
    },
    {
      name: "edit_file",
      description: toolDescription,
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
 * Options for creating filesystem middleware.
 */
export interface FilesystemMiddlewareOptions {
  /** Whether to enable longterm memory support */
  longTermMemory?: boolean;
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
    longTermMemory = false,
    systemPrompt: customSystemPrompt = null,
    customToolDescriptions = null,
    toolTokenLimitBeforeEvict = 20000,
  } = options;

  let systemPrompt = FILESYSTEM_SYSTEM_PROMPT;
  if (customSystemPrompt !== null) {
    systemPrompt = customSystemPrompt;
  } else if (longTermMemory) {
    systemPrompt += FILESYSTEM_SYSTEM_PROMPT_LONGTERM_SUPPLEMENT;
  }

  const tools = [
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
  ];

  return createMiddleware({
    name: "fsMiddleware",
    stateSchema,
    tools,
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
        }
      } else if (isCommand(result) && result.update) {
        // Handle Command results with messages
        const update = result.update as Record<string, unknown>;
        const messageUpdates = (update.messages as unknown[]) || [];
        const fileUpdates = (update.files as Record<string, FileData>) || {};

        const editedMessageUpdates = [];
        for (const message of messageUpdates) {
          if (
            toolTokenLimitBeforeEvict &&
            message instanceof ToolMessage &&
            typeof message.content === "string"
          ) {
            const contentLength = message.content.length;
            if (contentLength > 4 * toolTokenLimitBeforeEvict) {
              const filePath = `/large_tool_results/${message.tool_call_id}`;
              const fileData = createFileData(message.content);

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
            }
          }
          editedMessageUpdates.push(message);
        }

        return new Command({
          update: {
            ...update,
            messages: editedMessageUpdates,
            files: fileUpdates,
          },
        });
      }

      return result;
    },
    // // Validate store availability if longterm memory is enabled
    // beforeAgent: () => {
    //   if (longTermMemory === true && !store) {
    //     throw new Error(
    //       "Longterm memory is enabled, but no store is available"
    //     );
    //   }
    //   return;
    // },
  });
}

export const fsMiddleware = createFilesystemMiddleware();
export { createFilesystemMiddleware as FilesystemMiddleware };
export {
  WRITE_FILE_TOOL_DESCRIPTION,
  WRITE_FILE_TOOL_DESCRIPTION_LONGTERM_SUPPLEMENT,
};
