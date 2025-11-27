import * as langchain0 from "langchain";
import { AgentMiddleware, AgentMiddleware as AgentMiddleware$1, InterruptOnConfig, ReactAgent, StructuredTool } from "langchain";
import { AnnotationRoot } from "@langchain/langgraph";
import { StructuredTool as StructuredTool$1 } from "@langchain/core/tools";
import { BaseLanguageModel, LanguageModelLike } from "@langchain/core/language_models/base";
import { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph-checkpoint";
import { InteropZodObject } from "@langchain/core/utils/types";

//#region src/backends/protocol.d.ts

/**
 * Structured file listing info.
 *
 * Minimal contract used across backends. Only "path" is required.
 * Other fields are best-effort and may be absent depending on backend.
 */
interface FileInfo {
  /** File path */
  path: string;
  /** Whether this is a directory */
  is_dir?: boolean;
  /** File size in bytes (approximate) */
  size?: number;
  /** ISO 8601 timestamp of last modification */
  modified_at?: string;
}
/**
 * Structured grep match entry.
 */
interface GrepMatch {
  /** File path where match was found */
  path: string;
  /** Line number (1-indexed) */
  line: number;
  /** The matching line text */
  text: string;
}
/**
 * File data structure used by backends.
 *
 * All file data is represented as objects with this structure:
 */
interface FileData {
  /** Lines of text content */
  content: string[];
  /** ISO format timestamp of creation */
  created_at: string;
  /** ISO format timestamp of last modification */
  modified_at: string;
}
/**
 * Result from backend write operations.
 *
 * Checkpoint backends populate filesUpdate with {file_path: file_data} for LangGraph state.
 * External backends set filesUpdate to null (already persisted to disk/S3/database/etc).
 */
interface WriteResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** File path of written file, undefined on failure */
  path?: string;
  /**
   * State update dict for checkpoint backends, null for external storage.
   * Checkpoint backends populate this with {file_path: file_data} for LangGraph state.
   * External backends set null (already persisted to disk/S3/database/etc).
   */
  filesUpdate?: Record<string, FileData> | null;
}
/**
 * Result from backend edit operations.
 *
 * Checkpoint backends populate filesUpdate with {file_path: file_data} for LangGraph state.
 * External backends set filesUpdate to null (already persisted to disk/S3/database/etc).
 */
interface EditResult {
  /** Error message on failure, undefined on success */
  error?: string;
  /** File path of edited file, undefined on failure */
  path?: string;
  /**
   * State update dict for checkpoint backends, null for external storage.
   * Checkpoint backends populate this with {file_path: file_data} for LangGraph state.
   * External backends set null (already persisted to disk/S3/database/etc).
   */
  filesUpdate?: Record<string, FileData> | null;
  /** Number of replacements made, undefined on failure */
  occurrences?: number;
}
/**
 * Protocol for pluggable memory backends (single, unified).
 *
 * Backends can store files in different locations (state, filesystem, database, etc.)
 * and provide a uniform interface for file operations.
 *
 * All file data is represented as objects with the FileData structure.
 *
 * Methods can return either direct values or Promises, allowing both
 * synchronous and asynchronous implementations.
 */
interface BackendProtocol {
  /**
   * Structured listing with file metadata.
   *
   * Lists files and directories in the specified directory (non-recursive).
   * Directories have a trailing / in their path and is_dir=true.
   *
   * @param path - Absolute path to directory
   * @returns List of FileInfo objects for files and directories directly in the directory
   */
  lsInfo(path: string): FileInfo[] | Promise<FileInfo[]>;
  /**
   * Read file content with line numbers or an error string.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed), default 0
   * @param limit - Maximum number of lines to read, default 2000
   * @returns Formatted file content with line numbers, or error message
   */
  read(filePath: string, offset?: number, limit?: number): string | Promise<string>;
  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns Raw file content as FileData
   */
  readRaw(filePath: string): FileData | Promise<FileData>;
  /**
   * Structured search results or error string for invalid input.
   *
   * Searches file contents for a regex pattern.
   *
   * @param pattern - Regex pattern to search for
   * @param path - Base path to search from (default: null)
   * @param glob - Optional glob pattern to filter files (e.g., "*.py")
   * @returns List of GrepMatch objects or error string for invalid regex
   */
  grepRaw(pattern: string, path?: string | null, glob?: string | null): GrepMatch[] | string | Promise<GrepMatch[] | string>;
  /**
   * Structured glob matching returning FileInfo objects.
   *
   * @param pattern - Glob pattern (e.g., `*.py`, `**\/*.ts`)
   * @param path - Base path to search from (default: "/")
   * @returns List of FileInfo objects matching the pattern
   */
  globInfo(pattern: string, path?: string): FileInfo[] | Promise<FileInfo[]>;
  /**
   * Create a new file.
   *
   * @param filePath - Absolute file path
   * @param content - File content as string
   * @returns WriteResult with error populated on failure
   */
  write(filePath: string, content: string): WriteResult | Promise<WriteResult>;
  /**
   * Edit a file by replacing string occurrences.
   *
   * @param filePath - Absolute file path
   * @param oldString - String to find and replace
   * @param newString - Replacement string
   * @param replaceAll - If true, replace all occurrences (default: false)
   * @returns EditResult with error, path, filesUpdate, and occurrences
   */
  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): EditResult | Promise<EditResult>;
}
/**
 * State and store container for backend initialization.
 *
 * This provides a clean interface for what backends need to access:
 * - state: Current agent state (with files, messages, etc.)
 * - store: Optional persistent store for cross-conversation data
 *
 * Different contexts build this differently:
 * - Tools: Extract state via getCurrentTaskInput(config)
 * - Middleware: Use request.state directly
 */
interface StateAndStore {
  /** Current agent state with files, messages, etc. */
  state: unknown;
  /** Optional BaseStore for persistent cross-conversation storage */
  store?: BaseStore;
  /** Optional assistant ID for per-assistant isolation in store */
  assistantId?: string;
}
/**
 * Factory function type for creating backend instances.
 *
 * Backends receive StateAndStore which contains the current state
 * and optional store, extracted from the execution context.
 *
 * @example
 * ```typescript
 * // Using in middleware
 * const middleware = createFilesystemMiddleware({
 *   backend: (stateAndStore) => new StateBackend(stateAndStore)
 * });
 * ```
 */
type BackendFactory = (stateAndStore: StateAndStore) => BackendProtocol;
//#endregion
//#region src/middleware/fs.d.ts
type FilesystemEventResponse = {
  kind: "raw-contents";
} | {
  kind: "metadata";
  data: Record<string, unknown>;
};
interface FilesystemEvents {
  onWrite?: (path: string, backend: BackendProtocol) => void | FilesystemEventResponse | Promise<void | FilesystemEventResponse>;
}
/**
 * Options for creating filesystem middleware.
 */
interface FilesystemMiddlewareOptions {
  /** Backend instance or factory (default: StateBackend) */
  backend?: BackendProtocol | BackendFactory;
  /** Optional custom system prompt override */
  systemPrompt?: string | null;
  /** Optional custom tool descriptions override */
  customToolDescriptions?: Record<string, string> | null;
  /** Optional token limit before evicting a tool result to the filesystem (default: 20000 tokens, ~80KB) */
  toolTokenLimitBeforeEvict?: number | null;
  /** Filesystem events callbacks */
  events?: FilesystemEvents;
}
/**
 * Create filesystem middleware with all tools and features.
 */
declare function createFilesystemMiddleware(options?: FilesystemMiddlewareOptions): langchain0.AgentMiddleware<any, undefined, any>;
//#endregion
//#region src/middleware/subagents.d.ts
/**
 * Type definitions for subagents
 */
interface SubAgent {
  /** The name of the agent */
  name: string;
  /** The description of the agent */
  description: string;
  /** The system prompt to use for the agent */
  systemPrompt: string;
  /** The tools to use for the agent (tool instances, not names). Defaults to defaultTools */
  tools?: StructuredTool[];
  /** The model for the agent. Defaults to default_model */
  model?: LanguageModelLike | string;
  /** Additional middleware to append after default_middleware */
  middleware?: AgentMiddleware$1[];
  /** The tool configs to use for the agent */
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
}
/**
 * Options for creating subagent middleware
 */
interface SubAgentMiddlewareOptions {
  /** The model to use for subagents */
  defaultModel: LanguageModelLike | string;
  /** The tools to use for the default general-purpose subagent */
  defaultTools?: StructuredTool[];
  /** Default middleware to apply to all subagents */
  defaultMiddleware?: AgentMiddleware$1[] | null;
  /** The tool configs for the default general-purpose subagent */
  defaultInterruptOn?: Record<string, boolean | InterruptOnConfig> | null;
  /** A list of additional subagents to provide to the agent */
  subagents?: Array<SubAgent>;
  /** Full system prompt override */
  systemPrompt?: string | null;
  /** Whether to include the general-purpose agent */
  generalPurposeAgent?: boolean;
  /** Custom description for the task tool */
  taskDescription?: string | null;
}
/**
 * Create subagent middleware with task tool
 */
declare function createSubAgentMiddleware(options: SubAgentMiddlewareOptions): AgentMiddleware$1;
//#endregion
//#region src/middleware/patch_tool_calls.d.ts
/**
 * Create middleware that patches dangling tool calls in the messages history.
 *
 * When an AI message contains tool_calls but subsequent messages don't include
 * the corresponding ToolMessage responses, this middleware adds synthetic
 * ToolMessages saying the tool call was cancelled.
 *
 * @returns AgentMiddleware that patches dangling tool calls
 *
 * @example
 * ```typescript
 * import { createAgent } from "langchain";
 * import { createPatchToolCallsMiddleware } from "./middleware/patch_tool_calls";
 *
 * const agent = createAgent({
 *   model: "claude-sonnet-4-5-20250929",
 *   middleware: [createPatchToolCallsMiddleware()],
 * });
 * ```
 */
declare function createPatchToolCallsMiddleware(): AgentMiddleware;
//#endregion
//#region src/backends/state.d.ts
/**
 * Backend that stores files in agent state (ephemeral).
 *
 * Uses LangGraph's state management and checkpointing. Files persist within
 * a conversation thread but not across threads. State is automatically
 * checkpointed after each agent step.
 *
 * Special handling: Since LangGraph state must be updated via Command objects
 * (not direct mutation), operations return filesUpdate in WriteResult/EditResult
 * for the middleware to apply via Command.
 */
declare class StateBackend implements BackendProtocol {
  private stateAndStore;
  constructor(stateAndStore: StateAndStore);
  /**
   * Get files from current state.
   */
  private getFiles;
  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * @param path - Absolute path to directory
   * @returns List of FileInfo objects for files and directories directly in the directory.
   *          Directories have a trailing / in their path and is_dir=true.
   */
  lsInfo(path: string): FileInfo[];
  /**
   * Read file content with line numbers.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed)
   * @param limit - Maximum number of lines to read
   * @returns Formatted file content with line numbers, or error message
   */
  read(filePath: string, offset?: number, limit?: number): string;
  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns Raw file content as FileData
   */
  readRaw(filePath: string): FileData;
  /**
   * Create a new file with content.
   * Returns WriteResult with filesUpdate to update LangGraph state.
   */
  write(filePath: string, content: string): WriteResult;
  /**
   * Edit a file by replacing string occurrences.
   * Returns EditResult with filesUpdate and occurrences.
   */
  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): EditResult;
  /**
   * Structured search results or error string for invalid input.
   */
  grepRaw(pattern: string, path?: string, glob?: string | null): GrepMatch[] | string;
  /**
   * Structured glob matching returning FileInfo objects.
   */
  globInfo(pattern: string, path?: string): FileInfo[];
}
//#endregion
//#region src/backends/store.d.ts
/**
 * Backend that stores files in LangGraph's BaseStore (persistent).
 *
 * Uses LangGraph's Store for persistent, cross-conversation storage.
 * Files are organized via namespaces and persist across all threads.
 *
 * The namespace can include an optional assistant_id for multi-agent isolation.
 */
declare class StoreBackend implements BackendProtocol {
  private stateAndStore;
  constructor(stateAndStore: StateAndStore);
  /**
   * Get the store instance.
   *
   * @returns BaseStore instance
   * @throws Error if no store is available
   */
  private getStore;
  /**
   * Get the namespace for store operations.
   *
   * If an assistant_id is available in stateAndStore, return
   * [assistant_id, "filesystem"] to provide per-assistant isolation.
   * Otherwise return ["filesystem"].
   */
  protected getNamespace(): string[];
  /**
   * Convert a store Item to FileData format.
   *
   * @param storeItem - The store Item containing file data
   * @returns FileData object
   * @throws Error if required fields are missing or have incorrect types
   */
  private convertStoreItemToFileData;
  /**
   * Convert FileData to a value suitable for store.put().
   *
   * @param fileData - The FileData to convert
   * @returns Object with content, created_at, and modified_at fields
   */
  private convertFileDataToStoreValue;
  /**
   * Search store with automatic pagination to retrieve all results.
   *
   * @param store - The store to search
   * @param namespace - Hierarchical path prefix to search within
   * @param options - Optional query, filter, and page_size
   * @returns List of all items matching the search criteria
   */
  private searchStorePaginated;
  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * @param path - Absolute path to directory
   * @returns List of FileInfo objects for files and directories directly in the directory.
   *          Directories have a trailing / in their path and is_dir=true.
   */
  lsInfo(path: string): Promise<FileInfo[]>;
  /**
   * Read file content with line numbers.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed)
   * @param limit - Maximum number of lines to read
   * @returns Formatted file content with line numbers, or error message
   */
  read(filePath: string, offset?: number, limit?: number): Promise<string>;
  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns Raw file content as FileData
   */
  readRaw(filePath: string): Promise<FileData>;
  /**
   * Create a new file with content.
   * Returns WriteResult. External storage sets filesUpdate=null.
   */
  write(filePath: string, content: string): Promise<WriteResult>;
  /**
   * Edit a file by replacing string occurrences.
   * Returns EditResult. External storage sets filesUpdate=null.
   */
  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult>;
  /**
   * Structured search results or error string for invalid input.
   */
  grepRaw(pattern: string, path?: string, glob?: string | null): Promise<GrepMatch[] | string>;
  /**
   * Structured glob matching returning FileInfo objects.
   */
  globInfo(pattern: string, path?: string): Promise<FileInfo[]>;
}
//#endregion
//#region src/backends/filesystem.d.ts
/**
 * Backend that reads and writes files directly from the filesystem.
 *
 * Files are accessed using their actual filesystem paths. Relative paths are
 * resolved relative to the current working directory. Content is read/written
 * as plain text, and metadata (timestamps) are derived from filesystem stats.
 */
declare class FilesystemBackend implements BackendProtocol {
  private cwd;
  private virtualMode;
  private maxFileSizeBytes;
  constructor(options?: {
    rootDir?: string;
    virtualMode?: boolean;
    maxFileSizeMb?: number;
  });
  /**
   * Resolve a file path with security checks.
   *
   * When virtualMode=true, treat incoming paths as virtual absolute paths under
   * this.cwd, disallow traversal (.., ~) and ensure resolved path stays within root.
   * When virtualMode=false, preserve legacy behavior: absolute paths are allowed
   * as-is; relative paths resolve under cwd.
   *
   * @param key - File path (absolute, relative, or virtual when virtualMode=true)
   * @returns Resolved absolute path string
   * @throws Error if path traversal detected or path outside root
   */
  private resolvePath;
  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * @param dirPath - Absolute directory path to list files from
   * @returns List of FileInfo objects for files and directories directly in the directory.
   *          Directories have a trailing / in their path and is_dir=true.
   */
  lsInfo(dirPath: string): Promise<FileInfo[]>;
  /**
   * Read file content with line numbers.
   *
   * @param filePath - Absolute or relative file path
   * @param offset - Line offset to start reading from (0-indexed)
   * @param limit - Maximum number of lines to read
   * @returns Formatted file content with line numbers, or error message
   */
  read(filePath: string, offset?: number, limit?: number): Promise<string>;
  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns Raw file content as FileData
   */
  readRaw(filePath: string): Promise<FileData>;
  /**
   * Create a new file with content.
   * Returns WriteResult. External storage sets filesUpdate=null.
   */
  write(filePath: string, content: string): Promise<WriteResult>;
  /**
   * Edit a file by replacing string occurrences.
   * Returns EditResult. External storage sets filesUpdate=null.
   */
  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult>;
  /**
   * Structured search results or error string for invalid input.
   */
  grepRaw(pattern: string, dirPath?: string, glob?: string | null): Promise<GrepMatch[] | string>;
  /**
   * Try to use ripgrep for fast searching.
   * Returns null if ripgrep is not available or fails.
   */
  private ripgrepSearch;
  /**
   * Fallback regex search implementation.
   */
  private pythonSearch;
  /**
   * Structured glob matching returning FileInfo objects.
   */
  globInfo(pattern: string, searchPath?: string): Promise<FileInfo[]>;
}
//#endregion
//#region src/backends/composite.d.ts
/**
 * Backend that routes file operations to different backends based on path prefix.
 *
 * This enables hybrid storage strategies like:
 * - `/memories/` → StoreBackend (persistent, cross-thread)
 * - Everything else → StateBackend (ephemeral, per-thread)
 *
 * The CompositeBackend handles path prefix stripping/re-adding transparently.
 */
declare class CompositeBackend implements BackendProtocol {
  private default;
  private routes;
  private sortedRoutes;
  constructor(defaultBackend: BackendProtocol, routes: Record<string, BackendProtocol>);
  /**
   * Determine which backend handles this key and strip prefix.
   *
   * @param key - Original file path
   * @returns Tuple of [backend, stripped_key] where stripped_key has the route
   *          prefix removed (but keeps leading slash).
   */
  private getBackendAndKey;
  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * @param path - Absolute path to directory
   * @returns List of FileInfo objects with route prefixes added, for files and directories
   *          directly in the directory. Directories have a trailing / in their path and is_dir=true.
   */
  lsInfo(path: string): Promise<FileInfo[]>;
  /**
   * Read file content, routing to appropriate backend.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed)
   * @param limit - Maximum number of lines to read
   * @returns Formatted file content with line numbers, or error message
   */
  read(filePath: string, offset?: number, limit?: number): Promise<string>;
  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns Raw file content as FileData
   */
  readRaw(filePath: string): Promise<FileData>;
  /**
   * Structured search results or error string for invalid input.
   */
  grepRaw(pattern: string, path?: string, glob?: string | null): Promise<GrepMatch[] | string>;
  /**
   * Structured glob matching returning FileInfo objects.
   */
  globInfo(pattern: string, path?: string): Promise<FileInfo[]>;
  /**
   * Create a new file, routing to appropriate backend.
   *
   * @param filePath - Absolute file path
   * @param content - File content as string
   * @returns WriteResult with path or error
   */
  write(filePath: string, content: string): Promise<WriteResult>;
  /**
   * Edit a file, routing to appropriate backend.
   *
   * @param filePath - Absolute file path
   * @param oldString - String to find and replace
   * @param newString - Replacement string
   * @param replaceAll - If true, replace all occurrences
   * @returns EditResult with path, occurrences, or error
   */
  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult>;
}
//#endregion
//#region src/agent.d.ts
/**
 * Configuration parameters for creating a Deep Agent
 * Matches Python's create_deep_agent parameters
 */
interface CreateDeepAgentParams<ContextSchema extends AnnotationRoot<any> | InteropZodObject = AnnotationRoot<any>> {
  /** The model to use (model name string or LanguageModelLike instance). Defaults to claude-sonnet-4-5-20250929 */
  model?: BaseLanguageModel | string;
  /** Tools the agent should have access to */
  tools?: StructuredTool$1[];
  /** Custom system prompt for the agent. This will be combined with the base agent prompt */
  systemPrompt?: string;
  /** Custom middleware to apply after standard middleware */
  middleware?: AgentMiddleware[];
  /** List of subagent specifications for task delegation */
  subagents?: SubAgent[];
  /** Structured output response format for the agent */
  responseFormat?: any;
  /** Optional schema for context (not persisted between invocations) */
  contextSchema?: ContextSchema;
  /** Optional checkpointer for persisting agent state between runs */
  checkpointer?: BaseCheckpointSaver | boolean;
  /** Optional store for persisting longterm memories */
  store?: BaseStore;
  /**
   * Optional backend for filesystem operations.
   * Can be either a backend instance or a factory function that creates one.
   * The factory receives a config object with state and store.
   */
  backend?: BackendProtocol | ((config: {
    state: unknown;
    store?: BaseStore;
  }) => BackendProtocol);
  /** Optional interrupt configuration mapping tool names to interrupt configs */
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
  /** The name of the agent */
  name?: string;
}
/**
 * Create a Deep Agent with middleware-based architecture.
 *
 * Matches Python's create_deep_agent function, using middleware for all features:
 * - Todo management (todoListMiddleware)
 * - Filesystem tools (createFilesystemMiddleware)
 * - Subagent delegation (createSubAgentMiddleware)
 * - Conversation summarization (summarizationMiddleware)
 * - Prompt caching (anthropicPromptCachingMiddleware)
 * - Tool call patching (createPatchToolCallsMiddleware)
 * - Human-in-the-loop (humanInTheLoopMiddleware) - optional
 *
 * @param params Configuration parameters for the agent
 * @returns ReactAgent instance ready for invocation
 */
declare function createDeepAgent<ContextSchema extends AnnotationRoot<any> | InteropZodObject = AnnotationRoot<any>>(params?: CreateDeepAgentParams<ContextSchema>): ReactAgent<any, any, ContextSchema, any>;
//#endregion
export { type BackendFactory, type BackendProtocol, CompositeBackend, type CreateDeepAgentParams, type EditResult, type FileData, type FileInfo, FilesystemBackend, type FilesystemMiddlewareOptions, type GrepMatch, StateBackend, StoreBackend, type SubAgent, type SubAgentMiddlewareOptions, type WriteResult, createDeepAgent, createFilesystemMiddleware, createPatchToolCallsMiddleware, createSubAgentMiddleware };